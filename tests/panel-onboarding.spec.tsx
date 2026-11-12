// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi, onTestFinished } from 'vitest'
import { zh, en } from '../src/client/locales.ts'
import { recipePath } from '../src/client/onboarding.tsx'
import { worktreeCommand } from '../src/workspace.ts'
import { usePanel, mount, remount, click, type, field, find, text, tab, settle } from './fixtures/panel.tsx'
import { server, fakeForm, problemOf } from './fixtures/panel-server.ts'

usePanel()
async function open() {
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.onboarding'], '.dt-settings-link'))
}
it('binds groups and authorizes senders separately, applying changes only on save', async () => {
  server.settings.sources.wecom = { enabled: true, config: { secretFile: '/srv/agent/wecom.json' } }
  server.discovery = [{ id: 'm1', at: '2026-10-01T10:00:00Z', preview: '@bot hello', userId: 'alice', chatId: 'team', filtered: true }]
  await open()
  await click(zh['onboarding.chat'])
  await click(zh.onboardingBind)
  expect(server.settings.sources.wecom.config.chats).toBeUndefined()
  expect(server.settings.policy.sources.wecom).toBeUndefined()
  await click(zh.onboardingAllow)
  expect(server.settings.policy.sources.wecom).toBeUndefined()
  await click(zh.onboardingNext)
  expect(server.settings.sources.wecom.config.chats).toEqual([{ chatId: 'team' }])
  expect(server.settings.policy.sources.wecom?.allowed).toEqual([{ id: 'alice' }])
  expect(text()).toContain(zh.onboardingLocalPath)
  await remount()
  expect(text()).toContain(zh.onboardingLocalPath)
})
it('preserves custom commands until generation is explicitly selected and saved', async () => {
  server.settings.executor.prepare = 'echo custom'
  await open()
  await click(zh['onboarding.workspace'])
  expect(field<HTMLTextAreaElement>(zh.prepareCommand).value).toBe('echo custom')
  const path = "/home/agent/repo ' with spaces"
  await type(field<HTMLInputElement>(zh.onboardingLocalPath), path)
  await click(zh.onboardingGenerate)
  expect(server.settings.executor.prepare).toBe('echo custom')
  await click(zh.onboardingNext)
  expect(recipePath(server.settings.executor.prepare)).toBe(path)
  expect(text()).toContain(zh.onboardingCheckHint)
  expect(text()).toContain(zh.onboardingPending)
  await click(zh.onboardingCheckWorkspace)
  expect(text()).toContain(zh['workspaceCheck.ready'])
})
it('keeps failed account saves in the current step', async () => {
  await open()
  await click(zh['onboarding.repository'])
  const original = fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init?.method === 'PUT'
    ? Response.json({ error: 'Access denied' }, { status: 400 }) : original(url, init)))
  await type(field<HTMLInputElement>('智能体的仓库 CLI'), 'invalid-cli')
  await click(zh.onboardingNext)
  expect(text()).toContain('Access denied')
  expect(field<HTMLInputElement>('智能体的仓库 CLI').value).toBe('invalid-cli')
})
it('creates an internal ID without requiring the user to enter one', async () => {
  server.form = fakeForm().form
  await mount()
  await click(zh.repositoryOverview)
  await click(zh.repositoryAdd)
  await type(field<HTMLInputElement>(zh.repositoryName), 'Backend')
  expect((find(zh.repositoryAdd, '.dt-modal button[type="submit"]') as HTMLButtonElement).disabled).toBe(false)
  expect(document.querySelector('.dt-modal')?.textContent).not.toContain(zh.repositoryIdHint)
})
it('uses English copy and keeps uninstalled chat optional', async () => {
  await mount(en)
  await click(tab(en['tab.settings']))
  await click(find(en['settingsGroup.onboarding'], '.dt-settings-link'))
  await click(en['onboarding.chat'])
  expect(text()).toContain(en.onboardingNoMessages)
  await click(en.onboardingSkip)
  expect(text()).toContain(en.onboardingLocalPath)
})
it('keeps account revision conflicts editable without advancing the wizard', async () => {
  await open()
  await click(zh['onboarding.repository'])
  await type(field<HTMLInputElement>('智能体的仓库 CLI'), 'my-cli')
  const original = fetch
  let rejected = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && !rejected) {
      rejected = true
      server.settings.sources.github!.config.cli = 'someone-else-cli'
      server.revisions['source:github'] = 2
      return Response.json({ error: 'Revision conflict' }, { status: 409 })
    }
    return original(url, init)
  }))
  await click(zh.onboardingNext)
  expect(server.settings.sources.github!.config.cli).toBe('someone-else-cli')
  expect(field<HTMLInputElement>('智能体的仓库 CLI').value).toBe('my-cli')
  expect(document.querySelector('.dt-onboarding-steps [aria-current="step"]')?.textContent).toBe(zh['onboarding.repository'])
  await remount()
  expect(field<HTMLInputElement>('智能体的仓库 CLI').value).toBe('my-cli')
})
it('does not classify custom commands that merely start like a generated recipe as managed worktrees', () => {
  const command = worktreeCommand('/tmp/repo', 'https://github.com/acme/widgets.git')
  expect(recipePath(command)).toBe('/tmp/repo')
  expect(recipePath(`${command} && echo custom`)).toBe('')
})

const advance = async (ms = 1000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
it.each([false, true])('coordinates first-run saves across restart and setup recovery (leave wizard: %s)', async leaveWizard => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, accounts: null, problem: problemOf('repositoryUnset') }
  server.settings.sources.github!.config = {}
  server.settings.policy.sources.github!.allowed = []
  const original = fetch
  let initializing = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (url.endsWith('/settings/policy') && init?.method === 'PUT') return Response.json({ ...JSON.parse(await response.text()), restarting: true })
    if (url.endsWith('/state') && !server.down && initializing) return Response.json({ ...JSON.parse(await response.text()), health: { runtime: { state: 'starting', detail: '' } } })
    return response
  }))
  await open()
  await type(field<HTMLInputElement>('监听的仓库'), 'acme/new')
  await type(field<HTMLInputElement>('智能体的仓库 CLI'), 'gh-new')
  await click(zh.addRow)
  await type(field<HTMLInputElement>('账号'), 'alice')
  await click(zh.onboardingNext)
  const saves = (block: string) => server.requests.filter(request => request.method === 'PUT' && request.path === `settings/${block}`)
  expect(saves('policy')).toHaveLength(1)
  expect(saves('source:github')).toHaveLength(0)
  // A settings poll can see the committed policy before teardown; that is not recovery.
  await advance(5000)
  expect((find(zh.onboardingNext) as HTMLButtonElement).disabled).toBe(true)
  expect(saves('source:github')).toHaveLength(0)
  if (leaveWizard) await click(zh.advanced)
  server.down = true
  await advance()
  expect(saves('source:github')).toHaveLength(0)
  server.down = false; initializing = true
  await advance()
  expect(saves('source:github')).toHaveLength(0)
  initializing = false
  await advance()
  if (leaveWizard) { expect(saves('source:github')).toHaveLength(0); return }
  expect(saves('source:github')).toHaveLength(1)
  server.down = true
  await advance()
  server.down = false
  await advance()
  expect(saves('policy')).toHaveLength(1)
  expect(saves('source:github')).toHaveLength(1)
  expect(server.settings.sources.github!.config).toMatchObject({ repository: 'acme/new', cli: 'gh-new' })
  expect(document.querySelector('.dt-onboarding-steps [aria-current="step"]')?.textContent).toBe(zh['onboarding.chat'])
})
it.each(['/srv/agent/wecom.json', ''])('persists disabling WeCom with secret path %j', async secretFile => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.settings.sources.wecom = { enabled: true, config: { secretFile } }
  await open()
  await click(zh['onboarding.chat'])
  await click(find(zh.sourceEnable.replace('{name}', '企业微信'), '[role="switch"]'))
  expect((find(zh.onboardingNext) as HTMLButtonElement).disabled).toBe(false)
  await click(zh.onboardingNext)
  expect(server.settings.sources.wecom.enabled).toBe(false)
  server.down = true
  await advance()
  server.down = false
  await advance()
  expect(text()).toContain(zh.onboardingLocalPath)
})
