/** Explicit live test plugin: run only in a separate DSH profile, never in the operator's Runtime. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Store } from '../../src/app/store.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { MemoryService } from '../../src/app/memory/service.ts'
import { MemoryCapture } from '../../src/app/memory/capture.ts'
import { MemoryDreaming } from '../../src/app/memory/dreaming.ts'
import { MemoryProjection } from '../../src/app/memory/projection.ts'
import { Effects } from '../../src/app/effects.ts'
import { fingerprint } from '../../src/app/memory/security.ts'
import { KV } from '../../src/kv.ts'
import { sessionHistory } from '../../src/app/session-history.ts'

export const name = 'dsh-superagent-memory-smoke'
export const inject = ['llm', 'agents', 'credentials', 'sessions', 'sessionController', 'sessionPersistence']
export async function apply(ctx) {
  const provider = process.env.DSH_MEMORY_SMOKE_PROVIDER, model = process.env.DSH_MEMORY_SMOKE_MODEL
  if (!provider || !model) throw new Error('Set DSH_MEMORY_SMOKE_PROVIDER and DSH_MEMORY_SMOKE_MODEL in an isolated profile')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-memory-live-'))
  await mkdir(join(directory, 'fixture'), { mode: 0o700 })
  const report = { provider, model, directory, calls: [], stages: {}, success: false }
  const store = new Store(join(directory, 'memory.sqlite')), board = new HealthBoard(), lifetime = new AbortController()
  const memory = new MemoryService(store, board.claim('memory')), effects = new Effects(store, board)
  const config = { enabled: true, retrieval: true, autoCapture: true, dreaming: true, dailyCallBudget: 4,
    analyzerModel: { provider, model, reasoningEffort: 'low' } }
  store.saveSettings({ ...store.settings(), memory: config }); memory.configure(store.settings().memory)
  memory.bind('live-smoke:isolated-fixture')
  const agentsBefore = ctx.agents.list().length
  const stream = async function* (options) {
    const call = { tools: options.tools?.length ?? 0, routingId: options.sessionId, mode: 'analysis', usage: null }
    assert.equal(call.tools, 0); assert.match(String(call.routingId), /^memory-/)
    report.calls.push(call)
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type === 'usage') call.usage = chunk.usage
      if (chunk.type === 'finish') { call.finish = chunk.reason.kind; if (chunk.reason.kind === 'error') call.failureCode = chunk.reason.failure.code }
      yield chunk
    }
  }
  const adapter = new (await import('../../src/app/memory/dsh-analyzer.ts')).DshMemoryAnalyzer({ stream }, config.analyzerModel, SessionId(`memory-${fingerprint(directory)}`))
  const host = { store, memory, effects, context: ctx, lifetime: lifetime.signal, analyzer: { propose: async (input, signal) => { const result = await adapter.propose(input, signal); await writeFile(join(directory, input.mode + '-proposals.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); return result } }, paused: () => false }
  const capture = new MemoryCapture(host), dreaming = new MemoryDreaming(host), projection = new MemoryProjection(memory, directory, lifetime.signal)
  const ticketId = `smoke-${fingerprint(directory).slice(0, 12)}`, sessionId = SessionId(`worker-${ticketId}`)
  try {
    // This deterministic Host assertion is actual test evidence, not a model's claim that a test passed.
    await writeFile(join(directory, 'fixture/config.json'), '{"schemaVersion":2}\n', { mode: 0o600 })
    execFileSync(process.execPath, ['-e', 'const a=require("node:assert/strict");a.equal(require("./config.json").schemaVersion,2)'], { cwd: join(directory, 'fixture') })
    const ticket = { id: ticketId, title: 'Isolated Memory fixture', decisionId: 'smoke', mandate: { scope: 'fixture/config.json', policyVersion: 'fixture', strength: 'explicit',
      actor: { source: 'fixture', id: 'local-smoke' }, basis: { via: 'listed' } }, assignments: [{ id: 'assignmentA', state: 'running', createdAt: new Date().toISOString() }],
      origin: { triggerId: 'smoke', triggerIds: ['smoke'] }, channels: [], inputs: [], undelivered: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    store.tickets.save(ticket)
    // A real attached/persisted DSH Session holds synthetic source events. No Agent is created for capture or Dreaming.
    const session = ctx.sessions.create(sessionId, { meta: { cwd: join(directory, 'fixture') } })
    session.append('turn/start', { turn: 1 })
    const source = session.append('user/message', { id: MessageId('fixture-observation'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text:
      'Repository fixture fact, independently checked repeatedly: config.json uses schemaVersion 2. Reuse this fact only for config.json. API_KEY=fixture-never-persist-this-secret' }] }, { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessionPersistence.flush()
    const inspected = await sessionHistory(ctx, sessionId, lifetime.signal)
    assert.deepEqual(inspected.find(event => event.seq === source.seq), source)
    effects.start(); capture.enqueue(ticketId, 'assignmentA', end); await effects.idle('memory-capture')
    const cursor = JSON.parse(String(store.db.prepare('SELECT cursor_json FROM memory_capture_checkpoint').get()?.cursor_json))
    assert.equal(cursor.seq, Number(end.seq)); assert.equal(cursor.partial, false)
    assert.ok(memory.publisher().list('candidate').length > 0); assert.equal(memory.publisher().list('verified').length, 0)
    const callsAfterCapture = report.calls.length
    capture.enqueue(ticketId, 'assignmentA', end); await effects.idle('memory-capture')
    assert.equal(report.calls.length, callsAfterCapture)
    report.stages.capture = { candidates: memory.publisher().list('candidate').length, checkpoint: cursor.seq, replayCalls: 0 }
    session.append('user/message', { id: MessageId('fixture-summary'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted fixture observation' }] },
      { surfaceOp: { op: 'replace', startSeq: source.seq, endSeq: source.seq }, sourceEventSeqs: [source.seq] })
    const snapshot = session.snapshotEvents(), restored = session.constructor.create(sessionId, snapshot, session.header)
    assert.deepEqual(restored.snapshotEvents().find(event => event.seq === source.seq), source)
    await ctx.sessionPersistence.flush()
    assert.deepEqual((await sessionHistory(ctx, sessionId)).find(event => event.seq === source.seq), source)
    report.stages.retention = { compactedSourceRetained: true, restoredSeqRetained: true }
    const fact = { kind: 'fact', title: 'Fixture schemaVersion', body: 'config.json has schemaVersion 2.', scope: { paths: ['config.json'] } }
    const verified = memory.publisher().create(fact, [{ ticketId, sessionId, eventRef: `seq:${source.seq}:${fingerprint(source)}`, kind: 'test',
      excerpt: 'Host executed node assert.equal(config.json.schemaVersion, 2); exit 0.', supportsVerification: true }], 'host-assertion', 'verified')
    memory.configure({ ...config, enabled: false })
    assert.equal((await memory.search({ query: 'schemaVersion', path: 'config.json' })).items.length, 0)
    memory.configure(config)
    assert.ok((await memory.search({ query: 'schemaVersion', path: 'config.json' })).items.some(item => item.id === verified.id))
    report.stages.retrievalAB = { disabledHits: 0, enabledVerifiedHits: 1, modelCalls: 0 }
    assert.equal(dreaming.enqueue(), true); await effects.idle('memory-consolidate')
    assert.equal(effects.pending('memory-consolidate'), false); assert.ok(memory.status().lastConsolidationAt)
    report.stages.dreaming = { published: true, lastConsolidationAt: memory.status().lastConsolidationAt }
    await projection.rebuild()
    const wiki = await readFile(join(directory, 'memory/wiki', verified.id + '.md'), 'utf8')
    assert.ok(wiki.includes('schemaVersion')); assert.ok(!wiki.includes('fixture-never-persist-this-secret'))
    const allNotes = JSON.stringify(memory.publisher().browse({ limit: 100 }))
    assert.ok(!allNotes.includes('fixture-never-persist-this-secret'))
    report.stages.wiki = { rebuilt: true, secretAbsent: true }
    report.newAgents = ctx.agents.list().length - agentsBefore; assert.equal(report.newAgents, 0)
    report.budget = store.get(KV.memory.usage); report.fts5 = memory.publisher().fts
    assert.equal(report.budget.calls, report.calls.length)
    report.success = true
  } catch (error) {
    // No provider response text, transcript or credential is written to this diagnostic.
    report.error = error instanceof Error && /^memory_[a-z_]+$/.test(error.message) ? error.message : 'smoke_assertion_failed'
    report.errorType = error?.name
    report.errorLocation = error?.stack?.split('\n').find(line => line.includes('memory-smoke/index.mjs'))
  } finally {
    lifetime.abort(); await effects.drain(); await projection.idle()
    report.health = memory.status(); store.close()
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log(`Memory smoke report: ${join(directory, 'report.json')}; success=${report.success}`)
  }
}
