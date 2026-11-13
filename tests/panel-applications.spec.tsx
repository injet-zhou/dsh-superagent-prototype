// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, tab, field, type, all, text, find } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { discordKind } from '../src/sources/discord.ts'
import { wecomKind } from '../src/sources/wecom.ts'
import type { SourceKind } from '../src/sources/kind.ts'

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

it.each((['feishu', 'discord', 'wecom'] as const).flatMap(source => (['new', 'existing'] as const).map(mode => ({ source, mode }))))(
  'adds editable $source chat rows to a $mode application and preserves saved rows', async ({ source, mode }) => {
    server.extraKinds = [discordKind as unknown as SourceKind]
    const kind = source === 'feishu' ? feishuKind : source === 'discord' ? discordKind : wecomKind
    const rowsKey = source === 'discord' ? 'channels' : 'chats', key = source === 'discord' ? 'channelId' : 'chatId'
    const savedId = source === 'feishu' ? 'oc_saved' : source === 'discord' ? '456' : 'saved-group'
    const ids = source === 'feishu' ? ['oc_appone', 'oc_apptwo'] : source === 'discord' ? ['1001', '1002'] : ['app-one', 'app-two']
    const config = kind.schema.parse({ ...source === 'feishu' ? { cli: '/tmp/app-lark' } : source === 'discord' ? { tokenFile: '/tmp/app-discord' } : { secretFile: '/tmp/app-wecom' },
      ...source === 'discord' ? {} : { directMessages: false, otherChats: 'none' },
      [rowsKey]: mode === 'existing' ? [{ [key]: savedId, ...source === 'wecom' ? {} : { listen: 'mentions' } }] : [] })
    if (mode === 'existing') server.applications.push({ id: 'shop', name: 'Shop', enabled: true, repositories: ['default'],
      sources: { [source]: { enabled: true, config } }, allowed: {}, model: null, revision: 1 })
    await mount()
    await click(zh.repositoryOverview); await click(tab(zh.applications))
    await click(mode === 'existing' ? zh.applicationEdit : zh.applicationAdd)
    if (mode === 'new') {
      await type(field<HTMLInputElement>(zh.applicationName), 'Shop')
      await click(all('#dt-application input[type="checkbox"]')[0]!)
      await click(find(kind.title.zh, '[role="switch"]'))
    }
    const rows = kind.fields.find(spec => spec.key === rowsKey)!
    if (rows.type !== 'rows') throw new Error('Expected chat rows')
    const sourceFields = all('#dt-application fieldset').find(set => set.firstElementChild?.tagName === 'LEGEND' && set.firstElementChild.textContent === kind.title.zh)!
    const group = [...sourceFields.querySelectorAll('.dt-field')].find(field => field.querySelector('.dt-subhead > .dt-field-head')?.textContent?.startsWith(rows.label.zh))!
    for (const id of ids) {
      await click([...group.querySelectorAll('button')].find(button => button.textContent?.trim() === zh.addRow)!)
      const inputs = [...group.querySelectorAll<HTMLInputElement>('input')].filter(input => input.getAttribute('aria-label') === rows.columns[0]!.label.zh)
      expect(inputs.length).toBeGreaterThan(0)
      await type(inputs.at(-1)!, id)
      expect(group.querySelector<HTMLInputElement>(`input[value="${id}"]`)).not.toBeNull()
    }
    if (mode === 'existing') expect(group.querySelector(`span[title="${savedId}"]`)).not.toBeNull()
    await click(zh.save)
    expect((server.applications[0]!.sources[source]!.config[rowsKey] as Record<string, string>[]).map(row => row[key])).toEqual(mode === 'existing' ? [savedId, ...ids] : ids)
    await click(zh.applicationEdit)
    expect(all('#dt-application input').some(input => ids.includes((input as HTMLInputElement).value))).toBe(false)
  },
)
