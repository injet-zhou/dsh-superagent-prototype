import { expect, it, vi } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { installScopedEnvironment, withExecutionEnvironment } from '../src/infra/scoped-environment.ts'

it('keeps interleaved tool launches, async descendants and explicit control-plane launches in their own environments', async () => {
  const spawn = vi.fn((spec: { env?: NodeJS.ProcessEnv }) => spec.env)
  const service = { spawn, resolveExecutable: vi.fn(), spawnTerminal: vi.fn() } as unknown as SubprocessRuntime
  const restore = installScopedEnvironment(service)
  const before = { ...process.env }
  const a = Promise.withResolvers<void>(), b = Promise.withResolvers<void>()
  try {
    const first = withExecutionEnvironment({ PATH: '/repo-a/bin', GIT_CONFIG_GLOBAL: '/repo-a/git', GITHUB_TOKEN: undefined }, async () => {
      await a.promise
      service.spawn({ env: { COMMAND: 'a', GIT_CONFIG_GLOBAL: '/operator/git' } } as never)
      // A control-plane effect may inherit a tool's async context but supplies its own complete environment.
      withExecutionEnvironment({ PATH: '/repo-b/bin', GIT_CONFIG_GLOBAL: '/repo-b/git' }, () => service.spawn({} as never))
    })
    const second = withExecutionEnvironment({ PATH: '/repo-b/bin', GIT_CONFIG_GLOBAL: '/repo-b/git' }, async () => {
      await b.promise
      service.spawn({} as never)
    })
    b.resolve(); await second; a.resolve(); await first
    service.spawn({ env: { PATH: '/ordinary/bin' } } as never)
    expect(spawn.mock.calls.map(([spec]) => spec.env)).toEqual([
      { PATH: '/repo-b/bin', GIT_CONFIG_GLOBAL: '/repo-b/git' },
      { PATH: '/repo-a/bin', GIT_CONFIG_GLOBAL: '/repo-a/git', GITHUB_TOKEN: undefined, COMMAND: 'a' },
      { PATH: '/repo-b/bin', GIT_CONFIG_GLOBAL: '/repo-b/git' },
      { PATH: '/ordinary/bin' },
    ])
    expect(process.env).toEqual(before)
  } finally { restore() }
  expect(service.spawn).toBe(spawn)
})

it('keeps a shared seam installed until its last owner stops and rejects scoped PTYs', async () => {
  const service = { spawn: vi.fn(), resolveExecutable: vi.fn(), spawnTerminal: vi.fn() } as unknown as SubprocessRuntime
  const original = service.spawn
  const terminal = service.spawnTerminal
  const one = installScopedEnvironment(service, id => id === 'worker-managed'), two = installScopedEnvironment(service, id => id === 'router-managed')
  expect(() => service.spawnTerminal({ env: { DSH_SESSION_ID: 'worker-managed' } } as never)).toThrow('Interactive terminals')
  one(); one()
  expect(service.spawn).not.toBe(original)
  expect(() => withExecutionEnvironment({}, () => service.spawnTerminal({} as never))).toThrow('Interactive terminals')
  // UI terminal controller calls outside tools/execute still carry the Session identity.
  expect(() => service.spawnTerminal({ env: { DSH_SESSION_ID: 'router-managed' } } as never)).toThrow('Interactive terminals')
  await service.spawnTerminal({ env: { DSH_SESSION_ID: 'personal-session' } } as never)
  await service.spawnTerminal({} as never)
  expect(terminal).toHaveBeenCalledTimes(2)
  two()
  expect(service.spawn).toBe(original)
})
