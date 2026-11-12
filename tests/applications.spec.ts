import { afterEach, expect, it, vi } from 'vitest'
import { Applications, type ApplicationsHost } from '../src/app/applications/service.ts'
import { ApplicationSchema } from '../src/app/applications/types.ts'
import { WorkerSlots } from '../src/executor/dsh.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { startRuntime, feishu, MEMBER, type Host } from './fixtures/host.ts'
import type { SourceHost } from '../src/sources/host.ts'
import { Commands } from '../src/infra/commands.ts'
import { discordKind } from '../src/sources/discord.ts'
import { wecomKind } from '../src/sources/wecom.ts'
import { DiscordApi } from '../src/infra/discord.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'

let fixture: Host | undefined, apps: Applications | undefined
const others: Host[] = []
afterEach(async () => { await apps?.close(); for (const host of others.splice(0)) await host.stop(); await fixture?.stop(); vi.restoreAllMocks() })
async function setup() {
  fixture = await startRuntime(undefined, {}, { applications: () => apps })
  const mounted = new Map<string, SourceHost>()
  const repositories = [{ id: 'default', runtime: fixture.runtime }]
  fixture.runtime.sources.register(discordKind); fixture.runtime.sources.register(wecomKind)
  const host: ApplicationsHost = { context: fixture.ctx, primary: fixture.runtime, repositories: () => repositories,
    slots: new WorkerSlots(() => apps?.runningIds() ?? [], () => 3, 0),
    mount: host => { host.sources.register(feishuKind); host.sources.register(discordKind); host.sources.register(wecomKind); mounted.set('app', host) }, unmount: async () => { mounted.clear() } }
  apps = new Applications(host)
  await apps.start()
  const config = ApplicationSchema.parse({ id: 'shop', name: 'Shop', repositories: ['default'], allowed: { feishu: [{ id: MEMBER }] },
    sources: { feishu: { enabled: true, config: { cli: fixture.runtime.store.settings().sources.feishu!.config.cli,
      directMessages: false, otherChats: 'none', chats: [{ chatId: 'oc_app', listen: 'mentions' }] } } } })
  const app = await apps.save(config, 0)
  const trigger = (id = 'a1', text = 'Fix checkout failure') => feishu(id, text, { chat_id: 'oc_app' })
  return { app, config, trigger, mounted, runtime: fixture.runtime, apps, repositories, host }
}

it('admits a single app request, deduplicates deliveries, and attaches authorized thread followups', async () => {
  const { apps, trigger } = await setup()
  expect(apps.receive('shop', trigger())).toBe('stored')
  expect(apps.receive('shop', trigger())).toBe('duplicate')
  const followup = trigger('a2', 'Here is the request ID')
  followup.threads = trigger().threads
  followup.addressed = undefined
  expect(apps.receive('shop', followup)).toBe('stored')
  expect(apps.listTasks('shop')).toHaveLength(1)
  expect(apps.listTasks('shop')[0]!.messages).toHaveLength(2)
  expect(apps.receive('shop', { ...trigger('a3'), actor: { source: 'feishu', id: 'ou_other' } })).toBe('filtered')
  expect(apps.receive('shop', { ...trigger('a4'), human: false })).toBe('filtered')
})

it('rejects overlapping subscriptions and supports an explicit, durable chat transfer', async () => {
  const { apps, config, runtime } = await setup()
  const next = { ...config, sources: { feishu: { ...config.sources.feishu!, config: { ...config.sources.feishu!.config,
    chats: [{ chatId: 'oc_team', listen: 'mentions' }] } } } }
  await expect(apps.save(next, 1)).rejects.toThrow('Subscription is already assigned')
  await apps.save(next, 1, true)
  expect(runtime.store.settings().sources.feishu!.config.chats).toEqual([])
  expect(apps.get('shop').revision).toBe(2)
  await expect(apps.save(next, 1)).rejects.toThrow('Application changed')
  expect(() => apps.assertRepositoriesRetained([])).toThrow('is used by application')
})

it('rejects transferring a chat with active repository work', async () => {
  const { apps, config } = await setup()
  await fixture!.acceptedTicket(feishu('r1', 'Fix wording'))
  const next = { ...config, sources: { feishu: { ...config.sources.feishu!, config: { ...config.sources.feishu!.config,
    chats: [{ chatId: 'oc_team', listen: 'mentions' }] } } } }
  await expect(apps.save(next, 1, true)).rejects.toThrow('Stop active tickets')
})

it('requires repository permission before reading or dispatch, and records exact source revisions', async () => {
  const { apps, trigger, runtime } = await setup()
  apps.receive('shop', trigger())
  const task = apps.listTasks('shop')[0]!
  const api = vi.spyOn(Commands.prototype, 'api').mockImplementation((async (_schema: unknown, path?: string) => {
    if (path === '') return { default_branch: 'main' }
    if (path === 'commits/main') return { sha: 'revision123' }
    return 'export const checkout = true'
  }) as Commands['api'])
  const result = await apps.read(task, 'default', 'src/checkout.ts', 'file', new AbortController().signal)
  expect(result.revision).toBe('revision123')
  expect(api.mock.calls.at(-1)).toEqual(['contents/src/checkout.ts?ref=revision123', '-H', 'Accept: application/vnd.github.raw'])
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, feishu: { allowed: [] } } } })
  await expect(apps.read(task, 'default', 'src/checkout.ts', 'file', new AbortController().signal)).rejects.toThrow('not authorized')
  expect(() => apps.dispatch(task, 'default', 'Fix checkout', 'fix')).toThrow('not authorized')
  expect(() => apps.dispatch(task, 'unknown', 'Fix checkout', 'fix')).toThrow('outside this application')
})

it('creates an idempotent repository ticket with the original actor and no chat reply channels', async () => {
  const { apps, trigger, runtime } = await setup()
  apps.receive('shop', trigger())
  const task = apps.listTasks('shop')[0]!
  const child = apps.dispatch(task, 'default', 'Fix checkout only; add a regression test', 'fix')
  expect(apps.dispatch(apps.task('shop', task.id), 'default', 'Different duplicate text', 'fix').ticketId).toBe(child.ticketId)
  const ticket = runtime.store.tickets.get(child.ticketId)!
  expect(ticket.mandate.actor).toEqual(task.trigger.actor)
  expect(ticket.mandate.basis).toMatchObject({ via: 'application', applicationId: 'shop', taskId: task.id })
  expect(ticket.channels).toEqual([])
  expect(runtime.store.tickets.list().filter(t => t.id === child.ticketId)).toHaveLength(1)
  expect(() => apps.report(apps.task('shop', task.id), 'ready', 'Fixed')).toThrow('not ready')
  apps.stop('shop', task.id)
  expect(runtime.store.tickets.get(child.ticketId)!.ended?.outcome).toBe('stopped')
  expect(apps.authorized(ticket.mandate, 'default')).toBe(false)
})

it('uses a restricted diagnosis session, releases its slot on idle, and reports in the original chat', async () => {
  const { apps, trigger, mounted } = await setup()
  apps.receive('shop', trigger())
  await apps.tick()
  const task = apps.listTasks('shop')[0]!
  expect(apps.runningIds()).toEqual([task.id])
  const registered = fixture!.tools.get(task.sessionId)!
  expect([...registered.keys()]).toEqual(['application_read', 'application_context', 'application_dispatch', 'application_followup', 'application_report', 'application_stop'])
  const agent = fixture!.agents.get(task.sessionId) as unknown as Agent
  expect(agent.ctx.tools.presentAs).toHaveBeenCalledWith('native')
  const guards = vi.mocked(agent.ctx.tools.guard).mock.calls.map(([guard]) => guard)
  expect(guards.some(guard => guard({ name: 'subagent' } as never) === 'Only application diagnosis tools are available')).toBe(true)
  expect(guards.some(guard => guard({ name: 'bash' } as never) === 'Only application diagnosis tools are available')).toBe(true)
  const send = vi.spyOn(mounted.get('app')!.sources, 'send').mockResolvedValue('sent')
  await fixture!.runTool(task.sessionId, 'application_report', { state: 'waiting', summary: '请提供失败请求的响应。' })
  fixture!.agents.get(task.sessionId)!.status = 'idle'
  await Promise.resolve(); await Promise.resolve()
  await apps.tick()
  expect(apps.runningIds()).toEqual([])
  expect(send).toHaveBeenCalledOnce()
  await apps.tick()
  expect(send).toHaveBeenCalledOnce()
  expect(apps.task('shop', task.id).state).toBe('waiting')
})

it('disabling an application stops its active tasks and keeps the history', async () => {
  const { apps, config, trigger } = await setup()
  apps.receive('shop', trigger())
  const id = apps.listTasks('shop')[0]!.id
  await apps.save({ ...config, enabled: false }, 1)
  expect(apps.task('shop', id).state).toBe('stopped')
  expect(apps.receive('shop', trigger('b2'))).toBe('filtered')
})

it('accepts all three chat sources without assigning a repository identity to the app', async () => {
  const { apps, config, trigger, mounted } = await setup()
  vi.spyOn(DiscordApi.prototype, 'request').mockResolvedValue({ id: '123', bot: true, username: 'Shop Bot' })
  const secret = join(fixture!.directory, 'wecom.json')
  writeFileSync(secret, JSON.stringify({ botId: 'shopbot', secret: 'test-secret' }), { mode: 0o600 })
  await apps.save({ ...config, allowed: { ...config.allowed, discord: [{ id: '456' }], wecom: [{ id: 'alice' }] },
    sources: { ...config.sources, discord: { enabled: true, config: { tokenFile: '/tmp/test-discord-token', channels: [{ channelId: '789', listen: 'mentions' }] } },
      wecom: { enabled: true, config: { secretFile: secret, directMessages: false, otherChats: 'none', chats: [{ chatId: 'shopgroup' }] } } } }, 1)
  expect(apps.receive('shop', trigger())).toBe('stored')
  for (const [source, sender, meta] of [['discord', '456', { channelId: '789' }], ['wecom', 'alice', { chatId: 'shopgroup', direct: false }]] as const) {
    expect(apps.receive('shop', { ...trigger(source), source, actor: { source, id: sender }, threads: [{ source, id: source }], meta })).toBe('stored')
  }
  expect(apps.listTasks('shop')).toHaveLength(3)
  expect(() => mounted.get('app')!.context(feishuKind).deployment.repository).toThrow('no repository identity')
})

it('keeps an investigation immutable when a separately scoped fix follows it', async () => {
  const { apps, trigger, runtime } = await setup()
  apps.receive('shop', trigger())
  const task = apps.listTasks('shop')[0]!
  const investigation = apps.dispatch(task, 'default', 'Reproduce checkout without source edits', 'investigate')
  runtime.engine.report(investigation.ticketId, { state: 'ready', summary: 'Response field differs from frontend expectation' })
  const original = runtime.store.triggers.get(runtime.store.tickets.get(investigation.ticketId)!.origin.triggerId)!
  const fix = apps.dispatch(apps.task('shop', task.id), 'default', 'Fix the response field and test it', 'fix')
  expect(fix.ticketId).not.toBe(investigation.ticketId)
  expect(fix.investigations).toEqual([investigation.ticketId])
  expect(runtime.store.triggers.get(original.id)).toEqual(original)
  expect(runtime.store.tickets.get(fix.ticketId)!.origin.triggerId).not.toBe(original.id)
})

it('retries notification delivery without restarting finished diagnosis', async () => {
  const { apps, trigger, mounted } = await setup()
  apps.receive('shop', trigger())
  const task = apps.listTasks('shop')[0]!
  apps.report(task, 'ready', 'The request was diagnostic only; no code change was needed.')
  const send = vi.spyOn(mounted.get('app')!.sources, 'send').mockRejectedValue(new Error('temporary delivery failure'))
  await apps.tick()
  expect(apps.task('shop', task.id).state).toBe('ready')
  expect(apps.task('shop', task.id).deliveryError).toBe('temporary delivery failure')
  send.mockResolvedValue('sent')
  const saved = apps.task('shop', task.id)
  saved.deliveryRetryAt = 0
  fixture!.runtime.store.set(`application-task:${task.id}`, saved)
  await apps.tick()
  expect(send).toHaveBeenCalledTimes(2)
  expect(apps.task('shop', task.id).notifications[0]!.sent).toBe(true)
  expect(apps.runningIds()).toEqual([])
})

it('recovers a chat transfer interrupted between the repository save and the application commit', async () => {
  const { apps, config, runtime } = await setup()
  const next = { ...config, sources: { feishu: { ...config.sources.feishu!, config: { ...config.sources.feishu!.config,
    chats: [{ chatId: 'oc_team', listen: 'mentions' }] } } } }
  const original = runtime.store.set.bind(runtime.store)
  let interrupted = false
  const set = vi.spyOn(runtime.store, 'set').mockImplementation((k, value) => {
    if (k === 'application:shop' && !interrupted) { interrupted = true; throw new Error('simulated interruption') }
    original(k, value)
  })
  await expect(apps.save(next, 1, true)).rejects.toThrow('simulated interruption')
  set.mockRestore()
  await apps.tick()
  expect(apps.get('shop').revision).toBe(2)
  expect(runtime.store.settings().sources.feishu!.config.chats).toEqual([])
  expect(runtime.store.get('application-transfer')).toBeUndefined()
})

it('exposes global application APIs, revision conflicts and missing-task errors', async () => {
  const { apps, trigger, config } = await setup()
  apps.receive('shop', trigger())
  const list = await fixture!.api('GET', 'applications')
  expect(list.status).toBe(200)
  const missing = await fixture!.api('GET', 'applications/shop/tasks/missing')
  expect(missing.status).toBe(404)
  const conflict = await fixture!.api('PUT', 'applications/shop', { value: config, revision: 0 })
  expect(conflict.status).toBe(409)
})

it('waits for a backend result before dispatching its dependent frontend fix and exposes PR links', async () => {
  const { apps, config, trigger, repositories, runtime } = await setup()
  const backend = await startRuntime(undefined, { repositoryId: 'backend' }, { applications: () => apps })
  others.push(backend)
  const settings = backend.runtime.store.settings()
  backend.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources,
    github: { enabled: true, config: { ...settings.sources.github!.config, repository: 'acme/backend' } },
    feishu: { enabled: true, config: { ...settings.sources.feishu!.config, chats: [], directMessages: false } } } })
  repositories.push({ id: 'backend', runtime: backend.runtime })
  await apps.save({ ...config, repositories: ['default', 'backend'] }, 1)
  apps.receive('shop', trigger())
  const task = apps.listTasks('shop')[0]!
  const back = apps.dispatch(task, 'backend', 'Correct the response contract', 'fix')
  const front = apps.dispatch(apps.task('shop', task.id), 'default', 'Adapt to the corrected contract', 'fix', ['backend'])
  expect(runtime.store.tickets.get(front.ticketId)).toBeUndefined()
  backend.runtime.engine.report(back.ticketId, { state: 'ready', summary: 'Backend contract verified by its tests' })
  await apps.tick()
  expect(runtime.store.tickets.get(front.ticketId)).toBeDefined()
  runtime.engine.bindThread(front.ticketId, { source: 'github', id: '42' }, true)
  runtime.engine.report(front.ticketId, { state: 'ready', summary: 'Frontend tests pass; business flow awaits deployment' })
  expect(apps.listTasks('shop')[0]!.children.find(child => child.repositoryId === 'default')!.result!.pr!.url).toBe('https://github.com/acme/widgets/pull/42')
})

it('restores an interrupted diagnosis and reuses its persisted session after restart', async () => {
  const { trigger, host } = await setup()
  apps!.receive('shop', trigger())
  await apps!.tick()
  const before = apps!.listTasks('shop')[0]!
  expect(before.state).toBe('investigating')
  await apps!.close()
  apps = new Applications(host)
  await apps.start()
  const restored = apps.task('shop', before.id)
  expect(restored.state).toBe('queued')
  expect(restored.sessionId).toBe(before.sessionId)
  expect(restored.version).toBeGreaterThan(before.version)
  await apps.tick()
  expect(apps.runningIds()).toEqual([before.id])
})
