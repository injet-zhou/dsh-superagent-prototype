/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { DiscordApi, DiscordUser } from './infra/discord.ts'
import { readWecomSecret } from './infra/wecom-secret.ts'
import { commandError } from './infra/commands.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
const RepositoryConfig: s<{ id?: string; name?: string }, { id: string; name: string }> = s.object({
  id: s.string().pattern(/^[a-z][a-z0-9-]{0,47}$/).required(), name: s.string().default(''),
})
/** Plugin configuration of the dsh-superagent entry. DSH settings can write volatile fields; limits apply live, while repository changes restart the plugin. Changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  repositories: s.array(RepositoryConfig).default([]).description('Additional local repositories. Each uses its own settings and state under stateDir/repositories/<id>.').volatile(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  /** Present only for additional repository runtimes; also namespaces newly generated Ticket IDs. */
  repositoryId?: string
  /** Multi-repository deployments inject execution environments without changing process.env. */
  scopedEnvironment?: boolean
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  provider: z.enum(['github', 'gitea', 'gitlab']).default('github'),
  baseUrl: z.string().trim().default(''),
  commitEmail: z.string().trim().default(''),
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)?$/, 'namespace/name').default(''),
  cli: z.string().trim().default(''),
})
export const DiscordBotSchema = z.object({ tokenFile: z.string().trim().refine(value => !value || isAbsolute(value), 'Expected an absolute token file path').default('') })
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** A WeCom robot's private secret file, and the WebSocket address of a private deployment. */
export const WecomBotSchema = z.object({
  secretFile: z.string().trim().refine(value => !value || isAbsolute(value), 'Expected an absolute secret file path').default(''),
  wsUrl: z.string().trim().refine(value => !value || /^wss:\/\/\S+$/.test(value), 'Expected a wss:// URL').default(''),
})
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape), discord: Object.keys(DiscordBotSchema.shape), wecom: Object.keys(WecomBotSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  /** Repository account. The legacy `github` key is retained for saved settings and Source identifiers. */
  github: { cli: string; login: string; noreply: string; provider?: 'github' | 'gitea' | 'gitlab'; baseUrl?: string }
  feishu?: FeishuBot
  discord?: { tokenFile: string; botId: string; name: string }
  wecom?: WecomBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
/** The resolved WeCom robot; its secret stays in `secretFile` and is read only when connecting. */
export interface WecomBot { secretFile: string; botId: string; wsUrl?: string }

/** Validates an instance root, including a reverse-proxy subpath, without accepting credentials or query strings. */
export function repositoryBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Set a valid repository instance root URL') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname.split('/').some(part => /%2f|%5c|%2e/i.test(part))) throw new Error('Expected an instance URL without credentials, query or fragment')
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)
  if (url.protocol !== 'https:' && !loopback) throw new Error('Repository access requires HTTPS; HTTP is allowed only on loopback hosts')
  if (/\/api\/v[14]\/?$/i.test(url.pathname)) throw new Error('Use the instance root without /api/v1 or /api/v4')
  return url.href.replace(/\/$/, '')
}

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const run = (argv: string[]) => probe(argv).catch((error: unknown) => { throw commandError(error, argv[0]) })
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  let baseUrl: string | undefined
  if (accounts.provider !== 'github') {
    try { baseUrl = repositoryBaseUrl(accounts.baseUrl) }
    catch (error) { throw new SetupError('baseUrlInvalid', { output: reason(error) }) }
  }
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (remote.split('/').some(part => part === '.' || part === '..') || (accounts.provider !== 'gitlab' && remote.split('/').length !== 2)) {
    throw new SetupError('repositoryUnreported', { repository: remote })
  }
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  if (baseUrl !== undefined) {
    try {
      const configured = parsed(z.object({ baseUrl: z.string() }), await run([cli, 'config']))
      if (!configured || repositoryBaseUrl(configured.baseUrl) !== baseUrl) throw new Error('Repository CLI configuration must use the same baseUrl as the Source')
    } catch (error) { throw new SetupError('agentCliSignedOut', { output: reason(error) }) }
    const text = await run([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
    if (accounts.provider === 'gitlab') {
      const agent = parsed(z.object({ username: z.string().regex(/^[A-Za-z0-9_.-]+$/), email: z.string().nullish() }), text)
      if (!agent) throw new SetupError('agentCliNoAccount')
      const access = parsed(z.object({ path_with_namespace: z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/), archived: z.boolean().optional(),
        permissions: z.object({ project_access: z.object({ access_level: z.number() }).nullish(), group_access: z.object({ access_level: z.number() }).nullish() }) }),
      await run([cli, 'api', `projects/${encodeURIComponent(remote)}`])
        .catch((error: unknown) => { throw new SetupError('repositoryUnreadable', { account: agent.username, repository: remote, output: reason(error) }) }))
      if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
      if (access.archived || Math.max(access.permissions.project_access?.access_level ?? 0, access.permissions.group_access?.access_level ?? 0) < 30) {
        throw new SetupError('repositoryReadOnly', { account: agent.username, repository: access.path_with_namespace })
      }
      return { ...machine, repository: access.path_with_namespace, github: { cli, login: agent.username,
        noreply: accounts.commitEmail || agent.email || `${agent.username}@noreply.${new URL(baseUrl).hostname}`, provider: 'gitlab', baseUrl } }
    }
    const agent = parsed(z.object({ login: z.string().regex(/^[A-Za-z0-9_.-]+$/), email: z.string().nullish() }), text)
    if (!agent) throw new SetupError('agentCliNoAccount')
    const access = parsed(z.object({ full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      permissions: z.object({ push: z.boolean() }) }), await run([cli, 'api', `repos/${remote}`])
      .catch((error: unknown) => { throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) }) }))
    if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
    if (!access.permissions.push) throw new SetupError('repositoryReadOnly', { account: agent.login, repository: access.full_name })
    const noreply = accounts.commitEmail || agent.email || `${agent.login}@noreply.${new URL(baseUrl).hostname}`
    return { ...machine, repository: access.full_name, github: { cli, login: agent.login, noreply, provider: 'gitea', baseUrl } }
  }
  const text = await run([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await run([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args])
    .catch((error: unknown) => fail(commandError(error, cli)))
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}

/** Reads a dedicated bot token file; Discord rejects user tokens because requests always use Bot authentication. */
export async function resolveDiscordBot(config: unknown, signal: AbortSignal): Promise<Deployment['discord']> {
  const { tokenFile } = DiscordBotSchema.parse(config ?? {})
  if (!tokenFile) return undefined
  try {
    const user = await new DiscordApi(tokenFile).request(DiscordUser, 'users/@me', signal)
    if (!user.bot) throw new Error('Discord account is not a bot')
    return { tokenFile, botId: user.id, name: user.username }
  } catch (error) { throw new SetupError('discordBotFailed', { output: reason(error) }) }
}

/** Verifies the private secret file and records the robot it names; the secret itself never enters the resolved deployment. */
export async function resolveWecomBot(config: unknown): Promise<Deployment['wecom']> {
  const { secretFile, wsUrl } = WecomBotSchema.parse(config ?? {})
  if (!secretFile) return undefined
  try {
    const secret = await readWecomSecret(secretFile)
    return { secretFile, botId: secret.botId, ...(wsUrl ? { wsUrl } : {}) }
  } catch (error) { throw new SetupError('wecomBotFailed', { output: reason(error) }) }
}
