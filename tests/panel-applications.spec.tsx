// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, tab, field, type, all, text } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('creates an application from the management panel and keeps repository selection explicit', async () => {
  await mount()
  await click(zh.repositoryOverview)
  await click(tab(zh.applications))
  expect(text()).toContain(zh.applicationEmpty)
  await click(zh.applicationAdd)
  await type(field<HTMLInputElement>(zh.applicationName), '订单应用')
  const checkbox = all('input[type="checkbox"]')[0]!
  await click(checkbox)
  await click(zh.save)
  expect(server.applications).toHaveLength(1)
  expect(server.applications[0]!.repositories).toEqual(['default'])
  expect(server.applications[0]!.name).toBe('订单应用')
  expect(text()).toContain('订单应用')
  await click('订单应用')
  expect(text()).toContain(zh.applicationNoTasks)
})

it('edits application permissions and model settings without exposing implementation fields', async () => {
  server.applications.push({ id: 'shop', name: 'Shop', enabled: true, repositories: ['default'], sources: {}, allowed: {}, model: null, revision: 1 })
  await mount()
  await click(zh.repositoryOverview)
  await click(tab(zh.applications))
  await click(zh.applicationEdit)
  await type(field<HTMLInputElement>(zh.applicationName), 'Orders')
  expect(all('input').some(input => (input as HTMLInputElement).value === 'shop')).toBe(false)
  await click(zh.save)
  expect(server.applications[0]!.name).toBe('Orders')
  expect(server.applications[0]!.revision).toBe(2)
})
