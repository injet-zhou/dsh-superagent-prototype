// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import type { ApiResponse } from '../src/app/api.ts'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, type, click, tab, find, text, field, all, settle } from './fixtures/panel.tsx'
import { fakeForm, problemOf, server } from './fixtures/panel-server.ts'

usePanel()

it('switches repository API scopes and remounts forms without using a global mutable API destination', async () => {
  const original = fetch
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url)
    if (url === '/orchestrator/api/repositories') return new Response(JSON.stringify([
      { id: 'default', name: 'Primary', repository: 'acme/widgets', configured: true },
      { id: 'backend', name: 'Backend', repository: 'acme/backend', configured: true, state: 'error', globalLoad: { running: 2, maxWorkers: 4 } },
    ]), { status: 200 })
    return original(url.replace('/orchestrator/repositories/backend/api/', '/orchestrator/api/'), init)
  }))
  await mount()
  await click('Backend')
  await click(tab(zh['tab.settings']))
  expect(requests).toContain('/orchestrator/repositories/backend/api/state')
  expect(requests).toContain('/orchestrator/repositories/backend/api/settings')
  expect(text()).toContain(zh.repositoryFailures)
  expect(text()).toContain('全局运行 2 / 自动派工上限 4')
  const beforeRemount = requests.length
  await remount()
  expect(tab(zh.repositoryOverview).getAttribute('aria-selected')).toBe('true')
  expect(requests.slice(beforeRemount).some(path => path.includes('/api/state'))).toBe(true)
  await click('Backend')
  expect((find(zh.repositorySelector, 'select') as HTMLSelectElement).value).toBe('backend')
  expect(requests.slice(beforeRemount)).toContain('/orchestrator/repositories/backend/api/state')
  const since = requests.length
  await type(find(zh.repositorySelector, 'select') as HTMLSelectElement, 'default')
  expect(requests.slice(since)).toContain('/orchestrator/api/state')
  expect(requests.slice(since).some(path => path.startsWith('/orchestrator/repositories/'))).toBe(false)
  await click(zh.repositorySettings)
  expect(field<HTMLSelectElement>(zh.repositorySettingsScope).value).toBe('default')
})

type Catalog = ApiResponse<'GET repositories'>
const primary: Catalog[number] = { id: 'default', name: 'Default', repository: 'acme/widgets', configured: true, state: 'ready',
  load: { running: 2, queued: 3, maxWorkers: 4 }, attention: 1, globalLoad: { running: 2, maxWorkers: 4 } }
/** Keep the host config form and catalog connected while forwarding scoped requests to the existing panel fixture. */
function managementServer(catalog?: () => Catalog) {
  const original = fetch
  const requests: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    if (url === '/orchestrator/api/repositories') return Response.json(catalog?.() ?? [primary,
      ...((server.form?.getSnapshot().value?.repositories ?? []) as { id: string; name: string }[]).map(entry =>
        ({ ...entry, repository: '', configured: false, state: 'paused' as const, load: { running: 0, queued: 0, maxWorkers: 3 }, attention: 0 }))])
    return original(url.replace(/\/orchestrator\/repositories\/[^/]+\/api\//, '/orchestrator/api/'), init)
  }))
  return requests
}

it('shows repository load and startup errors together and opens the selected repository', async () => {
  managementServer(() => [primary, { id: 'locked', name: 'Locked', repository: '', configured: false, state: 'error', error: 'State directory is locked' },
    { id: 'starting', name: 'Starting', repository: '', configured: false, state: 'starting' },
    { id: 'chat', name: 'Chat', repository: 'acme/chat', configured: true, state: 'error', problems: [problemOf('discordBotFailed')] }])
  await mount()
  expect(text()).toContain('活跃 Worker 2')
  expect(text()).toContain('待启动工单 3')
  expect(text()).toContain('待人工处理 1')
  expect(text()).toContain('State directory is locked')
  expect(text()).toContain(zh['repositoryState.starting'])
  expect(text()).toContain(zh['setup.discordBotFailed'])
  expect(all('.dt-repository')[1]!.textContent).toContain('活跃 Worker —')
  await click('acme/widgets')
  expect(tab(zh['tab.overview']).getAttribute('aria-selected')).toBe('true')
  await click(zh.repositoryOverview)
  await click('待人工处理 1')
  expect(server.requests.some(request => request.path === 'tickets?state=person&limit=20')).toBe(true)
})

it('adds a repository through the host configuration and opens its scoped Source settings after the catalog reloads', async () => {
  const { form, mutations } = fakeForm()
  server.form = form
  const requests = managementServer()
  await mount()
  await click(zh.repositoryOverview)
  await click(zh.repositoryAdd)
  await type(field<HTMLInputElement>(zh.repositoryName), 'Backend')
  await click(zh.advanced)
  await type(field<HTMLInputElement>(zh.repositoryId), 'default')
  expect(text()).toContain(zh.repositoryIdReserved)
  expect((find(zh.repositoryAdd, '.dt-modal button[type="submit"]') as HTMLButtonElement).disabled).toBe(true)
  await type(field<HTMLInputElement>(zh.repositoryId), 'backend')
  await click(find(zh.repositoryAdd, '.dt-modal button[type="submit"]'))
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['repositories'], value: [{ id: 'backend', name: 'Backend' }] }] }])
  expect(form.getSnapshot().value).toMatchObject({ repositories: [{ id: 'backend', name: 'Backend' }], promptMaxChars: 100000 })
  expect(field<HTMLSelectElement>(zh.repositorySettingsScope).value).toBe('backend')
  expect(requests.some(request => request.url === '/orchestrator/repositories/backend/api/settings')).toBe(true)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('confirms repository removal and persists the remaining list, keeping the default repository', async () => {
  const { form, mutations, publish } = fakeForm()
  publish({ value: { ...form.getSnapshot().value, repositories: [{ id: 'backend', name: 'Backend' }] } })
  server.form = form
  managementServer()
  await mount()
  expect(all('button[aria-label="移除 Default"]')).toHaveLength(0)
  await click('移除 Backend')
  expect(text()).toContain('历史记录、设置和工作目录会保留')
  await click(zh.cancel)
  expect(mutations).toHaveLength(0)
  await click('移除 Backend')
  await click(find(zh.repositoryRemove, '.dt-modal-footer button'))
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['repositories'], value: [] }] }])
  expect(all('.dt-repository')).toHaveLength(1)
  expect(text()).toContain('acme/widgets')
})

it('keeps a refused repository addition editable and disables management for read-only hosts', async () => {
  const { form, mutations } = fakeForm(true, false)
  server.form = form
  managementServer()
  await mount()
  await click(zh.repositoryOverview)
  await click(zh.repositoryAdd)
  await click(zh.advanced)
  await type(field<HTMLInputElement>(zh.repositoryId), 'backend')
  await click(find(zh.repositoryAdd, '.dt-modal button[type="submit"]'))
  expect(mutations).toHaveLength(1)
  expect(field<HTMLInputElement>(zh.repositoryId).value).toBe('backend')
  expect(text()).toContain(zh.repositorySaveRefused)
  await click(zh.cancel)
  server.form = fakeForm(false).form
  await remount()
  expect((find(zh.repositoryAdd) as HTMLButtonElement).disabled).toBe(true)
  expect(text()).toContain(zh.repositoryReadOnly)
})

it('edits global limits and repository Router and Worker models from the independent settings panel', async () => {
  const { form, publish } = fakeForm()
  publish({ value: { ...form.getSnapshot().value, repositories: [{ id: 'backend', name: 'Backend' }] } })
  server.form = form
  const requests = managementServer()
  const executor = { ...server.settings.executor }
  await mount()
  await click(tab(zh.repositorySettings))
  expect(field<HTMLSelectElement>(zh.repositorySettingsScope).value).toBe('')
  await type(field<HTMLInputElement>(zh.repositoryWorkerLimit), '6')
  await click(zh.save)
  expect(server.settings.executor).toEqual({ ...executor, maxWorkers: 6 })
  expect(requests.find(request => request.init?.method === 'PUT')?.url).toBe('/orchestrator/api/settings/executor')
  await type(field<HTMLSelectElement>(zh.repositorySettingsScope), 'backend')
  await click(find(zh['settingsGroup.eval'], '.dt-settings-link'))
  expect(text()).toContain(zh.assessorModel)
  let [provider, model] = all('.dt-model input')
  await type(provider as HTMLInputElement, 'router-provider')
  await type(model as HTMLInputElement, 'router-model')
  await click(zh.save)
  expect(requests.find(request => request.url === '/orchestrator/repositories/backend/api/settings/eval' && request.init?.method === 'PUT')).toBeDefined()
  expect(server.settings.eval.model).toEqual({ provider: 'router-provider', model: 'router-model' })
  await click(find(zh['settingsGroup.execution'], '.dt-settings-link'))
  expect(text()).toContain(zh.executorModel)
  expect(field<HTMLInputElement>(zh.maxWorkers)).toBeDefined()
  expect(all('label').some(label => label.textContent === zh.repositoryWorkerLimit)).toBe(false)
  ;[provider, model] = all('.dt-model input')
  await type(provider as HTMLInputElement, 'worker-provider')
  await type(model as HTMLInputElement, 'worker-model')
  await click(zh.save)
  expect(requests.find(request => request.url === '/orchestrator/repositories/backend/api/settings/executor' && request.init?.method === 'PUT')).toBeDefined()
  expect(server.settings.executor.model).toEqual({ provider: 'worker-provider', model: 'worker-model' })
})

it('waits for the catalog before mounting any repository page and shows unconfigured repositories as pending setup', async () => {
  const original = fetch
  const catalog = Promise.withResolvers<Response>()
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url)
    if (url === '/orchestrator/api/repositories') return catalog.promise
    return original(url, init)
  }))
  await mount()
  expect(requests).toEqual(['/orchestrator/api/repositories'])
  expect(all('[role="tab"]')).toHaveLength(0)
  await act(async () => { catalog.resolve(Response.json([primary,
    { id: 'new', name: 'New', repository: '', configured: false, state: 'paused', problems: [problemOf('repositoryUnset')] }])) })
  await settle()
  expect(tab(zh.repositoryOverview).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-repository')[1]!.textContent).toContain(zh['repositoryState.setup'])
  await click('acme/widgets')
  expect(text()).not.toContain(zh.repositoryFailures)
})

it('restores the settings scope when reopening the panel and falls back after that repository is removed', async () => {
  let entries: Catalog = [primary, { id: 'backend', name: 'Backend', repository: 'acme/backend', configured: true }]
  const requests = managementServer(() => entries)
  await mount()
  await click(tab(zh.repositorySettings))
  await type(field<HTMLSelectElement>(zh.repositorySettingsScope), 'backend')
  const before = requests.length
  await remount()
  expect(field<HTMLSelectElement>(zh.repositorySettingsScope).value).toBe('backend')
  expect(requests.slice(before).some(request => request.url === '/orchestrator/repositories/backend/api/settings')).toBe(true)
  entries = [primary]
  const removed = requests.length
  await remount()
  expect(field<HTMLSelectElement>(zh.repositorySettingsScope).value).toBe('')
  expect(requests.slice(removed).some(request => request.url.includes('/repositories/backend/'))).toBe(false)
})

it('offers retry and cancellation when a saved addition never appears, without submitting the mutation twice', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const { form, mutations } = fakeForm()
    server.form = form
    const requests = managementServer(() => [primary])
    await mount()
    await click(zh.repositoryOverview)
    await click(zh.repositoryAdd)
    await click(zh.advanced)
    await type(field<HTMLInputElement>(zh.repositoryId), 'backend')
    await click(find(zh.repositoryAdd, '.dt-modal button[type="submit"]'))
    expect(text()).toContain(zh.repositoryReloading)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) }); await settle()
    expect(text()).toContain(zh.repositoryReloadTimeout)
    const reads = requests.length
    await click(zh.repositoryCheckAgain)
    expect(requests.length).toBeGreaterThan(reads)
    expect(mutations).toHaveLength(1)
    await click(zh.repositoryStopWaiting)
    expect((find(zh.repositoryAdd) as HTMLButtonElement).disabled).toBe(false)
    expect(text()).not.toContain(zh.repositoryReloading)
  } finally { vi.useRealTimers() }
})

it('uses consistent repository names in removal confirmation and explains invalid IDs', async () => {
  const { form, publish } = fakeForm()
  publish({ value: { ...form.getSnapshot().value, repositories: [{ id: 'backend', name: 'Backend' }] } })
  server.form = form
  managementServer(() => [primary, { id: 'backend', name: 'Backend', repository: 'acme/backend', configured: true, state: 'ready', error: 'Read failed' }])
  await mount()
  expect(text()).toContain(zh.repositoryDefault)
  expect(all('.dt-repository')[1]!.textContent).toContain(zh['repositoryState.error'])
  await click('移除 Backend')
  expect(document.querySelector('.dt-modal-description')?.textContent).toContain('移除“Backend”')
  await click(zh.cancel)
  await click(zh.repositoryAdd)
  await click(zh.advanced)
  await type(field<HTMLInputElement>(zh.repositoryId), 'bad id')
  expect(text()).toContain(zh.repositoryIdInvalid)
  await type(field<HTMLInputElement>(zh.repositoryId), 'backend')
  expect(text()).toContain(zh.repositoryIdTaken)
})

it('can stop waiting even if the catalog refresh itself never answers', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const held = Promise.withResolvers<Response>()
  try {
    server.form = fakeForm().form
    managementServer(() => [primary])
    const original = fetch
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
      url === '/orchestrator/api/repositories' && ++reads > 1 ? held.promise : original(url, init)))
    await mount()
    await click(zh.repositoryOverview)
    await click(zh.repositoryAdd)
    await click(zh.advanced)
    await type(field<HTMLInputElement>(zh.repositoryId), 'backend')
    await click(find(zh.repositoryAdd, '.dt-modal button[type="submit"]'))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) }); await settle()
    expect(text()).toContain(zh.repositoryReloadTimeout)
    await click(zh.repositoryStopWaiting)
    expect((find(zh.repositoryAdd) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { held.resolve(Response.json([primary])) }); await settle()
  } finally { vi.useRealTimers() }
})
