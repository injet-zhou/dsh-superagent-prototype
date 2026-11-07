// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, type, click, tab, find } from './fixtures/panel.tsx'

usePanel()

it('switches repository API scopes and remounts forms without using a global mutable API destination', async () => {
  const original = fetch
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url)
    if (url === '/orchestrator/api/repositories') return new Response(JSON.stringify([
      { id: 'default', name: 'Primary', repository: 'acme/widgets', configured: true },
      { id: 'backend', name: 'Backend', repository: 'acme/backend', configured: true },
    ]), { status: 200 })
    return original(url.replace('/orchestrator/repositories/backend/api/', '/orchestrator/api/'), init)
  }))
  await mount()
  await type(find(zh.repositorySelector, 'select') as HTMLSelectElement, 'backend')
  await click(tab(zh['tab.settings']))
  expect(requests).toContain('/orchestrator/repositories/backend/api/state')
  expect(requests).toContain('/orchestrator/repositories/backend/api/settings')
  const since = requests.length
  await type(find(zh.repositorySelector, 'select') as HTMLSelectElement, 'default')
  expect(requests.slice(since)).toContain('/orchestrator/api/state')
  expect(requests.slice(since).some(path => path.startsWith('/orchestrator/repositories/'))).toBe(false)
})
