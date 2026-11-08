/** Per-tool execution environments for local repositories sharing one DSH process. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const environments = new AsyncLocalStorage<NodeJS.ProcessEnv>()
const installed = new WeakMap<SubprocessRuntime, { owners: Set<(id: string) => boolean>; restore: () => void }>()

/** Async descendants, including background launches, inherit this tool's environment. */
export function withExecutionEnvironment<T>(env: NodeJS.ProcessEnv, work: () => T): T {
  return environments.run(env, work)
}

/** Install once on the host seam; unrelated DSH Sessions retain their original behavior. */
export function installScopedEnvironment(subprocess: SubprocessRuntime, managedSession: (id: string) => boolean = () => false): () => void {
  let installation = installed.get(subprocess)
  if (!installation) {
    const { spawn, resolveExecutable, spawnTerminal } = subprocess
    const owners = new Set<(id: string) => boolean>()
    subprocess.spawn = function (spec) {
      const env = environments.getStore()
      return spawn.call(this, env ? { ...spec, env: { ...spec.env, ...env } } : spec)
    }
    subprocess.resolveExecutable = function (command, env, signal) {
      const scoped = environments.getStore()
      const merged = scoped ? Object.fromEntries(Object.entries({ ...env, ...scoped }).filter((entry): entry is [string, string] => entry[1] !== undefined)) : env
      return resolveExecutable.call(this, command, merged, signal)
    }
    subprocess.spawnTerminal = function (spec) {
      const sessionId = spec.env?.DSH_SESSION_ID
      if (environments.getStore() || (sessionId && [...owners].some(owns => owns(sessionId)))) throw new Error('Interactive terminals are not supported in multi-repository Sessions; use bash or pwsh')
      return spawnTerminal.call(this, spec)
    }
    installation = { owners, restore: () => { subprocess.spawn = spawn; subprocess.resolveExecutable = resolveExecutable; subprocess.spawnTerminal = spawnTerminal } }
    installed.set(subprocess, installation)
  }
  const owner = (id: string) => managedSession(id)
  installation.owners.add(owner)
  let released = false
  return () => {
    if (released) return
    released = true
    installation.owners.delete(owner)
    if (!installation.owners.size) { installation.restore(); installed.delete(subprocess) }
  }
}
