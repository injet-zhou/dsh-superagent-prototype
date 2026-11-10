import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { resolveEvidence } from '../src/app/memory/evidence.ts'
import { fingerprint } from '../src/app/memory/security.ts'
import { serializeAnalysisInput } from '../src/app/memory/analyzer.ts'
import { exampleEvidence, exampleNote, memoryFixture } from './fixtures/memory.ts'

function fixture() {
  const f = memoryFixture(), context = new Context(), base = Session.create(SessionId('worker-ticketA'))
  const session = Session.create(base.id, [], { ...base.header, cwd: f.directory })
  f.store.tickets.save({ id: 'ticketA', title: 'A', decisionId: 'd', mandate: { scope: 'migration', strength: 'explicit', policyVersion: 'v',
    actor: { source: 'github', id: 'alice' }, basis: { via: 'listed' } }, assignments: [], origin: { triggerId: 't', triggerIds: ['t'] },
    channels: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution: { name: 'fixture', directory: f.directory, assignment: 'a' } })
  const event = session.append('user/message', { id: MessageId('source'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original observation' }] }, { surfaceOp: 'append' })
  const note = f.memory.create(exampleNote, [{ ...exampleEvidence, eventRef: `seq:${event.seq}:${fingerprint(event)}` }], 'source')
  const input = { mode: 'consolidate' as const, notes: [f.memory.get(note.id)!], events: [] }
  const inspect = vi.fn(async () => ({ meta: session.header, events: session.snapshotEvents() }))
  context.reflect.provide('sessionController', { inspect })
  return { ...f, context, session, input, event, inspect }
}

it.each(['changed', 'missing', 'foreign'])('reports %s history without accepting it as a successful source replay', async mode => {
  const f = fixture()
  if (mode === 'changed') f.input.notes[0]!.evidence[0]!.eventRef = `seq:${f.event.seq}:${'a'.repeat(64)}`
  else if (mode === 'missing') f.inspect.mockResolvedValue({ meta: f.session.header, events: [] })
  else f.inspect.mockResolvedValue({ meta: { ...f.session.header, cwd: '/another-repository' }, events: f.session.snapshotEvents() })
  const result = await resolveEvidence(f, f.input, new AbortController().signal)
  expect(result.events).toEqual([])
  expect(result.sourceChecks?.[0]?.status).toBe(mode === 'foreign' ? 'unavailable' : mode)
})

it('never resolves a foreign Ticket and bounds complete redacted evidence packages', async () => {
  const f = fixture()
  f.input.notes[0]!.evidence[0]!.ticketId = 'other-ticket'
  expect((await resolveEvidence(f, f.input, new AbortController().signal)).sourceChecks?.[0]?.status).toBe('unavailable')
  expect(f.inspect).not.toHaveBeenCalled()
  f.input.notes[0]!.evidence[0]!.ticketId = 'ticketA'
  for (let i = 0; i < 6; i++) f.session.append('user/message', { id: MessageId(`long-${i}`), role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '中文'.repeat(4000) + ' API_KEY=hidden-source-secret' }] }, { surfaceOp: 'append' })
  const result = await resolveEvidence(f, f.input, new AbortController().signal)
  expect(result.events.length).toBeGreaterThan(0)
  expect(Buffer.byteLength(serializeAnalysisInput(result))).toBeLessThanOrEqual(100_000)
  expect(JSON.stringify(result)).not.toContain('hidden-source-secret')
})
