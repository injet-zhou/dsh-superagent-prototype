import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MemoryCapture } from '../src/app/memory/capture.ts'
import { MemoryConfigSchema } from '../src/policy.ts'
import { Effects } from '../src/app/effects.ts'
import type { MemoryAnalysisInput, MemoryAnalyzer } from '../src/app/memory/analyzer.ts'
import type { Ticket } from '../src/core/index.ts'
import { exampleNote, memoryFixture } from './fixtures/memory.ts'
import { startRuntime, feishu } from './fixtures/host.ts'
import { waitUntil, deferred } from './fixtures/async.ts'
import { fingerprint } from '../src/app/memory/security.ts'

function turn(session: Session, number: number, text = 'Migration regression command passed on this checkout') {
  session.append('turn/start', { turn: number })
  session.append('user/message', { id: MessageId(`message-${number}`), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, { surfaceOp: 'append' })
  return session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
}
const proposal = (input: Readonly<MemoryAnalysisInput>) => input.events.slice(0, 1).map(event => ({ action: 'create', note: exampleNote,
  evidenceRefs: [event.ref], reason: 'Potentially reusable workflow', uncertainty: 'Not independently verified' }))
function captureFixture(analyzer: MemoryAnalyzer = { propose: async input => proposal(input) }) {
  const f = memoryFixture()
  f.store.saveSettings({ ...f.store.settings(), memory: MemoryConfigSchema.parse({ enabled: true, autoCapture: true, dailyCallBudget: 20 }) })
  f.service.configure(f.store.settings().memory)
  const context = new Context(), lifetime = new AbortController(), effects = new Effects(f.store, f.board)
  const session = Session.create(SessionId('worker-ticketA'))
  const ticket: Ticket = { id: 'ticketA', title: 'A', decisionId: 'decision', mandate: { scope: 'migration', policyVersion: 'v1', strength: 'explicit',
    actor: { source: 'github', id: 'alice' }, basis: { via: 'listed' } }, assignments: [{ id: 'assignmentA', state: 'running', createdAt: '' }],
    origin: { triggerId: 'triggerA', triggerIds: ['triggerA'] }, channels: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '' }
  f.store.tickets.save(ticket)
  const inspect = vi.fn(async () => ({ events: session.snapshotEvents() }))
  context.reflect.provide('sessionController', { inspect })
  context.reflect.provide('sessionPersistence', { flush: vi.fn(async () => {}) })
  const host = { store: f.store, memory: f.service, effects, context, lifetime: lifetime.signal, analyzer, paused: () => false }
  const capture = new MemoryCapture(host)
  effects.start()
  onTestFinished(async () => { lifetime.abort(); await effects.drain() })
  const cursor = () => JSON.parse(String(f.store.db.prepare('SELECT cursor_json FROM memory_capture_checkpoint').get()?.cursor_json ?? 'null')) as { seq: number; partial: boolean } | null
  return { ...f, host, context, effects, session, inspect, capture, cursor, lifetime }
}

it('deduplicates repeated effects, keeps identical text at distinct events, and commits source checkpoints', async () => {
  const f = captureFixture()
  const first = turn(f.session, 1)
  f.capture.enqueue('ticketA', 'assignmentA', first); f.capture.enqueue('ticketA', 'assignmentA', first)
  await f.effects.idle('memory-capture')
  expect(f.memory.list('candidate')).toHaveLength(1)
  expect(f.cursor()).toEqual({ seq: Number(first.seq), hash: fingerprint(first), partial: false })
  f.capture.enqueue('ticketA', 'assignmentA', first)
  const second = turn(f.session, 2)
  f.capture.enqueue('ticketA', 'assignmentA', second)
  expect(f.store.db.prepare("SELECT count(*) AS n FROM effect WHERE kind='memory-capture'").get()?.n).toBe(2)
  await f.effects.idle('memory-capture')
  const notes = f.memory.list('candidate')
  expect(notes).toHaveLength(2)
  expect(new Set(notes.map(note => f.memory.get(note.id)!.evidence[0]!.eventRef)).size).toBe(2)
  expect(f.memory.list()).toEqual([])
})

it('rolls back candidates and evidence when checkpoint publication fails, then retries exactly once', async () => {
  const f = captureFixture()
  f.store.db.exec("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON memory_capture_checkpoint BEGIN SELECT RAISE(ABORT,'checkpoint unavailable'); END")
  const end = turn(f.session, 1)
  f.capture.enqueue('ticketA', 'assignmentA', end)
  await f.effects.idle('memory-capture')
  expect(f.memory.list('candidate')).toEqual([])
  expect(f.cursor()).toBeNull()
  expect(f.effects.pending('memory-capture')).toBe(true)
  f.store.db.exec('DROP TRIGGER reject_checkpoint; UPDATE effect SET due=0')
  await f.effects.idle('memory-capture')
  expect(f.memory.list('candidate')).toHaveLength(1)
  expect(f.cursor()?.seq).toBe(Number(end.seq))
})

it('records partial_capture without advancing when history disappears or an anchor changes', async () => {
  const f = captureFixture()
  const first = turn(f.session, 1)
  f.capture.enqueue('ticketA', 'assignmentA', first); await f.effects.idle('memory-capture')
  const second = turn(f.session, 2)
  f.inspect.mockResolvedValue({ events: f.session.snapshotEvents().filter(event => event.seq !== first.seq) })
  f.capture.enqueue('ticketA', 'assignmentA', second); await f.effects.idle('memory-capture')
  expect(f.cursor()).toMatchObject({ seq: Number(first.seq), partial: true })
  expect(f.board.all.memory?.detail).toBe('partial_capture')
  expect(f.effects.pending('memory-capture')).toBe(true)
  expect(f.memory.list('candidate')).toHaveLength(1)
})

it('bounds incremental batches, redacts before analysis, and prevents fabricated verification/evidence', async () => {
  const propose = vi.fn(async (input: Readonly<MemoryAnalysisInput>) => proposal(input))
  const f = captureFixture({ propose })
  let end!: SessionEvent<'turn/end'>
  for (let i = 1; i <= 75; i++) end = turn(f.session, i, 'token=private-value person@example.com ghp_abcdefgh12345678')
  f.capture.enqueue('ticketA', 'assignmentA', end); await f.effects.idle('memory-capture')
  expect(f.cursor()?.seq).toBe(Number(end.seq))
  expect(propose.mock.calls.length).toBeGreaterThan(1)
  expect(JSON.stringify(propose.mock.calls)).not.toMatch(/private-value|person@example.com|ghp_abcdefgh/)
  expect(propose.mock.calls.every(([input]) => input.events.length <= 200)).toBe(true)
  const later = turn(f.session, 76)
  propose.mockImplementationOnce(async input => proposal(input).map(item => ({ ...item, evidenceRefs: [`seq:999:${fingerprint('invented')}`] })))
  const count = f.memory.list('candidate').length
  f.capture.enqueue('ticketA', 'assignmentA', later); await f.effects.idle('memory-capture')
  expect(f.memory.list('candidate')).toHaveLength(count)
  expect(f.cursor()?.seq).toBe(Number(end.seq))
})

it('holds disabled and exhausted work durably, sanitizes model errors and resumes after dispatcher restart', async () => {
  const propose = vi.fn(async (input: Readonly<MemoryAnalysisInput>) => proposal(input))
  const f = captureFixture({ propose })
  f.store.saveSettings({ ...f.store.settings(), memory: { ...f.store.settings().memory, dailyCallBudget: 0 } })
  f.service.configure(f.store.settings().memory)
  f.capture.enqueue('ticketA', 'assignmentA', turn(f.session, 1)); await f.effects.idle('memory-capture')
  expect(propose).not.toHaveBeenCalled()
  expect(f.effects.pending('memory-capture')).toBe(true)
  f.service.configure(MemoryConfigSchema.parse({ enabled: false }))
  f.store.db.exec('UPDATE effect SET due=0'); await f.effects.idle('memory-capture')
  expect(f.effects.pending('memory-capture')).toBe(true)
  await f.effects.drain()
  f.store.saveSettings({ ...f.store.settings(), memory: MemoryConfigSchema.parse({ enabled: true, autoCapture: true, dailyCallBudget: 2 }) })
  f.service.configure(f.store.settings().memory)
  const restarted = new Effects(f.store, { claim: () => ({ get: () => undefined, set: () => {}, release: () => {} }) })
  const secondCapture = new MemoryCapture({ ...f.host, effects: restarted })
  restarted.start(); await restarted.idle('memory-capture')
  expect(f.memory.list('candidate')).toHaveLength(1)
  expect(restarted.pending('memory-capture')).toBe(false)
  const next = turn(f.session, 2)
  propose.mockRejectedValueOnce(new Error('API_KEY=private-error'))
  secondCapture.enqueue('ticketA', 'assignmentA', next)
  await restarted.idle('memory-capture')
  expect(f.store.db.prepare("SELECT error FROM effect WHERE kind='memory-capture'").get()?.error).toBe('Error: memory_capture_failed')
  expect(JSON.stringify(f.board.all)).not.toContain('private-error')
  expect(f.memory.list('candidate')).toHaveLength(1)
  await restarted.drain()
})

it('rejects schema-based privilege escalation and records initial retention gaps as partial', async () => {
  const f = captureFixture({ propose: async input => proposal(input).map(item => ({ ...item, status: 'verified', command: 'rm -rf /' })) })
  const end = turn(f.session, 1)
  f.capture.enqueue('ticketA', 'assignmentA', end); await f.effects.idle('memory-capture')
  expect(f.memory.list('candidate')).toEqual([])
  expect(f.cursor()).toBeNull()
  f.inspect.mockResolvedValue({ events: f.session.snapshotEvents().slice(1) })
  f.store.db.exec('UPDATE effect SET due=0'); await f.effects.idle('memory-capture')
  expect(f.cursor()).toMatchObject({ seq: -1, partial: true })
})

it('stops a non-cooperative transcript inspection on shutdown without losing its effect', async () => {
  const f = captureFixture()
  const pending = deferred<{ events: readonly SessionEvent[] }>()
  f.inspect.mockImplementation(async () => pending.promise)
  f.capture.enqueue('ticketA', 'assignmentA', turn(f.session, 1))
  const active = f.effects.idle('memory-capture')
  await waitUntil(() => f.inspect.mock.calls.length === 1)
  f.lifetime.abort(); await active
  expect(f.effects.pending('memory-capture')).toBe(true)
  expect(f.cursor()).toBeNull()
  pending.resolve({ events: [] })
})

it('retains an interrupted model job on shutdown and never commits its late result', async () => {
  const pending = deferred<unknown>()
  const f = captureFixture({ propose: async () => pending.promise })
  f.capture.enqueue('ticketA', 'assignmentA', turn(f.session, 1))
  const active = f.effects.idle('memory-capture')
  await waitUntil(() => f.store.get('memory-usage') !== undefined)
  f.lifetime.abort(); await active
  expect(f.effects.pending('memory-capture')).toBe(true)
  expect(f.cursor()).toBeNull()
  pending.resolve([]); await Promise.resolve(); await Promise.resolve()
  expect(f.memory.list('candidate')).toEqual([])
})

it('waits for background review jobs after ready without occupying a WorkerSlot, and captures blocked turns', async () => {
  const analyze = vi.fn(async (input: Readonly<MemoryAnalysisInput>) => proposal(input))
  const h = await startRuntime(store => store.saveSettings({ ...store.settings(), memory: { enabled: true, autoCapture: true, dailyCallBudget: 10 } }), {}, { memoryAnalyzer: { propose: analyze } })
  onTestFinished(() => h.stop())
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '修复回归'))
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '99' }, true)
  const session = Session.create(SessionId(sessionId)), end = turn(session, 1)
  h.controller.inspect.mockImplementation(async id => ({ events: id === sessionId ? session.snapshotEvents() : [] }))
  const job = h.jobs.run(sessionId, 'review server')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Ready to review' })
  h.ctx.emit('session/event', session, end)
  h.agents.get(sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.ctx.agents.get(SessionId(sessionId))!, status: 'idle' })
  await waitUntil(() => h.runtime.executor.activeCount() === 0)
  expect(analyze).not.toHaveBeenCalled()
  expect(h.runtime.effects.pending('memory-capture')).toBe(false)
  h.jobs.end(job)
  await waitUntil(() => h.runtime.memory.publisher().list('candidate').length === 1)
  const second = await h.acceptedTicket(feishu('2', '处理测试失败'))
  const blocked = Session.create(SessionId(second.sessionId)), blockedEnd = turn(blocked, 1)
  h.controller.inspect.mockImplementation(async id => ({ events: id === sessionId ? session.snapshotEvents() : blocked.snapshotEvents() }))
  await h.runTool(second.sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Need test fixture' })
  h.ctx.emit('session/event', blocked, blockedEnd)
  h.agents.get(second.sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.ctx.agents.get(SessionId(second.sessionId))!, status: 'idle' })
  await waitUntil(() => h.runtime.memory.publisher().list('candidate').length === 2)
})

it('does not capture retry backoff or interrupted background turns and captures a later stable Assignment', async () => {
  const analyze = vi.fn(async (input: Readonly<MemoryAnalysisInput>) => proposal(input))
  const h = await startRuntime(store => store.saveSettings({ ...store.settings(), memory: { enabled: true, autoCapture: true, dailyCallBudget: 10 } }), {}, { memoryAnalyzer: { propose: analyze } })
  onTestFinished(() => h.stop())
  const first = await h.acceptedTicket(feishu('1', '处理暂时失败'))
  const session = Session.create(SessionId(first.sessionId)), end = turn(session, 1)
  h.controller.inspect.mockImplementation(async () => ({ events: session.snapshotEvents() }))
  h.ctx.emit('session/event', session, end)
  h.ctx.emit('agent/error', { agent: h.ctx.agents.get(SessionId(first.sessionId))!, error: new Error('ECONNRESET') } as never)
  h.agents.get(first.sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.ctx.agents.get(SessionId(first.sessionId))!, status: 'idle' })
  await Promise.resolve(); await Promise.resolve()
  expect(h.runtime.effects.pending('memory-capture')).toBe(false)
  expect(analyze).not.toHaveBeenCalled()
  h.runtime.engine.stopTicket(first.ticket.id)
  const second = await h.acceptedTicket(feishu('2', '处理阻塞'))
  const other = Session.create(SessionId(second.sessionId))
  h.controller.inspect.mockImplementation(async id => ({ events: id === first.sessionId ? session.snapshotEvents() : other.snapshotEvents() }))
  const job = h.jobs.run(second.sessionId, 'pending test')
  const early = turn(other, 1)
  h.ctx.emit('session/event', other, early)
  h.agents.get(second.sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.ctx.agents.get(SessionId(second.sessionId))!, status: 'idle' })
  await Promise.resolve(); await Promise.resolve()
  expect(h.runtime.effects.pending('memory-capture')).toBe(false)
  // The job wakes a new turn. Only its subsequent quiet end may be captured.
  h.jobs.end(job)
  await h.runTool(second.sessionId, 'orchestrator_report', { state: 'failed', summary: 'Need a retry' })
  const final = turn(other, 2)
  h.ctx.emit('session/event', other, final)
  h.agents.get(second.sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.ctx.agents.get(SessionId(second.sessionId))!, status: 'idle' })
  await waitUntil(() => h.runtime.memory.publisher().list('candidate').length === 1)
  h.runtime.engine.retryTicket(second.ticket.id)
  await h.runtime.idle()
  const retried = turn(other, 3)
  h.ctx.emit('session/event', other, retried)
  h.agents.get(second.sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.ctx.agents.get(SessionId(second.sessionId))!, status: 'idle' })
  await waitUntil(() => h.runtime.memory.publisher().list('candidate').length === 2)
  expect(h.runtime.store.tickets.get(second.ticket.id)?.assignments).toHaveLength(2)
})
