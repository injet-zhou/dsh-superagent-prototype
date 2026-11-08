import { expect, it, onTestFinished, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Runtime } from '../src/app/runtime.ts'
import { Store } from '../src/app/store.ts'
import { assertRepositoryIsolation } from '../src/app/repository-isolation.ts'
import { SettingsSchema } from '../src/policy.ts'
import { githubKind, apply as applyGithub } from '../src/sources/github.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { installScopedEnvironment } from '../src/infra/scoped-environment.ts'
import type { Trigger } from '../src/core/index.ts'
import { WorkerSlots } from '../src/executor/dsh.ts'
import { apply as applySuperagent, inject as superagentDependencies, Config } from '../src/index.ts'
import { startRuntime } from './fixtures/host.ts'
import { testMachine } from './fixtures/deployment.ts'
import { lockSync } from 'proper-lockfile'
import { Commands } from '../src/infra/commands.ts'

it('isolates identical Issue IDs, Sessions, callbacks and management mutations on one DSH host', async () => {
  const entries: { id: string; name: string; runtime: Runtime }[] = []
  const before = { ...process.env }
  const h = await startRuntime(undefined, { scopedEnvironment: true }, { repositories: () => entries })
  onTestFinished(() => h.stop())
  entries.push({ id: 'default', name: 'Primary', runtime: h.runtime })
  const stateDir = join(h.directory, 'repositories', 'second')
  mkdirSync(stateDir, { recursive: true })
  const cli = join(h.directory, 'second-gh')
  writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  h.answers[`${cli} api user`] = '{"login":"second-bot","id":8}'
  const seeded = new Store(join(stateDir, 'orchestrator.sqlite'))
  seeded.saveSettings(SettingsSchema.parse({ ...h.runtime.store.settings(), sources: {
    github: { enabled: true, config: { repository: 'acme/second', cli } },
  } }))
  seeded.close()
  h.answers[`${cli} api repos/acme/second --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/second","push":true}'
  h.answers['git config -z --show-origin --get-all credential.https://github.com.helper'] = `file:${workerGitConfig(stateDir)}\0${credentialHelper(cli)}\0`
  const child = new Runtime(h.ctx.isolate('orchestrator'), testMachine({ stateDir, repositoryId: 'second', scopedEnvironment: true }), vi.fn(), { http: false })
  onTestFinished(() => child.stop())
  entries.push({ id: 'second', name: 'Second', runtime: child })
  await child.ready
  child.sources.register(githubKind)
  expect(child.configured()).toBe(true)
  expect(process.env).toEqual(before)
  const trigger: Trigger = { id: 'issue-12', source: 'github', threads: [{ source: 'github', id: '12' }],
    actor: { source: 'github', id: 'alice' }, human: true, addressed: 'mention', at: '2026-11-07T00:00:00.000Z',
    text: '@agent-bot fix this', meta: { number: 12, kind: 'issue' } }
  const tickets = []
  for (const runtime of [h.runtime, child]) {
    runtime.receive(trigger)
    const decision = runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Fix', scope: 'Fix this issue', reason: 'Requested', name: 'fix-issue' })
    tickets.push(decision.ticketId!)
    await runtime.idle()
  }
  expect(tickets[0]).not.toBe(tickets[1])
  expect(h.agents.has(`worker-${tickets[0]}`)).toBe(true)
  expect(h.agents.has(`worker-${tickets[1]}`)).toBe(true)
  expect(child.store.tickets.get(tickets[0]!)).toBeUndefined()
  expect(h.runtime.store.tickets.get(tickets[1]!)).toBeUndefined()
  const catalog = await h.api('GET', 'repositories')
  expect(catalog.body).toMatchObject([{ id: 'default', repository: 'acme/widgets', load: { running: 1, queued: 0, maxWorkers: 3 }, attention: 0 },
    { id: 'second', repository: 'acme/second', load: { running: 1, queued: 0, maxWorkers: 3 }, attention: 0 }])
  expect((await h.api('GET', '/orchestrator/repositories/second/api/repositories')).body).toEqual(catalog.body)
  expect((await h.api('GET', `/orchestrator/repositories/second/api/tickets/${tickets[0]}`)).status).toBe(404)
  expect((await h.api('GET', '/orchestrator/repositories/missing/api/state')).status).toBe(404)
  expect((await h.api('POST', '/orchestrator/repositories/second/api/executor/pause', { paused: true })).status).toBe(200)
  expect(child.store.settings().paused).toBe(true)
  expect(h.runtime.store.settings().paused).toBe(false)
  expect((await h.api('GET', 'repositories')).body).toMatchObject([{ state: 'ready' }, { state: 'paused' }])
  const personal = (runtime: Runtime) => (runtime.executor as unknown as { personal: Map<string, string> }).personal
  const agent = h.agents.get(`worker-${tickets[1]}`)!
  h.ctx.emit('agent/inbox/claimed', { agent, message: { source: { kind: 'user' } } } as never)
  expect(personal(h.runtime).has(tickets[1]!)).toBe(false)
  expect(personal(child).has(tickets[1]!)).toBe(true)

  const launches = h.subprocess.spawn
  const restore = installScopedEnvironment(h.ctx.subprocess)
  try {
    for (const [index, runtime] of [h.runtime, child].entries()) {
      const agent = h.agents.get(`worker-${tickets[index]}`) as unknown as { ctx: Context }
      await agent.ctx.waterfall('tools/execute', {} as never, async () => {
        h.ctx.subprocess.spawn({ argv: ['probe'], cwd: '/', graceMs: 0, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
        return { content: [] } as never
      })
      const spec = launches.mock.calls.at(-1)![0] as { env?: NodeJS.ProcessEnv }
      expect(spec.env?.GIT_CONFIG_GLOBAL).toBe(workerGitConfig(runtime.machine.stateDir))
      expect(spec.env?.DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe(runtime.deployment.repository)
      expect(spec.env?.DSH_SUPERAGENT_GITHUB_ACCOUNT).toBe(runtime.deployment.github.login)
    }
  } finally { restore() }
  h.ctx.emit('agent/disposed', { agent } as never)
  expect(personal(child).size).toBe(0)
  h.runtime.engine.stopTicket(tickets[0]!)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(tickets[0]!)?.ended?.outcome).toBe('stopped')
  expect(child.store.tickets.get(tickets[1]!)?.ended).toBeUndefined()
})

it('mounts the repository Source adapter for every local repository context', async () => {
  const hosts = [0, 1].map(() => ({ sources: { register: vi.fn(() => () => {}) },
    context: vi.fn(() => ({ ready: Promise.resolve(), configured: () => false, report: vi.fn() })) }))
  const disposers: (() => unknown)[] = []
  applyGithub({ orchestrator: { repositoryHosts: () => hosts }, effect: (start: () => () => unknown) => { disposers.push(start()) } } as never)
  for (const host of hosts) {
    expect(host.sources.register).toHaveBeenCalledExactlyOnceWith(githubKind)
    expect(host.context).toHaveBeenCalledExactlyOnceWith(githubKind)
  }
  await Promise.all(disposers.reverse().map(dispose => dispose()))
})

it('keeps the default service visible to dependent plugins when additional repositories have their own Cordis fibers', async () => {
  const h = await startRuntime(undefined, { scopedEnvironment: true })
  onTestFinished(() => h.stop())
  for (const name of ['tools', 'systemPrompt', 'skills']) h.ctx.reflect.provide(name, {})
  let owner!: Context
  const fiber = h.ctx.isolate('orchestrator').plugin({ name: 'test-multi-repository', inject: superagentDependencies,
    apply: async ctx => {
      owner = ctx
      await applySuperagent(ctx, Config({ stateDir: join(h.directory, 'workspace'), repositories: [{ id: 'backend' }] }))
    } })
  onTestFinished(async () => { await fiber.dispose() })
  await fiber
  expect(owner.orchestrator.repositoryHosts!()).toHaveLength(2)
  await owner.plugin({ name: 'test-repository-source', inject: ['orchestrator'], apply: applyGithub })
  for (const runtime of owner.orchestrator.repositoryHosts!()) expect(runtime.sources.kind('github')).toBeDefined()
  expect((await h.api('GET', 'repositories')).body).toMatchObject([{ id: 'default', configured: false }, { id: 'backend', configured: false }])
})

it('prevents one repository taking another repository’s reserved or running execution slots', () => {
  const running: string[] = []
  const shared = new WorkerSlots(() => running, () => 2, 0)
  const first = new WorkerSlots(() => running.filter(id => id.startsWith('a')), () => 1, 0, shared)
  const second = new WorkerSlots(() => running.filter(id => id.startsWith('b')), () => 4, 0, shared)
  first.reserve('a1', 'launch')
  second.reserve('b1', 'launch')
  expect(() => first.reserve('a2', 'launch')).toThrow('No worker slot')
  expect(() => second.reserve('b2', 'person')).toThrow('No worker slot')
  running.push('a1'); first.free('a1')
  expect(() => second.reserve('b2', 'launch')).toThrow('No worker slot')
  running.pop()
  second.reserve('b2', 'launch')
})

it('rejects duplicate repository subscriptions and shared IM destinations, including concurrent save rechecks', () => {
  const settings = (config: unknown) => SettingsSchema.parse(config)
  const entry = { id: 'a', settings: settings({ sources: { github: { enabled: true, config: { repository: 'Acme/Widgets' } } } }) }
  expect(() => assertRepositoryIsolation([entry, { id: 'b', settings: settings({ sources: { github: { enabled: true, config: { repository: 'acme/widgets', provider: 'github' } } } }) }])).toThrow('already assigned')
  expect(() => assertRepositoryIsolation([entry, { id: 'b', settings: settings({ sources: { github: { enabled: true, config: { repository: 'acme/widgets', provider: 'gitea', baseUrl: 'https://git.example.com' } } } }) }])).not.toThrow()
  const im = settings({ sources: { discord: { enabled: true, config: { channels: [{ channelId: '123456' }] } } } })
  expect(() => assertRepositoryIsolation([{ id: 'a', settings: im }, { id: 'b', settings: im }])).toThrow('already assigned')
  const wildcard = settings({ sources: { feishu: { enabled: true, config: { otherChats: 'mentions' } } } })
  expect(() => assertRepositoryIsolation([{ id: 'a', settings: wildcard }], true)).toThrow('explicit chat lists')
  expect(() => assertRepositoryIsolation([{ id: 'a', settings: wildcard }], false)).not.toThrow()
})

it('starts default and fast Sources while another setup is pending and a locked repository reports a catalog error', async () => {
  const h = await startRuntime(undefined, { scopedEnvironment: true })
  onTestFinished(() => h.stop())
  for (const name of ['tools', 'systemPrompt', 'skills']) h.ctx.reflect.provide(name, {})
  const stateDir = join(h.directory, 'independent')
  const slow = Promise.withResolvers<void>()
  let waiting = false
  const original = h.subprocess.spawn.getMockImplementation()!
  h.subprocess.spawn.mockImplementation(spec => {
    const result = original(spec)
    if (spec.argv.includes('repos/acme/slow')) { waiting = true; return { ...result, done: slow.promise.then(() => ({ exitCode: 0, signal: null })) } }
    return result
  })
  const cli = join(h.directory, 'agent-gh')
  for (const [id, repository] of [['default', 'acme/widgets'], ['slow', 'acme/slow'], ['fast', 'acme/fast']]) {
    const dir = id === 'default' ? stateDir : join(stateDir, 'repositories', id!)
    mkdirSync(dir, { recursive: true })
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { github: { enabled: true, config: { repository, cli } } } }))
    store.close()
    h.answers[`${cli} api repos/${repository} --jq {name: .full_name, push: .permissions.push}`] = JSON.stringify({ name: repository, push: true })
  }
  const locked = join(stateDir, 'repositories', 'locked')
  mkdirSync(locked, { recursive: true })
  const release = lockSync(locked)
  const invalid = new Store(join(stateDir, 'repositories', 'invalid', 'orchestrator.sqlite'))
  invalid.saveSettings(SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { otherChats: 'mentions' } } } }))
  invalid.close()
  const spawn = h.subprocess.spawn
  // Every setup checks its own generated gitconfig rather than the fixture's default path.
  spawn.mockImplementation(spec => {
    const result = original(spec)
    if (spec.argv.includes('repos/acme/slow')) { waiting = true; return { ...result, done: slow.promise.then(() => ({ exitCode: 0, signal: null })) } }
    if (spec.argv.includes('credential.https://github.com.helper')) {
      const env = (spec as { env?: NodeJS.ProcessEnv }).env
      const text = `file:${env?.GIT_CONFIG_GLOBAL}\0${credentialHelper(cli)}\0`
      return { ...result, collected: { ...result.collected, stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) } } }
    }
    return result
  })
  vi.spyOn(Commands.prototype, 'api').mockResolvedValue('HTTP/1.1 200 OK\r\n\r\n[]')
  let owner!: Context
  const fiber = h.ctx.isolate('orchestrator').plugin({ name: 'test-independent', inject: superagentDependencies, apply: async ctx => {
    owner = ctx
    await applySuperagent(ctx, Config({ stateDir, repositories: [{ id: 'slow' }, { id: 'locked' }, { id: 'invalid' }, { id: 'fast' }] }))
  } })
  onTestFinished(async () => { slow.resolve(); await fiber.dispose(); release() })
  await fiber
  await owner.plugin({ name: 'test-independent-sources', inject: ['orchestrator'], apply: applyGithub })
  await vi.waitFor(async () => {
    expect(waiting).toBe(true)
    const catalog = (await h.api('GET', 'repositories')).body as unknown as { id: string; configured: boolean; state: string; error?: string; health: Record<string, { state: string }> }[]
    expect(catalog.find(entry => entry.id === 'default')?.configured).toBe(true)
    expect(catalog.find(entry => entry.id === 'fast')?.configured).toBe(true)
    expect(catalog.find(entry => entry.id === 'slow')?.state).toBe('starting')
    expect(catalog.find(entry => entry.id === 'locked')?.error).toMatch(/lock/i)
    expect(catalog.find(entry => entry.id === 'invalid')).toMatchObject({ configured: false, state: 'error',
      health: { runtime: { state: 'error' } } })
    expect(catalog.find(entry => entry.id === 'default')?.health.github?.state).toBe('ready')
    expect(catalog.find(entry => entry.id === 'fast')?.health.github?.state).toBe('ready')
  })
  const state = await h.api('GET', 'state')
  expect((state.body.health as Record<string, { state: string }>)['repository:locked']?.state).toBe('error')
  expect(state.body.globalLoad).toMatchObject({ running: 0 })
  expect((await h.api('GET', '/orchestrator/repositories/slow/api/state')).body.health).toMatchObject({ runtime: { state: 'starting' } })
  expect((await h.api('POST', '/orchestrator/repositories/slow/api/executor/pause', { paused: true })).status).toBe(503)
  expect((await h.api('GET', '/orchestrator/repositories/locked/api/state')).status).toBe(503)
})
