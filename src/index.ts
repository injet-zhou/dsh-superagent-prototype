/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { join } from 'node:path'
import type { RepositoryMount, SourceDisposer } from './sources/host.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { WorkerSlots, ticketOfSession } from './executor/dsh.ts'
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
  const repositories: { id: string; name: string; runtime?: Runtime; error?: string }[] = [
    { id: 'default', name: 'Default' }, ...config.repositories.map(({ id, name }) => ({ id, name: name || id })),
  ]
  const watchers = new Set<{ mount: RepositoryMount; disposers: Map<Runtime, SourceDisposer> }>()
  const publish = (runtime: Runtime) => {
    for (const watcher of watchers) watcher.disposers.set(runtime, watcher.mount(runtime))
  }
  const watchRepositories = (mount: RepositoryMount) => {
    const watcher = { mount, disposers: new Map<Runtime, SourceDisposer>() }
    for (const entry of repositories) if (entry.runtime) watcher.disposers.set(entry.runtime, mount(entry.runtime))
    watchers.add(watcher)
    return async () => { watchers.delete(watcher); await Promise.all([...watcher.disposers.values()].map(dispose => dispose())) }
  }
  const multi = config.repositories.length > 0
  const managedSession = (id: string): boolean => {
    for (let depth = 0; id && depth < 16; depth++) {
      if (repositories.some(({ runtime }) => runtime && (runtime.masterId === id || !!runtime.store.tickets.get(ticketOfSession(id) ?? '')))) return true
      id = String(ctx.agents.get(id as SessionId)?.session.header.parentSession ?? '')
    }
    return false
  }
  const restore = multi ? installScopedEnvironment(ctx.subprocess, managedSession) : () => {}
  const slots = multi ? new WorkerSlots(() => repositories.flatMap(entry => entry.runtime?.executor.activeTicketIds() ?? []),
    () => repositories[0]!.runtime?.store.settings().executor.maxWorkers ?? 0, 0) : undefined
  const globalLoad = () => ({ running: repositories.reduce((n, entry) => n + (entry.runtime?.executor.activeCount() ?? 0), 0),
    maxWorkers: repositories[0]!.runtime?.store.settings().executor.maxWorkers ?? 0 })
  const validateSettings = (id: string) => (settings: import('./policy.ts').Settings) => {
    const peers = repositories.flatMap(entry => {
      if (entry.id === id || !entry.runtime || entry.runtime.health.runtime?.state === 'error') return []
      const saved = entry.runtime.store.settings(), feishu = saved.sources.feishu
      // Invalid wildcard configurations cannot start; do not let their admission error poison other repositories.
      if (multi && feishu?.enabled && feishu.config.otherChats === 'mentions') return []
      return [{ id: entry.id, settings: saved }]
    })
    assertRepositoryIsolation([...peers, { id, settings }], multi)
  }
  const aggregateHealth = () => Object.fromEntries(repositories.slice(1).flatMap(entry => entry.error
    ? [[`repository:${entry.id}`, { state: 'error' as const, detail: entry.error }]]
    : Object.entries(entry.runtime?.health ?? {}).map(([key, value]) => [`repository:${entry.id}:${key}`, value])))
  let runtime: Runtime
  try {
    runtime = new Runtime(ctx, { ...machine, ...multi ? { scopedEnvironment: true } : {} }, restart,
      { repositories: () => repositories, watchRepositories, ...slots ? { slots, globalLoad, aggregateHealth } : {}, validateSettings: validateSettings('default') })
  } catch (error) { restore(); throw error }
  repositories[0]!.runtime = runtime
  ctx.effect(() => async () => {
    const active = repositories.flatMap(entry => entry.runtime ? [entry.runtime] : [])
    for (const entry of repositories) entry.runtime = undefined
    try {
      const disposers = [...watchers].flatMap(watcher => [...watcher.disposers.values()])
      watchers.clear()
      await Promise.allSettled(disposers.map(dispose => dispose()))
      const results = await Promise.allSettled(active.map(runtime => runtime.stop()))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Some repositories could not stop')
    }
    finally { restore() }
  })
  for (const entry of repositories.slice(1)) {
    // Do not await this fiber or Runtime.ready: each repository probes accounts independently.
    const fiber = ctx.isolate('orchestrator').plugin({ name: `dsh-superagent-repository-${entry.id}`, inject, apply: child => {
      try {
        const runtime = new Runtime(child, { ...machine, stateDir: join(machine.stateDir, 'repositories', entry.id), repositoryId: entry.id, scopedEnvironment: true }, restart,
          { http: false, ...slots ? { slots, globalLoad } : {}, validateSettings: validateSettings(entry.id) })
        entry.runtime = runtime
        child.effect(() => async () => {
          entry.runtime = undefined
          await Promise.all([...watchers].map(watcher => { const dispose = watcher.disposers.get(runtime); watcher.disposers.delete(runtime); return dispose?.() }))
          await runtime.stop()
        })
        publish(runtime)
      } catch (error) { entry.error = String(error); ctx.logger.error('Repository %s failed: %s', entry.id, entry.error) }
    } })
    void Promise.resolve(fiber).catch(error => { entry.error = String(error) })
  }
  if (!multi) await runtime.ready
  ctx.logger.info('dsh-superagent management is available; repositories initialize independently')
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
