import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { MemoryAnalysisInput } from '../src/app/memory/analyzer.ts'
import { MemoryDreaming, publish } from '../src/app/memory/dreaming.ts'
import { Effects } from '../src/app/effects.ts'
import { MemoryConfigSchema } from '../src/policy.ts'
import { fingerprint } from '../src/app/memory/security.ts'
import { exampleEvidence, exampleNote, memoryFixture } from './fixtures/memory.ts'

const audit = { reason: 'Analyzer proposes invalidation; token=must-not-persist', uncertainty: 'The model may be wrong' }
const states = ['missing', 'changed', 'truncated', 'unavailable', 'available', 'host-attested', undefined] as const
const scenarios = states.flatMap(status => ['stale', 'retract', 'update', 'merge'].map(action => ({ status, action })))

it.each(scenarios)('preserves verified knowledge for $action with source state $status and records an idempotent review request', async ({ status, action }) => {
  const f = memoryFixture()
  f.service.configure(MemoryConfigSchema.parse({ enabled: true }))
  const note = f.memory.create(exampleNote, [exampleEvidence], 'verified', 'verified', 'verified')
  const target = action === 'merge' ? f.memory.create(exampleNote, [{ ...exampleEvidence, supportsVerification: false }], 'target', 'candidate', 'target') : undefined
  const before = f.memory.get(note.id)!, offered = [before, ...target ? [f.memory.get(target.id)!] : []]
  const evidenceIds = before.evidence.map(item => item.id)
  const proposal = action === 'merge' ? { action, sourceId: note.id, sourceRevision: 1, targetId: target!.id, targetRevision: 1, ...audit }
    : action === 'update' ? { action, id: note.id, expectedRevision: 1, note: exampleNote, status: 'stale', evidenceIds, ...audit }
    : { action, id: note.id, expectedRevision: 1, evidenceIds, ...audit }
  const checks = status ? offered.flatMap(item => item.evidence.map(evidence => ({ evidenceId: evidence.id, status }))) : undefined
  publish(f.memory, 'unsafe', [proposal], offered, checks)
  const after = f.memory.get(note.id)!
  expect(after.note).toEqual(before.note)
  expect(after.evidence).toEqual(before.evidence)
  expect(after.revisions).toEqual(before.revisions)
  expect(after.pendingReview).toMatchObject({ revision: 1, noteRevision: 1,
    action: action === 'update' ? 'stale' : action, sources: expect.arrayContaining([expect.objectContaining({ status: status ?? 'unavailable' })]) })
  expect(JSON.stringify(after)).not.toContain('must-not-persist')
  expect((await f.service.search({ query: 'SQLite' })).items).toMatchObject([{ id: note.id, reviewRequired: true }])
  expect(f.memory.browse({ status: 'verified' }).items).toMatchObject([{ id: note.id, reviewRequired: true }])
  if (target) expect(f.memory.get(target.id)!.note.revision).toBe(1)
  publish(f.memory, 'different-job-same-request', [proposal], offered, checks)
  expect(f.memory.get(note.id)!.pendingReview).toEqual(after.pendingReview)
})

it.each(['missing', 'changed', 'truncated'] as const)('carries actual resolver state %s into Publisher instead of trusting a hostile analyzer', async status => {
  const f = memoryFixture(), context = new Context(), effects = new Effects(f.store, f.board), lifetime = new AbortController()
  f.store.saveSettings({ ...f.store.settings(), memory: MemoryConfigSchema.parse({ enabled: true, dreaming: true, dailyCallBudget: 2 }) })
  f.service.configure(f.store.settings().memory)
  f.store.tickets.save({ id: 'ticketA', title: 'A', decisionId: 'd', mandate: { scope: 'migration', strength: 'explicit', policyVersion: 'v',
    actor: { source: 'github', id: 'alice' }, basis: { via: 'listed' } }, assignments: [], origin: { triggerId: 't', triggerIds: ['t'] },
    channels: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution: { name: 'fixture', directory: f.directory, assignment: 'a' } })
  const base = Session.create(SessionId('worker-ticketA')), session = Session.create(base.id, [], { ...base.header, cwd: f.directory })
  const source = session.append('user/message', { id: MessageId('source'), role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: status === 'truncated' ? 'Incomplete source '.repeat(1000) : 'Original execution record' }] }, { surfaceOp: 'append' })
  const changed = { ...source, data: { ...source.data, content: [{ type: 'text', text: 'Changed record' }] } }
  context.reflect.provide('sessionController', { inspect: async () => ({ meta: session.header,
    events: status === 'missing' ? [] : status === 'changed' ? [changed] : session.snapshotEvents() }) })
  const note = f.memory.create(exampleNote, [{ ...exampleEvidence, eventRef: `seq:${source.seq}:${fingerprint(source)}` }], 'verified', 'verified')
  const propose = vi.fn(async (input: Readonly<MemoryAnalysisInput>) => [{ action: 'retract', id: note.id, expectedRevision: 1,
    evidenceIds: input.notes[0]!.evidence.map(item => item.id), ...audit }])
  const dreaming = new MemoryDreaming({ store: f.store, memory: f.service, effects, context, lifetime: lifetime.signal, analyzer: { propose }, paused: () => false })
  onTestFinished(async () => { lifetime.abort(); await effects.drain() })
  effects.start(); dreaming.enqueue(); await effects.idle('memory-consolidate')
  expect(propose.mock.calls[0]![0].sourceChecks).toMatchObject([{ status }])
  expect(f.memory.get(note.id)!).toMatchObject({ note: { status: 'verified', revision: 1 }, pendingReview: { sources: [{ status }] } })
  expect(effects.pending('memory-consolidate')).toBe(false)
  expect(f.service.status().usedCalls).toBe(1)
})

it('keeps review requests across evidence-only merges and accepts new counterevidence solely as a review request', () => {
  const f = memoryFixture()
  const a = f.memory.create(exampleNote, [exampleEvidence], 'verified', 'verified')
  const b = f.memory.create({ ...exampleNote, body: 'A new, unverified conflicting observation' }, [{ ...exampleEvidence,
    ticketId: 'ticketB', sessionId: 'worker-ticketB', eventRef: 'seq:4:' + fingerprint('new event'), supportsVerification: false }], 'new')
  const offered = [f.memory.get(a.id)!, f.memory.get(b.id)!]
  publish(f.memory, 'new-observation', [{ action: 'stale', id: a.id, expectedRevision: 1, evidenceIds: offered[1]!.evidence.map(item => item.id), ...audit }],
    offered, offered[1]!.evidence.map(item => ({ evidenceId: item.id, status: 'available' })))
  expect(f.memory.get(a.id)!).toMatchObject({ note: { status: 'verified', revision: 1 }, pendingReview: { sources: [{ noteId: b.id, status: 'available' }] } })
  publish(f.memory, 'evidence-only-change', [{ action: 'create', note: exampleNote, evidenceIds: offered[1]!.evidence.map(item => item.id), ...audit }], offered)
  expect(f.memory.get(a.id)!).toMatchObject({ note: { status: 'verified', revision: 2 }, pendingReview: { revision: 1, noteRevision: 1 } })
})

it.each(['available', 'host-attested'] as const)('permits candidate cleanup only with usable %s source evidence', status => {
  const f = memoryFixture()
  const note = f.memory.create(exampleNote, [{ ...exampleEvidence, supportsVerification: false }], 'candidate')
  const details = f.memory.get(note.id)!
  publish(f.memory, 'cleanup', [{ action: 'retract', id: note.id, expectedRevision: 1, evidenceIds: details.evidence.map(item => item.id), ...audit }],
    [details], details.evidence.map(item => ({ evidenceId: item.id, status })))
  expect(f.memory.get(note.id)!.note.status).toBe('retracted')
})

it('rejects forged analyzer source checks and rolls pending-review writes back with a failed batch', () => {
  const f = memoryFixture(), note = f.memory.create(exampleNote, [exampleEvidence], 'protected', 'verified')
  const before = f.memory.get(note.id)!, proposal = { action: 'retract', id: note.id, expectedRevision: 1,
    evidenceIds: before.evidence.map(item => item.id), ...audit }
  expect(() => publish(f.memory, 'forged-checks', [{ ...proposal, sourceChecks: [{ evidenceId: before.evidence[0]!.id, status: 'available' }] }], [before])).toThrow()
  expect(f.memory.get(note.id)).toEqual(before)
  expect(() => publish(f.memory, 'bad-batch', [proposal, { ...proposal, expectedRevision: 2 }], [before])).toThrow('revision_conflict')
  expect(f.memory.get(note.id)).toEqual(before)
})
