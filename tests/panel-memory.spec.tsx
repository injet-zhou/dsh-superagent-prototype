// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { usePanel, mount, at, click, type, field, text, find, tab, settle } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import { zh } from '../src/client/locales.ts'
import { exampleNote } from './fixtures/memory.ts'
import type { MemoryDetails } from '../src/app/memory/types.ts'

usePanel()

function seed(id: string, title: string, status: MemoryDetails['note']['status'] = 'candidate'): MemoryDetails {
  return server.memory[id] = { note: { ...exampleNote, title, id, repository: 'acme/widgets', revision: 1, status,
    body: 'Recorded fixture observation', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' }, evidence: [], revisions: [] }
}

it('configures an explicit Memory model and daily call budget without changing Policy or worker settings', async () => {
  const policy = structuredClone(server.settings.policy), executor = structuredClone(server.settings.executor)
  at({ page: 'settings', query: { group: 'memory' } })
  await mount()
  await click('启用仓库记忆')
  await click('自动提取候选')
  await type(field<HTMLInputElement>('每日模型调用上限'), '1000')
  await type(field<HTMLInputElement>('整理预留调用次数'), '300')
  await type(field<HTMLInputElement>(zh.modelProvider), 'memory-provider')
  await type(field<HTMLInputElement>(zh.modelName), 'memory-model')
  await click(zh.save)
  expect(server.settings.memory).toMatchObject({ enabled: true, autoCapture: true, dreaming: false, dailyCallBudget: 1000,
    consolidationReservedCalls: 300,
    analyzerModel: { provider: 'memory-provider', model: 'memory-model' } })
  expect(server.settings.policy).toEqual(policy)
  expect(server.settings.executor).toEqual(executor)
  expect(text()).not.toContain(zh.modelInherit)
})

it('links the disabled Memory empty state to its settings', async () => {
  server.settings.memory.enabled = false
  at({ page: 'memory' }); await mount()
  expect(text()).toContain(zh.memoryEnableToCapture)
  await click(zh.memoryOpenSettings)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.memory'])
})

it('searches and filters notes, reports disabled consolidation clearly and runs manual maintenance', async () => {
  server.settings.memory.enabled = true
  seed('sqlite', 'SQLite review', 'verified'); seed('build', 'Build workflow')
  at({ page: 'memory' }); await mount()
  await type(field<HTMLInputElement>('搜索记忆'), 'SQLite')
  expect(text()).toContain('SQLite review'); expect(text()).not.toContain('Build workflow')
  await click('待核验 1')
  expect(text()).toContain('没有找到符合条件的记忆。')
  await click('整理记忆')
  expect(text()).toContain('请先在记忆设置中开启后台整理。')
  await click('重建索引'); expect(server.rebuilt).toBe(1)
})

it('refreshes a conflicted review and requires the person to confirm the changed revision again', async () => {
  seed('note', 'Review conflict')
  at({ page: 'memory', id: 'note' }); await mount()
  await click('确认有效'); await type(field<HTMLTextAreaElement>('说明'), 'Checked this version')
  await click(find('我已核对原始来源和适用范围', 'label'))
  server.memory.note!.note.revision = 2
  await click('提交确认')
  expect(text()).toContain('这条记忆已被修改，已刷新内容。请重新核对后再提交。')
  expect(server.memory.note!.note.status).toBe('candidate')
  expect((find('提交确认') as HTMLButtonElement).disabled).toBe(true)
  await click(find('我已核对原始来源和适用范围', 'label')); await click('提交确认')
  expect(server.memory.note!.note).toMatchObject({ revision: 3, status: 'verified' })
})

it('explains a repeated consolidation request when the single task is already queued', async () => {
  server.settings.memory.enabled = true; server.settings.memory.dreaming = true
  const original = fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/memory/consolidate')) return new Response(JSON.stringify({ queued: false }), { status: 200 })
    const response = await original(url, init)
    if (url.startsWith('/orchestrator/api/memory?')) {
      const body = JSON.parse(await response.text()); body.health.consolidationPending = 1
      return new Response(JSON.stringify(body), { status: response.status })
    }
    return response
  }))
  at({ page: 'memory' }); await mount(); await click('整理记忆')
  expect(text()).toContain('整理任务已在队列中，会继续处理待审阅笔记。')
})

it('loads Memory through the selected repository scope and removes the previous repository note', async () => {
  seed('same-id', 'Private default')
  const original = fetch, requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url)
    if (url === '/orchestrator/api/repositories') return new Response(JSON.stringify([
      { id: 'default', name: 'Default', repository: 'acme/widgets', configured: true },
      { id: 'backend', name: 'Backend', repository: 'acme/backend', configured: true },
      { id: 'frontend', name: 'Frontend', repository: 'acme/frontend', configured: true },
    ]), { status: 200 })
    const selected = /\/repositories\/([^/]+)\/api\//.exec(url)?.[1] ?? 'default'
    const response = await original(url.replace(/\/repositories\/[^/]+\/api\//, '/api/'), init)
    if (url.includes('/api/memory')) {
      const body = JSON.parse(await response.text())
      if (body.items) for (const item of body.items) item.title = `Private ${selected}`
      if (body.note) body.note.title = `Private ${selected}`
      return new Response(JSON.stringify(body), { status: response.status })
    }
    return response
  }))
  at({ page: 'memory' }); await mount()
  for (const id of ['backend', 'frontend']) {
    if (id === 'frontend') await click(zh.repositoryOverview)
    await click(id === 'backend' ? 'Backend' : 'Frontend')
    await click(tab('记忆'))
    expect(text()).toContain(`Private ${id}`)
    expect(text()).not.toContain(id === 'backend' ? 'Private default' : 'Private backend')
    expect(requests.some(url => url.startsWith(`/orchestrator/repositories/${id}/api/memory`))).toBe(true)
  }
})

it('reviews candidate sources and changes status only after explicit confirmation and a reason', async () => {
  server.settings.memory.enabled = true
  server.memory.note = { note: { ...exampleNote, id: 'note', repository: 'acme/widgets', revision: 1, status: 'candidate',
    createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', body: '<script>throw new Error("injection")</script>\nRun the migration regression.' },
    evidence: [{ id: 'proof', noteId: 'note', ticketId: 't1', sessionId: 'worker-t1', kind: 'observation', supportsVerification: false,
      eventRef: `seq:3:${'a'.repeat(64)}`, excerpt: 'Recorded migration check', capturedAt: '2026-11-10T00:00:00Z' }], revisions: [] }
  at({ page: 'memory' })
  await mount()
  await click(exampleNote.title)
  expect(text()).toContain('Recorded migration check')
  expect(text()).toContain('<script>throw new Error("injection")</script>')
  expect(document.querySelector('script')).toBeNull()
  await click('打开来源 Session')
  expect(server.opened).toEqual(['worker-t1'])
  await click('确认有效')
  expect((find('提交确认') as HTMLButtonElement).disabled).toBe(true)
  await type(field<HTMLTextAreaElement>('说明'), 'Checked the source and applicable paths')
  await click(find('我已核对原始来源和适用范围', 'label'))
  await click('提交确认')
  expect(server.memory.note.note).toMatchObject({ status: 'verified', revision: 2 })
  expect(server.requests.find(request => request.path === 'memory/note/review')?.body).toMatchObject({ action: 'confirm', revision: 1,
    confirmed: true, reason: 'Checked the source and applicable paths' })
  await click('标为过期')
  await type(field<HTMLTextAreaElement>('说明'), 'Environment changed')
  await click('保存变更')
  expect(server.memory.note.note).toMatchObject({ status: 'stale', revision: 3 })
  await click('撤销记忆')
  await type(field<HTMLTextAreaElement>('说明'), 'This claim is no longer useful')
  await click('保存变更')
  expect(server.memory.note.note).toMatchObject({ status: 'retracted', revision: 4 })
})

it.each([false, true])('keeps verified memory visible and binds confirmation to the reviewed request, polled=%s', async polled => {
  const details = seed('protected', 'Protected knowledge', 'verified')
  details.pendingReview = { repository: details.note.repository, revision: 1, noteRevision: 1, action: 'retract',
    sources: [{ id: 'proof', noteId: 'protected', ticketId: 't1', sessionId: 'worker-t1', eventRef: 'seq:3:' + 'a'.repeat(64), status: 'missing' }],
    reason: 'The analyzer may be wrong; original source is missing.', at: '2026-11-11T00:00:00Z', job: 'fixture', signature: 'fixture', claimFingerprint: 'fixture' }
  at({ page: 'memory' }); await mount()
  expect(text()).toContain('待审提案')
  await click('Protected knowledge')
  expect(text()).toContain('The analyzer may be wrong; original source is missing.')
  expect(text()).toContain('来源缺失')
  await click('确认有效'); await type(field<HTMLTextAreaElement>('说明'), 'I checked the exact claim and its sources')
  await click(find('我已核对原始来源和适用范围', 'label'))
  details.pendingReview.revision = 2
  details.pendingReview.reason = 'A newer request needs an explicit decision'
  if (polled) {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await settle()
    expect(text()).toContain('A newer request needs an explicit decision')
  }
  await click('提交确认')
  expect(server.requests.filter(request => request.path === 'memory/protected/review').at(-1)?.body).toMatchObject({ revision: 1, reviewRevision: 1 })
  expect(details.note).toMatchObject({ status: 'verified', revision: 1 })
  expect(text()).toContain('这条记忆已被修改，已刷新内容。请重新核对后再提交。')
  expect((find('提交确认') as HTMLButtonElement).disabled).toBe(true)
  await click(find('我已核对原始来源和适用范围', 'label')); await click('提交确认')
  expect(server.requests.filter(request => request.path === 'memory/protected/review').at(-1)?.body).toMatchObject({ revision: 1, reviewRevision: 2 })
  expect(details.note).toMatchObject({ status: 'verified', revision: 2 })
  expect(text()).not.toContain('待审提案')
})
