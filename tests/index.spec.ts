import { expect, it, vi } from 'vitest'
import { Config, type Machine } from '../src/deployment.ts'
import { apply } from '../src/index.ts'

// Stub Runtime to capture the resolved Machine settings and restart callback.
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void; options: import('../src/app/runtime.ts').RuntimeOptions; stop: () => Promise<void> }[])
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  ready = Promise.resolve()
  constructor(_ctx: unknown, readonly machine: Machine, readonly restart: () => void, readonly options: import('../src/app/runtime.ts').RuntimeOptions) { runtimes.push(this) }
  configured() { return true }
  async stop() {}
} }))
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }

function context() {
  const handlers = new Map<string, () => void>()
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const ctx = {
    subprocess: { spawn: vi.fn(), resolveExecutable: vi.fn(), spawnTerminal: vi.fn() },
    isolate: vi.fn(() => ({ plugin: async (plugin: { apply: (child: unknown) => Promise<void> }) => plugin.apply({ effect: vi.fn() }) })),
    on: vi.fn((name: string, handler: () => void) => { handlers.set(name, handler) }),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => { callback({ effect: (effect: () => unknown) => effect(), settings: { configure } }) }),
    effect: vi.fn(),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    logger: { info: vi.fn(), error: vi.fn() },
  }
  return { ctx, handlers, configure, describe }
}

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const config = Config({ stateDir: '/srv/state', promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = runtimes.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(handlers.has('loader/volatile-update')).toBe(false)
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('asks DSH to read its settings entry again once a restart it started finished', async () => {
  const { ctx, describe } = context()
  let finish = () => {}
  ctx.fiber.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  // Saving a Source account change restarts dsh-superagent, which re-runs setup and refreshes the settings descriptor.
  runtimes.at(-1)!.restart()
  await Promise.resolve()
  expect(describe).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state', github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on the GitHub Source)')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
})

it('adds isolated local repositories without relocating the existing default state', async () => {
  const { ctx } = context()
  const before = runtimes.length
  const spawn = ctx.subprocess.spawn
  await apply(ctx as never, Config({ stateDir: '/srv/state', repositories: [{ id: 'backend', name: 'Backend' }] }))
  const [primary, backend] = runtimes.slice(before)
  expect(primary!.machine.stateDir).toBe('/srv/state')
  expect(primary!.machine.scopedEnvironment).toBe(true)
  expect(backend!.machine).toMatchObject({ stateDir: '/srv/state/repositories/backend', repositoryId: 'backend', scopedEnvironment: true })
  expect(ctx.isolate).toHaveBeenCalledExactlyOnceWith('orchestrator')
  expect(primary!.options.repositories!().map(entry => entry.id)).toEqual(['default', 'backend'])
  expect(primary!.options.slots).toBe(backend!.options.slots)
  const dispose = ctx.effect.mock.calls.at(-1)![0] as () => () => Promise<void>
  await dispose()()
  expect(ctx.subprocess.spawn).toBe(spawn)
})

it('rejects duplicate and reserved repository IDs before mounting any services', async () => {
  for (const repositories of [[{ id: 'default' }], [{ id: 'backend' }, { id: 'backend' }]]) {
    const { ctx } = context()
    await expect(apply(ctx as never, Config({ stateDir: '/srv/state', repositories }))).rejects.toThrow('duplicate repository id')
    expect(ctx.inject).not.toHaveBeenCalled()
  }
})
