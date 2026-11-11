import { expect, it, onTestFinished, vi } from 'vitest'
import { readFile, rm, symlink, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import type { MemoryAnalysisInput } from '../src/app/memory/analyzer.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { MemoryConfigSchema } from '../src/policy.ts'
import { MemoryProjection } from '../src/app/memory/projection.ts'
import { DshMemoryAnalyzer } from '../src/app/memory/dsh-analyzer.ts'
import { MemoryDreaming, publish } from '../src/app/memory/dreaming.ts'
import { MemoryStore, MemoryConflict } from '../src/app/memory/store.ts'
import { Effects } from '../src/app/effects.ts'
import { analyze } from '../src/app/memory/capture.ts'
import { KV } from '../src/kv.ts'
import { fingerprint } from '../src/app/memory/security.ts'
import { exampleEvidence, exampleNote, memoryFixture } from './fixtures/memory.ts'
import { startRuntime } from './fixtures/host.ts'
import { deferred, waitUntil } from './fixtures/async.ts'

const audit = { reason: 'Checked source evidence', uncertainty: 'Limited to the recorded scope' }
const identity = JSON.stringify(['default', 'github', 'https://github.com', 'acme/widgets'])

it('publishes supported claims only and rejects forged or foreign evidence without partial writes', () => {
  const { memory } = memoryFixture()
  const candidate = memory.create(exampleNote, [{ ...exampleEvidence, supportsVerification: false }], 'unverified')
  const details = memory.get(candidate.id)!
  const promote = { action: 'update', id: candidate.id, expectedRevision: 1, note: exampleNote, status: 'verified', evidenceIds: details.evidence.map(item => item.id), ...audit }
  expect(() => publish(memory, 'unsupported', [promote], [details])).toThrow('verification_required')
  expect(memory.get(candidate.id)!.note.revision).toBe(1)
  expect(() => publish(memory, 'forged', [{ action: 'create', note: exampleNote, evidenceIds: ['invented'], ...audit }], [details])).toThrow('unknown_evidence')
  expect(() => publish(memory, 'foreign', [promote], [{ ...details, note: { ...details.note, repository: 'other' } }])).toThrow(MemoryConflict)
  expect(() => publish(memory, 'tools', [{ ...promote, command: 'run shell', ticketId: 'victim' }], [details])).toThrow()
  expect(memory.list('candidate')).toHaveLength(1)
})

it('CAS rejects stale snapshots and atomically rolls back earlier proposals in the same batch', () => {
  const { memory, store } = memoryFixture()
  const one = memory.create(exampleNote, [exampleEvidence], 'one', 'verified')
  const two = memory.create({ ...exampleNote, title: 'Second claim' }, [exampleEvidence], 'two', 'verified')
  const offered = [memory.get(one.id)!, memory.get(two.id)!]
  memory.update(two.id, 1, { status: 'stale' }, [], 'Code changed', 'human')
  const proposals = offered.map(details => ({ action: 'stale', id: details.note.id, expectedRevision: 1,
    evidenceIds: details.evidence.map(item => item.id), ...audit }))
  expect(() => publish(memory, 'conflict', proposals, offered)).toThrow(MemoryConflict)
  expect(memory.get(one.id)!.note.status).toBe('verified')
  expect(memory.get(one.id)!.pendingReview).toBeUndefined()
  expect(store.get(KV.memory.published(fingerprint('conflict')))).toBeUndefined()
})

it('merges exact duplicates with both provenance chains, refuses contradictions, and deduplicates replay', () => {
  const { memory } = memoryFixture()
  const target = memory.create(exampleNote, [exampleEvidence], 'target', 'verified')
  const source = memory.create(exampleNote, [{ ...exampleEvidence, eventRef: `seq:8:${fingerprint('second event')}`, supportsVerification: false }], 'source')
  const offered = [memory.get(target.id)!, memory.get(source.id)!]
  const merge = { action: 'merge', sourceId: source.id, sourceRevision: 1, targetId: target.id, targetRevision: 1, ...audit }
  publish(memory, 'merge', [merge], offered, offered.flatMap(item => item.evidence.map(source => ({ evidenceId: source.id, status: 'available' }))))
  publish(memory, 'merge', [merge], offered, offered.flatMap(item => item.evidence.map(source => ({ evidenceId: source.id, status: 'available' }))))
  expect(memory.get(target.id)!.note.revision).toBe(2)
  expect(memory.get(target.id)!.evidence).toHaveLength(2)
  expect(memory.get(source.id)!.note.status).toBe('retracted')
  expect(JSON.stringify(memory.get(source.id)!.revisions)).toContain(`Merged into ${target.id}`)
  const wrong = memory.create({ ...exampleNote, body: 'Contradictory procedure' }, [exampleEvidence], 'wrong')
  expect(() => memory.merge(wrong.id, 1, target.id, 2, 'unsafe merge', 'bad')).toThrow('merge_conflict')
  expect(memory.get(target.id)!.note.revision).toBe(2)
})

it('deduplicates creates through existing evidence and requires new attestations to reverify stale claims', () => {
  const { memory } = memoryFixture()
  const first = memory.create(exampleNote, [exampleEvidence], 'first', 'verified')
  const details = memory.get(first.id)!
  publish(memory, 'duplicate', [{ action: 'create', note: exampleNote, evidenceIds: details.evidence.map(item => item.id), ...audit }], [details])
  expect(memory.list()).toHaveLength(1)
  expect(memory.get(first.id)!.note.revision).toBe(1)
  memory.update(first.id, 1, { status: 'stale' }, [], 'Environment changed', 'human')
  expect(() => memory.update(first.id, 2, { status: 'verified' }, details.evidence.map(item => item.id), 'Old evidence', 'old')).toThrow('verification_required')
  expect(memory.search({ query: 'SQLite' })).toEqual([])
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 1000 })
  try {
    const fresh = memory.create(exampleNote, [{ ...exampleEvidence, eventRef: `seq:9:${fingerprint('fresh test')}` }], 'fresh-proof', 'verified')
    memory.merge(fresh.id, 1, first.id, 2, 'Same claim tested after invalidation', 'fresh')
    const after = memory.get(first.id)!
    const verified = memory.update(first.id, after.note.revision, { status: 'verified' }, after.evidence.map(item => item.id), 'Fresh proof', 'verified')
    expect(verified.status).toBe('verified')
    expect(memory.search({ query: 'SQLite' })).toHaveLength(1)
  } finally { vi.useRealTimers() }
})

it('cannot launder stale attestations into a candidate through merge or duplicate publication', () => {
  const { memory } = memoryFixture()
  const old = memory.create(exampleNote, [exampleEvidence], 'old-proof', 'verified')
  memory.update(old.id, 1, { status: 'stale' }, [], 'The evidence is invalid for the changed environment', 'invalidate')
  const candidate = memory.create(exampleNote, [{ ...exampleEvidence, eventRef: `seq:8:${fingerprint('new observation')}`, supportsVerification: false }], 'candidate')
  const stale = memory.get(old.id)!, before = memory.get(candidate.id)!
  expect(() => memory.merge(old.id, 2, candidate.id, 1, 'Duplicate', 'launder')).toThrow('invalidated_evidence')
  expect(() => publish(memory, 'launder-create', [{ action: 'create', note: exampleNote,
    evidenceIds: stale.evidence.map(item => item.id), ...audit }], [stale, before])).toThrow('invalidated_evidence')
  expect(memory.get(candidate.id)).toEqual(before)
  expect(memory.get(old.id)).toEqual(stale)
  expect(() => memory.update(candidate.id, 1, { status: 'verified' }, before.evidence.map(item => item.id), 'Old proof', 'promote')).toThrow('verification_required')
  expect(memory.search({ query: 'SQLite' })).toEqual([])
})

it('rebuilds private projections and a damaged FTS index, preserving redaction and invalidation', async () => {
  const { directory, memory, service, store } = memoryFixture()
  service.configure(MemoryConfigSchema.parse({ enabled: true }))
  const projection = new MemoryProjection(service, directory, new AbortController().signal)
  const note = memory.create({ ...exampleNote, body: 'SQLite token=private-value person@example.com' }, [exampleEvidence], 'secret', 'verified', 'safe-id')
  await projection.idle()
  const file = join(directory, 'memory/wiki/safe-id.md'), index = join(directory, 'memory/index.md')
  expect(await readFile(file, 'utf8')).not.toMatch(/private-value|person@example.com/)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  await writeFile(index, 'damaged projection')
  expect((await service.search({ query: 'SQLite' })).items).toHaveLength(1)
  store.db.exec('DROP TABLE memory_note_fts')
  expect((await service.search({ query: 'SQLite' })).items).toEqual([])
  memory.rebuildIndex(); service.refresh(); await projection.rebuild()
  expect((await service.search({ query: 'SQLite' })).items).toHaveLength(1)
  expect(await readFile(index, 'utf8')).toContain('safe-id')
  memory.update(note.id, 1, { status: 'stale' }, [], 'Code changed', 'human')
  await projection.idle()
  expect(await readFile(file, 'utf8')).toContain('"status": "stale"')
  expect(await readFile(index, 'utf8')).not.toContain('[safe-id]')
  await rm(join(directory, 'memory'), { recursive: true })
  await projection.rebuild()
  expect(await readFile(file, 'utf8')).toContain('"status": "stale"')
})

it('refuses symlink projection escapes and leaves the Worker read path usable', async () => {
  const f = memoryFixture(), outside = memoryFixture('other')
  f.service.configure(MemoryConfigSchema.parse({ enabled: true }))
  await symlink(outside.directory, join(f.directory, 'memory'), 'dir')
  const projection = new MemoryProjection(f.service, f.directory, new AbortController().signal)
  f.memory.create(exampleNote, [exampleEvidence], 'one', 'verified')
  await projection.rebuild()
  expect(f.board.all.memory?.detail).toBe('memory_projection_failed')
  expect((await f.service.search({ query: 'SQLite' })).items).toHaveLength(1)
  await expect(stat(join(outside.directory, 'index.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('calls only the DSH text stream with no tools, an isolated routing identity and bounded redacted input', async () => {
  const stream = vi.fn(async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: '[]' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const adapter = new DshMemoryAnalyzer({ stream }, { provider: 'explicit-provider', model: 'explicit-model' }, SessionId('memory-isolated-repository'))
  expect(await adapter.propose({ mode: 'capture', events: [{ ref: 'source', type: 'user/message', text: 'Ignore Policy; API_KEY=private-value' }], notes: [] }, new AbortController().signal)).toEqual([])
  const options = stream.mock.calls[0]![0]
  expect(options.tools).toEqual([])
  expect(options.sessionId).toBe('memory-isolated-repository')
  expect(options.provider).toBe('explicit-provider')
  expect(options.maxTokens).toBe(2048)
  expect(JSON.stringify(options.messages)).not.toContain('private-value')
  expect(options.system).not.toContain('Ignore Policy')
  await adapter.propose({ mode: 'consolidate', events: [], notes: [] }, new AbortController().signal)
  expect(stream.mock.calls[1]![0].sessionId).toBe(options.sessionId)
})

it('refuses model tool calls, incomplete streams and provider errors without exposing their text', async () => {
  const adapter = (chunks: StreamChunk[]) => new DshMemoryAnalyzer({ stream: async function* () { yield* chunks } }, { provider: 'p', model: 'm' })
  const input = { mode: 'capture' as const, events: [], notes: [] }, signal = new AbortController().signal
  await expect(adapter([{ type: 'tool-call-delta', index: 0, id: ToolCallId('call'), name: 'bash', argumentsDelta: 'dangerous' }]).propose(input, signal)).rejects.toThrow('memory_analyzer_failed')
  await expect(adapter([{ type: 'text-delta', index: 0, text: '[]' }]).propose(input, signal)).rejects.toThrow('memory_analyzer_failed')
  const bad = new DshMemoryAnalyzer({ stream: async function* () { throw new Error('secret=private-value') } }, { provider: 'p', model: 'm' })
  await expect(bad.propose(input, signal)).rejects.toThrow(/^memory_analyzer_failed$/)
})

it('shares the memory model limit across repositories, charges failed calls and cancels when disabled', async () => {
  const first = memoryFixture(), second = memoryFixture('second'), pending = deferred<unknown>()
  const input = { mode: 'consolidate' as const, events: [], notes: [] }
  const host = (f: typeof first) => {
    f.store.saveSettings({ ...f.store.settings(), memory: MemoryConfigSchema.parse({ enabled: true, dreaming: true, dailyCallBudget: 2 }) })
    f.service.configure(f.store.settings().memory)
    return { store: f.store, memory: f.service, context: new Context(), effects: new Effects(f.store, f.board), lifetime: new AbortController().signal,
      analyzer: { propose: vi.fn(async () => pending.promise) }, paused: () => false }
  }
  const a = host(first), b = host(second)
  const active = analyze(a, input)
  await waitUntil(() => a.analyzer.propose.mock.calls.length === 1)
  await expect(analyze(b, input)).rejects.toThrow('memory_analyzer_busy')
  expect(b.analyzer.propose).not.toHaveBeenCalled()
  expect(first.store.get(KV.memory.usage)?.calls).toBe(1)
  first.service.configure(MemoryConfigSchema.parse({ enabled: false }))
  await expect(active).rejects.toThrow('memory_operation_aborted')
  pending.resolve([])
  await vi.waitFor(async () => { expect(await analyze(b, input)).toEqual([]) })
  expect(second.store.get(KV.memory.usage)?.calls).toBe(1)
})

it('retries a consolidation CAS conflict against a fresh snapshot and keeps the job durable', async () => {
  const f = memoryFixture(), pending = deferred<unknown>()
  f.store.saveSettings({ ...f.store.settings(), memory: MemoryConfigSchema.parse({ enabled: true, dreaming: true, dailyCallBudget: 3 }) })
  f.service.configure(f.store.settings().memory)
  const note = f.memory.create(exampleNote, [exampleEvidence], 'source', 'verified')
  const details = f.memory.get(note.id)!, effects = new Effects(f.store, f.board)
  const propose = vi.fn(async () => pending.promise)
  const lifetime = new AbortController()
  const dreaming = new MemoryDreaming({ store: f.store, memory: f.service, effects, context: new Context(), lifetime: lifetime.signal,
    analyzer: { propose }, paused: () => false })
  onTestFinished(async () => { lifetime.abort(); await effects.drain() })
  dreaming.enqueue(); effects.start()
  const active = effects.idle('memory-consolidate')
  await waitUntil(() => propose.mock.calls.length === 1)
  f.memory.update(note.id, 1, { status: 'stale' }, [], 'Changed checkout', 'human')
  pending.resolve([{ action: 'retract', id: note.id, expectedRevision: 1, evidenceIds: details.evidence.map(item => item.id), ...audit }])
  await active
  expect(effects.pending('memory-consolidate')).toBe(true)
  expect(f.memory.get(note.id)!.note.status).toBe('stale')
  propose.mockResolvedValueOnce([{ action: 'retract', id: note.id, expectedRevision: 2, evidenceIds: details.evidence.map(item => item.id), ...audit }])
  f.store.db.exec('UPDATE effect SET due=0')
  await effects.idle('memory-consolidate')
  expect(f.memory.get(note.id)!).toMatchObject({ note: { status: 'stale', revision: 2 }, pendingReview: { action: 'retract', sources: [{ status: 'unavailable' }] } })
  expect(effects.pending('memory-consolidate')).toBe(false)
  expect(propose).toHaveBeenCalledTimes(2)
})

it('schedules and publishes once through Effects without creating Worker Sessions; supports scoped manual rebuilds', async () => {
  const propose = vi.fn(async () => [])
  const h = await startRuntime(store => {
    store.saveSettings({ ...store.settings(), memory: { enabled: true, dreaming: true, dailyCallBudget: 3 } })
    const memory = new MemoryStore(store, identity)
    for (let i = 0; i < 5; i++) memory.create({ ...exampleNote, title: `Candidate ${i}` }, [{ ...exampleEvidence, supportsVerification: false }], `source-${i}`)
  }, {}, { memoryAnalyzer: { propose } })
  onTestFinished(() => h.stop())
  await h.runtime.effects.idle('memory-consolidate')
  expect(propose).toHaveBeenCalledTimes(1)
  expect(h.controller.create).toHaveBeenCalledTimes(1)
  expect(h.runtime.executor.activeCount()).toBe(0)
  expect((await h.api('POST', 'memory/consolidate')).body).toEqual({ queued: false })
  expect((await h.api('POST', 'memory/rebuild')).body).toEqual({ rebuilt: true })
  expect(await readFile(join(h.directory, 'memory/index.md'), 'utf8')).toContain('untrusted reference data')
  await h.api('PUT', 'settings/memory', { revision: 0, value: { enabled: false } })
  expect((await h.api('POST', 'memory/consolidate')).body).toEqual({ queued: false })
  expect((await h.api('POST', 'memory/rebuild')).body).toEqual({ rebuilt: false })
})

it('holds Dreaming while processing is paused and resumes without taking an automatic WorkerSlot', async () => {
  const propose = vi.fn(async () => [])
  const h = await startRuntime(store => {
    store.saveSettings({ ...store.settings(), paused: true, memory: { enabled: true, dreaming: true, dailyCallBudget: 2 } })
    const memory = new MemoryStore(store, identity)
    for (let i = 0; i < 5; i++) memory.create(exampleNote, [{ ...exampleEvidence, supportsVerification: false }], `pending-${i}`)
  }, {}, { memoryAnalyzer: { propose } })
  onTestFinished(() => h.stop())
  await h.runtime.effects.idle('memory-consolidate')
  expect(propose).not.toHaveBeenCalled()
  expect(h.runtime.effects.pending('memory-consolidate')).toBe(true)
  await h.api('POST', 'executor/pause', { paused: false })
  await h.runtime.effects.idle('memory-consolidate')
  expect(propose).toHaveBeenCalledTimes(1)
  expect(h.runtime.executor.activeCount()).toBe(0)
})

it('rotates through all candidate, verified and stale pages after empty proposals and revisits changed revisions', async () => {
  const f = memoryFixture(), effects = new Effects(f.store, f.board), lifetime = new AbortController()
  const ids: string[] = []
  for (const [status, count] of [['candidate', 27], ['verified', 13], ['stale', 12]] as const) {
    for (let index = 0; index < count; index++) {
      const id = `${status}-${String(index).padStart(2, '0')}`
      const note = f.memory.create({ ...exampleNote, title: id }, [exampleEvidence], id, status === 'candidate' ? 'candidate' : 'verified', id)
      if (status === 'stale') f.memory.update(note.id, 1, { status: 'stale' }, [], 'Changed environment', 'host')
      ids.push(id)
    }
  }
  f.store.saveSettings({ ...f.store.settings(), memory: MemoryConfigSchema.parse({ enabled: true, dreaming: true, dailyCallBudget: 20 }) })
  f.service.configure(f.store.settings().memory)
  const propose = vi.fn(async (_input: Readonly<MemoryAnalysisInput>) => [])
  const dreaming = new MemoryDreaming({ store: f.store, memory: f.service, effects, context: new Context(), lifetime: lifetime.signal,
    analyzer: { propose }, paused: () => false })
  onTestFinished(async () => { lifetime.abort(); await effects.drain() })
  dreaming.enqueue(); effects.start(); await effects.idle('memory-consolidate')
  const seen = propose.mock.calls.flatMap(([input]) => input.notes.map(details => details.note.id))
  expect(seen.sort()).toEqual(ids.sort())
  expect(dreaming.enqueue()).toBe(false)
  const changed = f.memory.get('candidate-00')!.note
  f.memory.update(changed.id, changed.revision, { body: 'Updated evidence needs another review' }, [], 'New finding', 'host')
  await effects.idle('memory-consolidate')
  expect(propose.mock.calls.at(-1)![0].notes).toMatchObject([{ note: { id: changed.id, revision: changed.revision + 1 } }])
})

it('lets manual consolidation reach later pages and preserves review progress across dispatcher restart', async () => {
  const f = memoryFixture(), effects = new Effects(f.store, f.board), lifetime = new AbortController()
  for (let index = 0; index < 12; index++) f.memory.create({ ...exampleNote, title: `Note ${index}` }, [exampleEvidence], `manual-${index}`, 'verified')
  f.store.saveSettings({ ...f.store.settings(), memory: MemoryConfigSchema.parse({ enabled: true, dreaming: true, dailyCallBudget: 10 }) })
  f.service.configure(f.store.settings().memory)
  const propose = vi.fn(async (_input: Readonly<MemoryAnalysisInput>) => [])
  const host = { store: f.store, memory: f.service, effects, context: new Context(), lifetime: lifetime.signal, analyzer: { propose }, paused: () => false }
  const dreaming = new MemoryDreaming(host)
  effects.start()
  expect(dreaming.enqueue()).toBe(true); await effects.idle('memory-consolidate')
  await effects.drain()
  const restarted = new Effects(f.store, new HealthBoard()), resumed = new MemoryDreaming({ ...host, effects: restarted })
  onTestFinished(async () => { lifetime.abort(); await restarted.drain() })
  restarted.start()
  expect(resumed.enqueue()).toBe(true); await restarted.idle('memory-consolidate')
  expect(resumed.enqueue()).toBe(true); await restarted.idle('memory-consolidate')
  expect(resumed.enqueue()).toBe(false)
  expect(new Set(propose.mock.calls.flatMap(([input]) => input.notes.map(details => details.note.id))).size).toBe(12)
})

it('rolls back proposals and review progress together when a review checkpoint cannot be persisted', async () => {
  const f = memoryFixture(), effects = new Effects(f.store, f.board), lifetime = new AbortController()
  const note = f.memory.create(exampleNote, [exampleEvidence], 'atomic-review', 'verified')
  f.store.saveSettings({ ...f.store.settings(), memory: MemoryConfigSchema.parse({ enabled: true, dreaming: true, dailyCallBudget: 3 }) })
  f.service.configure(f.store.settings().memory)
  const propose = vi.fn(async (input: Readonly<MemoryAnalysisInput>) => [{ action: 'stale', id: note.id, expectedRevision: 1,
    evidenceIds: input.notes[0]!.evidence.map(item => item.id), ...audit }])
  const dreaming = new MemoryDreaming({ store: f.store, memory: f.service, effects, context: new Context(), lifetime: lifetime.signal,
    analyzer: { propose }, paused: () => false })
  onTestFinished(async () => { lifetime.abort(); await effects.drain() })
  f.store.db.prepare(`CREATE TRIGGER reject_review BEFORE INSERT ON kv WHEN NEW.key LIKE '${KV.memory.reviewed.prefix}%' BEGIN SELECT RAISE(ABORT,'review unavailable'); END`).run()
  dreaming.enqueue(); effects.start(); await effects.idle('memory-consolidate')
  expect(f.memory.get(note.id)!.note).toMatchObject({ status: 'verified', revision: 1 })
  expect(f.memory.get(note.id)!.pendingReview).toBeUndefined()
  expect(f.store.get(KV.memory.reviewed(note.id))).toBeUndefined()
  expect(f.store.keys(KV.memory.published)).toEqual([])
  expect(effects.pending('memory-consolidate')).toBe(true)
  f.store.db.exec('DROP TRIGGER reject_review; UPDATE effect SET due=0')
  await effects.idle('memory-consolidate')
  expect(f.memory.get(note.id)!).toMatchObject({ note: { status: 'verified', revision: 1 }, pendingReview: { revision: 1, action: 'stale' } })
  expect(f.store.get(KV.memory.reviewed(note.id))).toMatchObject({ revision: 1 })
  expect(f.memory.reviewable('verified', 5)).toEqual([])
  expect(propose).toHaveBeenCalledTimes(2)
  expect(effects.pending('memory-consolidate')).toBe(false)
})

it('bounds a non-cooperative analyzer with the configured deadline and retains its global reservation until completion', async () => {
  const f = memoryFixture(), timeout = new AbortController(), pending = deferred<unknown>()
  f.store.saveSettings({ ...f.store.settings(), memory: MemoryConfigSchema.parse({ enabled: true, dreaming: true, dailyCallBudget: 2 }) })
  f.service.configure(f.store.settings().memory)
  const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
  const propose = vi.fn(async () => pending.promise)
  const host = { store: f.store, memory: f.service, context: new Context(), effects: new Effects(f.store, f.board),
    lifetime: new AbortController().signal, analyzer: { propose }, paused: () => false }
  const input = { mode: 'consolidate' as const, events: [], notes: [] }
  try {
    const active = analyze(host, input)
    await waitUntil(() => propose.mock.calls.length === 1)
    expect(deadline).toHaveBeenCalledWith(15_000)
    timeout.abort()
    await expect(active).rejects.toThrow('memory_operation_aborted')
    await expect(analyze(host, input)).rejects.toThrow('memory_analyzer_busy')
    pending.resolve([])
    await vi.waitFor(async () => { await expect(analyze(host, input)).rejects.toThrow('memory_analysis_paused') })
    expect(f.store.get(KV.memory.usage)?.calls).toBe(1)
  } finally { pending.resolve([]); deadline.mockRestore() }
})

it('reviews small backlogs on a timer and stops scheduling when Memory is disabled or the Runtime shuts down', async () => {
  const f = memoryFixture(), effects = new Effects(f.store, f.board), lifetime = new AbortController()
  const config = MemoryConfigSchema.parse({ enabled: true, dreaming: true, dailyCallBudget: 3 })
  f.store.saveSettings({ ...f.store.settings(), memory: config }); f.service.configure(config)
  f.memory.create(exampleNote, [exampleEvidence], 'periodic', 'verified')
  const propose = vi.fn(async () => [])
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    new MemoryDreaming({ store: f.store, memory: f.service, effects, context: new Context(), lifetime: lifetime.signal,
      analyzer: { propose }, paused: () => false })
    effects.start()
    await effects.idle('memory-consolidate')
    expect(propose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15 * 60_000); await effects.idle('memory-consolidate')
    expect(propose).toHaveBeenCalledTimes(1)
    expect(f.service.status().lastConsolidationAt).toEqual(expect.any(String))
    f.service.configure({ ...config, enabled: false })
    f.memory.create({ ...exampleNote, title: 'Later observation' }, [exampleEvidence], 'disabled', 'candidate')
    await vi.advanceTimersByTimeAsync(30 * 60_000); await effects.idle('memory-consolidate')
    expect(propose).toHaveBeenCalledTimes(1)
    f.service.configure(config)
    await vi.advanceTimersByTimeAsync(15 * 60_000); await effects.idle('memory-consolidate')
    expect(propose).toHaveBeenCalledTimes(2)
    lifetime.abort()
    f.memory.create({ ...exampleNote, title: 'After shutdown' }, [exampleEvidence], 'after-shutdown', 'candidate')
    await vi.advanceTimersByTimeAsync(30 * 60_000); await effects.idle('memory-consolidate')
    expect(propose).toHaveBeenCalledTimes(2)
  } finally { lifetime.abort(); await effects.drain(); vi.useRealTimers() }
})

it.each(['duplicate', 'contradiction'])('compares a new %s with unchanged history reviewed in an earlier round', async mode => {
  const f = memoryFixture(), effects = new Effects(f.store, f.board), lifetime = new AbortController()
  const config = MemoryConfigSchema.parse({ enabled: true, dreaming: true, dailyCallBudget: 5 })
  f.store.saveSettings({ ...f.store.settings(), memory: config }); f.service.configure(config)
  const context = new Context(), histories = new Map<string, Session>()
  context.reflect.provide('sessionController', { inspect: async (id: string) => {
    const session = histories.get(id)
    if (!session) throw new Error('Missing fixture source')
    return { meta: session.header, events: session.snapshotEvents() }
  } })
  const sourceFor = (ticketId: string, body: string) => {
    f.store.tickets.save({ id: ticketId, title: ticketId, decisionId: 'd', mandate: { scope: 'migration', strength: 'explicit', policyVersion: 'v',
      actor: { source: 'github', id: 'alice' }, basis: { via: 'listed' } }, assignments: [], origin: { triggerId: 't', triggerIds: ['t'] },
      channels: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution: { name: 'fixture', directory: f.directory, assignment: 'a' } })
    const base = Session.create(SessionId('worker-' + ticketId)), session = Session.create(base.id, [], { ...base.header, cwd: f.directory })
    const event = session.append('user/message', { id: MessageId(ticketId), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: body }] }, { surfaceOp: 'append' })
    histories.set(String(session.id), session)
    return { ...exampleEvidence, ticketId, sessionId: String(session.id), eventRef: 'seq:' + event.seq + ':' + fingerprint(event) }
  }
  const a = f.memory.create(exampleNote, [sourceFor('ticketA', exampleNote.body)], 'ticketA', 'verified', 'history-a')
  let rounds = 0
  const propose = vi.fn(async (input: Readonly<MemoryAnalysisInput>) => {
    if (++rounds === 1) return []
    const old = input.relatedNotes?.find(item => item.note.id === a.id), next = input.notes.find(item => item.note.id === 'new-b')
    if (!old || !next) return []
    return mode === 'duplicate' ? [{ action: 'merge', sourceId: next.note.id, sourceRevision: next.note.revision,
      targetId: old.note.id, targetRevision: old.note.revision, ...audit }] : [{ action: 'stale', id: old.note.id,
      expectedRevision: old.note.revision, evidenceIds: old.evidence.map(item => item.id), ...audit }]
  })
  const dreaming = new MemoryDreaming({ store: f.store, memory: f.service, effects, context, lifetime: lifetime.signal,
    analyzer: { propose }, paused: () => false })
  onTestFinished(async () => { lifetime.abort(); await effects.drain() })
  effects.start(); dreaming.enqueue(); await effects.idle('memory-consolidate')
  // The later candidate must still receive history comparison beyond the first five primaries.
  for (let index = 0; index < 6; index++) f.memory.create({ ...exampleNote, title: `Unrelated observation ${index}`, body: `Independent fixture ${index}`,
    scope: { paths: [`unrelated-${index}.txt`] } }, [{ ...exampleEvidence, supportsVerification: false }], `filler-${index}`, 'candidate', `filler-${index}`)
  f.memory.create(mode === 'duplicate' ? exampleNote : { ...exampleNote, body: 'The old migration workflow fails with the new API.' },
    [{ ...sourceFor('ticketB', 'New execution observation'), supportsVerification: false }], 'ticketB', 'candidate', 'new-b')
  dreaming.enqueue(); await effects.idle('memory-consolidate')
  expect(propose.mock.calls[1]![0].relatedNotes).toEqual(expect.arrayContaining([expect.objectContaining({ note: expect.objectContaining({ id: a.id }) })]))
  expect(f.memory.get(a.id)!.note.status).toBe('verified')
  if (mode === 'contradiction') expect(f.memory.get(a.id)!.pendingReview).toMatchObject({ action: 'stale', sources: [{ status: 'available' }] })
  expect(f.memory.get('new-b')!.note.status).toBe(mode === 'duplicate' ? 'retracted' : 'candidate')
})

it('flags misleading summaries for review using the original Transcript without automatically invalidating verified knowledge', async () => {
  const f = memoryFixture(), effects = new Effects(f.store, f.board), lifetime = new AbortController(), context = new Context()
  const config = MemoryConfigSchema.parse({ enabled: true, dreaming: true, dailyCallBudget: 2 })
  f.store.saveSettings({ ...f.store.settings(), memory: config }); f.service.configure(config)
  f.store.tickets.save({ id: 'ticketA', title: 'A', decisionId: 'd', mandate: { scope: 'migration', strength: 'explicit', policyVersion: 'v',
    actor: { source: 'github', id: 'alice' }, basis: { via: 'listed' } }, assignments: [], origin: { triggerId: 't', triggerIds: ['t'] },
    channels: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution: { name: 'fixture', directory: f.directory, assignment: 'a' } })
  const base = Session.create(SessionId('worker-ticketA')), session = Session.create(base.id, [], { ...base.header, cwd: f.directory })
  session.append('turn/start', { turn: 1 })
  const source = session.append('user/message', { id: MessageId('log'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text',
    text: 'Progress output. '.repeat(80) + 'ACTUAL_FAILURE: migration rolled back. API_KEY=private-resolver-secret' }] }, { surfaceOp: 'append' })
  session.append('user/message', { id: MessageId('context'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'The old procedure must be revisited.' }] }, { surfaceOp: 'append' })
  const inspect = vi.fn(async () => ({ meta: session.header, events: session.snapshotEvents() }))
  context.reflect.provide('sessionController', { inspect })
  const note = f.memory.create(exampleNote, [{ ...exampleEvidence, eventRef: `seq:${source.seq}:${fingerprint(source)}`, excerpt: 'The migration checks passed.' }], 'misleading', 'verified')
  const propose = vi.fn(async (input: Readonly<MemoryAnalysisInput>) => input.events.some(item => item.text.includes('ACTUAL_FAILURE'))
    ? [{ action: 'stale', id: note.id, expectedRevision: 1, evidenceIds: input.notes[0]!.evidence.map(item => item.id), ...audit }] : [])
  const dreaming = new MemoryDreaming({ store: f.store, memory: f.service, effects, context, lifetime: lifetime.signal, analyzer: { propose }, paused: () => false })
  onTestFinished(async () => { lifetime.abort(); await effects.drain() })
  effects.start(); dreaming.enqueue(); await effects.idle('memory-consolidate')
  expect(f.memory.get(note.id)!).toMatchObject({ note: { status: 'verified', revision: 1 }, pendingReview: { action: 'stale', sources: [{ status: 'available' }] } })
  expect(inspect).toHaveBeenCalledOnce()
  const offered = propose.mock.calls[0]![0]
  expect(offered.events.some(item => item.text.includes('old procedure'))).toBe(true)
  expect(JSON.stringify(offered)).not.toContain('private-resolver-secret')
})
