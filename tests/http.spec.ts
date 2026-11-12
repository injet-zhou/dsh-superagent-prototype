import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1', repositories?: Parameters<typeof registerHttp>[2]) {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost, repositories)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

function catalogHost() {
  const settings = SettingsSchema.parse({})
  const host = { store: { settings: vi.fn(() => settings), tickets: { open: vi.fn(() => []) } },
    executor: { activeCount: vi.fn(() => 2) }, health: { runtime: { state: 'ready', detail: '' } },
    configured: () => true, deployment: { repository: 'acme/widgets' }, globalLoad: vi.fn(() => { throw new Error('Must reuse the catalog snapshot') }) }
  return { host, settings }
}

it('reads each repository once and derives global usage from the same snapshots', async () => {
  const hosts = Array.from({ length: 4 }, catalogHost)
  const repositories = hosts.map(({ host }, index) => ({ id: index ? `repo-${index}` : 'default', name: `Repository ${index}`, host: host as unknown as HttpHost }))
  const call = serve(hosts[0]!.host, '127.0.0.1', () => repositories)
  const result = await call('GET', 'repositories')
  expect(result.status).toBe(200)
  expect(result.body).toHaveLength(4)
  for (const { host } of hosts) {
    expect(host.store.settings).toHaveBeenCalledTimes(1)
    expect(host.store.tickets.open).toHaveBeenCalledTimes(1)
    expect(host.executor.activeCount).toHaveBeenCalledExactlyOnceWith([])
    expect(host.globalLoad).not.toHaveBeenCalled()
  }
  expect(result.body).toMatchObject(hosts.map(() => ({ globalLoad: { running: 8, maxWorkers: 3 } })))
})

it('keeps a failing repository in a successful catalog while healthy repositories stay readable', async () => {
  const { host } = catalogHost(), { host: broken } = catalogHost()
  broken.store.settings.mockImplementationOnce(() => { throw new Error('Cannot read database') })
  const call = serve(host, '127.0.0.1', () => [{ id: 'default', name: 'Default', host: host as unknown as HttpHost },
    { id: 'broken', name: 'Broken', host: broken as unknown as HttpHost }])
  expect(await call('GET', 'repositories')).toMatchObject({ status: 200, body: [
    { id: 'default', state: 'ready', load: { running: 2 } }, { id: 'broken', state: 'error', error: 'Cannot read database' },
  ] })
  expect((await call('GET', 'repositories')).body).toMatchObject([{ state: 'ready' }, { state: 'ready' }])
})

it('reports required setup and retained entry errors ahead of a paused or ready runtime', async () => {
  const { host } = catalogHost()
  host.health.runtime.state = 'paused'
  const problem = new SetupError('repositoryUnset').problem
  const call = serve({ ...host, setupProblem: problem })
  expect((await call('GET', 'repositories')).body).toMatchObject([{ state: 'error', problems: [problem] }])
  const retained = serve(host, '127.0.0.1', () => [{ id: 'default', name: 'Default', host: host as unknown as HttpHost, error: 'Startup failed' }])
  expect((await retained('GET', 'repositories')).body).toMatchObject([{ state: 'error', error: 'Startup failed' }])
})

it('ignores disabled optional bot setup and stale bot health errors', async () => {
  const { host, settings } = catalogHost()
  settings.sources.feishu = { enabled: false, config: {} }
  settings.sources.discord = { enabled: false, config: {} }
  const call = serve({ ...host, feishuProblem: new SetupError('feishuNoBot').problem, discordProblem: new SetupError('discordBotFailed').problem,
    health: { ...host.health, feishu: { state: 'error', detail: 'Old Feishu failure' }, discord: { state: 'error', detail: 'Old Discord failure' } } })
  expect((await call('GET', 'repositories')).body).toMatchObject([{ state: 'ready', health: { runtime: { state: 'ready' } } }])
  settings.sources.feishu.enabled = true
  expect((await call('GET', 'repositories')).body).toMatchObject([{ state: 'error', problems: [{ code: 'feishuNoBot' }] }])
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full; secret=private-server-value')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'Internal server error' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
