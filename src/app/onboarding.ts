/** Read-only onboarding discovery and workspace checks. No user shell command is executed. */
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { WorkspaceCheck } from '../workspace.ts'
import type { Store } from './store.ts'
import { preview } from './views/text.ts'

export function wecomDiscovery(store: Store) {
  return store.read.triggers({ source: 'wecom' }, 0, 50).items.map(trigger => ({
    id: trigger.id, at: trigger.at, preview: preview(trigger.text, 160),
    userId: trigger.actor.id, chatId: trigger.meta.direct === true ? '' : String(trigger.meta.chatId ?? ''),
    filtered: !!store.triggers.disposition(trigger.id)?.filtered,
  }))
}

export async function checkWorkspace(path: string, root: string, deployment: Deployment,
  subprocess: SubprocessRuntime, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<WorkspaceCheck> {
  const fail = (code: WorkspaceCheck['code']): WorkspaceCheck => ({ ok: false, code })
  if (!isAbsolute(path)) return fail('path')
  const run = (args: string[]) => runAsWorker(subprocess, ['git', ...args], path,
    AbortSignal.any([signal, AbortSignal.timeout(15_000)]), env)
  let common: string
  try {
    const top = (await run(['rev-parse', '--show-toplevel'])).trim()
    if (await realpath(top) !== await realpath(path)) return fail('repository')
    common = resolve(path, (await run(['rev-parse', '--git-common-dir'])).trim())
  } catch { return fail('repository') }
  try {
    const remote = (await run(['remote', 'get-url', 'origin'])).trim()
    const base = deployment.github.baseUrl ?? 'https://github.com'
    const expected = new URL(`${base}/${deployment.repository}`)
    // Match the same standard SSH forms that the worker environment rewrites to HTTPS.
    const ssh = /^git@([^:]+):(.+)$/.exec(remote) ?? /^ssh:\/\/git@([^/:]+)\/(.+)$/.exec(remote)
    const actual = ssh ? new URL(`${base}/${ssh[2]}`) : new URL(remote)
    if (ssh && ssh[1] !== expected.hostname || actual.username || actual.password || actual.search || actual.hash
      || actual.origin !== expected.origin || actual.pathname.replace(/\.git$/, '') !== expected.pathname) return fail('remote')
  } catch { return fail('remote') }
  try { await verifyDirectory(path, subprocess, signal, env) } catch { return fail('credentials') }
  try {
    await access(common, constants.R_OK | constants.W_OK | constants.X_OK)
    // The default ticket root need not exist yet; check its closest existing ancestor.
    let parent = root
    while (true) {
      try {
        if (!(await stat(parent)).isDirectory()) return fail('writable')
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error
        parent = dirname(parent)
      }
    }
    await access(parent, constants.W_OK | constants.X_OK)
  } catch { return fail('writable') }
  return { ok: true, code: 'ready' }
}
