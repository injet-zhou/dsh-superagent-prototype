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
  expect(catalog.body).toMatchObject([{ id: 'default', repository: 'acme/widgets' }, { id: 'second', repository: 'acme/second' }])
  expect((await h.api('GET', `/orchestrator/repositories/second/api/tickets/${tickets[0]}`)).status).toBe(404)
  expect((await h.api('GET', '/orchestrator/repositories/missing/api/state')).status).toBe(404)
  expect((await h.api('POST', '/orchestrator/repositories/second/api/executor/pause', { paused: true })).status).toBe(200)
  expect(child.store.settings().paused).toBe(true)
  expect(h.runtime.store.settings().paused).toBe(false)

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
})
