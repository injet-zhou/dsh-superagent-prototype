/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { join } from 'node:path'
import { WorkerSlots } from './executor/dsh.ts'
import { installScopedEnvironment } from './infra/scoped-environment.ts'
import { assertRepositoryIsolation } from './app/repository-isolation.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  const ids = new Set(['default'])
  for (const entry of config.repositories) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(entry.id) || ids.has(entry.id)) throw new Error(`Invalid or duplicate repository id: ${entry.id}`)
    ids.add(entry.id)
  }
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const repositories: { id: string; name: string; runtime: Runtime }[] = []
  const multi = config.repositories.length > 0
  const restore = multi ? installScopedEnvironment(ctx.subprocess) : () => {}
  const slots = multi ? new WorkerSlots(() => repositories.flatMap(entry => entry.runtime.executor.activeTicketIds()),
    () => repositories[0]!.runtime.store.settings().executor.maxWorkers, 0) : undefined
  const validateSettings = (id: string) => (settings: import('./policy.ts').Settings) => {
    assertRepositoryIsolation([...repositories.filter(entry => entry.id !== id).map(entry => ({ id: entry.id, settings: entry.runtime.store.settings() })), { id, settings }])
  }
  try {
    const runtime = new Runtime(ctx, { ...machine, ...multi ? { scopedEnvironment: true } : {} }, restart,
      { repositories: () => repositories, ...slots ? { slots } : {}, validateSettings: validateSettings('default') })
    repositories.push({ id: 'default', name: 'Default', runtime })
    for (const { id, name } of config.repositories) {
      // Separate fibers are required as well as service labels: Cordis keeps each fiber's own services by name.
      await ctx.isolate('orchestrator').plugin({ name: `dsh-superagent-repository-${id}`, inject, apply: async child => {
        const runtime = new Runtime(child, { ...machine, stateDir: join(machine.stateDir, 'repositories', id), repositoryId: id, scopedEnvironment: true }, restart,
          { http: false, ...slots ? { slots } : {}, validateSettings: validateSettings(id) })
        repositories.push({ id, name: name || id, runtime })
        child.effect(() => () => runtime.stop())
        await runtime.ready
      } })
    }
    ctx.effect(() => async () => {
      try {
        const stopped = await Promise.allSettled([...repositories].reverse().map(entry => entry.runtime.stop()))
        const errors = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Some repository runtimes could not stop')
      }
      finally { restore() }
    })
    await Promise.all(repositories.map(entry => entry.runtime.ready))
  } catch (error) {
    await Promise.allSettled(repositories.map(entry => entry.runtime.stop()))
    restore()
    throw error
  }
  const runtime = repositories[0]!.runtime
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
