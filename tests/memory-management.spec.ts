import { expect, it, onTestFinished, vi } from 'vitest'
import { startRuntime, feishu } from './fixtures/host.ts'
import { exampleEvidence, exampleNote } from './fixtures/memory.ts'
import type { MemoryPage } from '../src/app/memory/types.ts'

it('lets a person review evidence, confirm a candidate, invalidate and retract it with revision checks', async () => {
  const h = await startRuntime(store => { store.saveSettings({ ...store.settings(), memory: { enabled: true } }) })
  onTestFinished(() => h.stop())
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '核对迁移测试'))
  const memory = h.runtime.memory.publisher()
  memory.create(exampleNote, [{ ...exampleEvidence, ticketId: ticket.id, sessionId, supportsVerification: false }], 'review', 'candidate', 'review-note')
  expect((await h.api('GET', 'memory')).body).toMatchObject({ counts: { candidate: 1, verified: 0 }, items: [{ id: 'review-note', status: 'candidate' }] })
  expect((await h.api('GET', 'memory/review-note')).body.note).toMatchObject({ revision: 1, body: exampleNote.body })
  expect((await h.api('POST', 'memory/review-note/review', { action: 'confirm', revision: 1, reason: 'Not checked' })).status).toBe(400)
  const confirmed = await h.api('POST', 'memory/review-note/review', { action: 'confirm', revision: 1,
    reason: 'I checked the recorded test and current migration scope', confirmed: true })
  expect(confirmed.status).toBe(200)
  expect(confirmed.body.note).toMatchObject({ status: 'verified', revision: 2 })
  expect(confirmed.body.evidence).toContainEqual(expect.objectContaining({ kind: 'human', supportsVerification: true,
    eventRef: expect.stringMatching(/^review:review-note:2:/) }))
  expect((await h.runTool(sessionId, 'orchestrator_memory_search', { query: 'SQLite' })).items).toHaveLength(1)
  const stale = await h.api('POST', 'memory/review-note/review', { action: 'stale', revision: 2, reason: 'The migration environment changed' })
  expect(stale.body.note).toMatchObject({ status: 'stale', revision: 3 })
  expect((await h.runTool(sessionId, 'orchestrator_memory_search', { query: 'SQLite' })).items).toEqual([])
  const fresh = await h.api('POST', 'memory/review-note/review', { action: 'confirm', revision: 3,
    reason: 'Checked the source again after the environment change', confirmed: true })
  expect(fresh.body.note).toMatchObject({ status: 'verified', revision: 4 })
  const retracted = await h.api('POST', 'memory/review-note/review', { action: 'retract', revision: 4, reason: 'Withdraw this claim' })
  expect(retracted.body.note).toMatchObject({ status: 'retracted', revision: 5 })
  expect((await h.api('POST', 'memory/review-note/review', { action: 'stale', revision: 4, reason: 'Outdated review' })).status).toBe(409)
  expect((await h.api('GET', 'memory/review-note')).body.revisions).toHaveLength(5)
})

it('browses bounded pages and retained records while disabled without allowing foreign scopes or executable proposals', async () => {
  const h = await startRuntime()
  onTestFinished(() => h.stop())
  const memory = h.runtime.memory.publisher()
  for (let i = 0; i < 4; i++) memory.create({ ...exampleNote, title: `SQLite ${i}` }, [exampleEvidence], `page-${i}`, 'candidate', `page-${i}`)
  const page = await h.api('GET', 'memory?status=candidate&query=SQLite&limit=2')
  expect(page.body).toMatchObject({ total: 4, next_offset: 2, health: { enabled: false, usedCalls: 0, dailyCallBudget: 0 } })
  const next = await h.api('GET', 'memory?status=candidate&query=SQLite&limit=2&offset=2')
  expect(new Set([...(page.body.items as MemoryPage['items']), ...(next.body.items as MemoryPage['items'])].map(item => item.id)).size).toBe(4)
  expect(next.body.next_offset).toBeNull()
  expect((await h.api('GET', 'memory?repositoryId=other')).status).toBe(400)
  expect((await h.api('GET', 'memory?limit=101')).status).toBe(400)
  expect((await h.api('GET', 'memory/no-such-note')).status).toBe(404)
  expect((await h.api('POST', 'memory/page-0/review', { action: 'confirm', revision: 1, reason: 'Execute this', confirmed: true, command: 'rm -rf /' })).status).toBe(400)
  expect(memory.get('page-0')!.note.status).toBe('candidate')
  expect(h.runtime.health.runtime?.state).toBe('ready')
})

it('rolls back human proof and note publication together and requires fresh confirmation after invalidation', async () => {
  const h = await startRuntime()
  onTestFinished(() => h.stop())
  const memory = h.runtime.memory.publisher()
  memory.create(exampleNote, [{ ...exampleEvidence, supportsVerification: false }], 'rollback', 'candidate', 'atomic-review')
  const before = memory.get('atomic-review')!
  h.runtime.store.db.exec("CREATE TRIGGER reject_memory_review BEFORE INSERT ON memory_revision WHEN NEW.action='confirm' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  const request = { action: 'confirm', revision: 1, confirmed: true, reason: 'Human checked the exact claim; token=private-value' }
  expect((await h.api('POST', 'memory/atomic-review/review', request)).status).toBe(500)
  expect(memory.get('atomic-review')).toEqual(before)
  h.runtime.store.db.exec('DROP TRIGGER reject_memory_review')
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-10T00:00:00Z') })
  try {
    expect((await h.api('POST', 'memory/atomic-review/review', request)).status).toBe(200)
    const reviewed = memory.get('atomic-review')!
    expect(JSON.stringify(reviewed)).not.toContain('private-value')
    memory.update('atomic-review', 2, { status: 'stale' }, [], 'Claim invalidated', 'invalidate')
    expect(() => memory.update('atomic-review', 3, { status: 'verified' }, reviewed.evidence.map(item => item.id), 'Old confirmation', 'old'))
      .toThrow('verification_required')
    expect((await h.api('POST', 'memory/atomic-review/review', { ...request, revision: 3, reason: 'Human rechecked after invalidation' })).body.note)
      .toMatchObject({ status: 'verified', revision: 4 })
    expect(memory.get('atomic-review')!.evidence.filter(item => item.kind === 'human')).toHaveLength(2)
  } finally { vi.useRealTimers() }
})
