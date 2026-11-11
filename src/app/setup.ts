/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { GithubAccountsSchema, SETUP_FIELDS, resolveDeployment, resolveFeishuBot, resolveDiscordBot, resolveWecomBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, runAsWorker, sourceProcessEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import { delimiter } from 'node:path'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => {
    if (id !== 'github' && settings.sources[id]?.enabled === false) return [false]
    // Old settings omit the provider; materializing the default must not look like an account change.
    const config: Record<string, unknown> = id === 'github' ? GithubAccountsSchema.parse(settings.sources[id]?.config ?? {}) : settings.sources[id]?.config ?? {}
    return keys.map(key => config[key] ?? '')
  }))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  discordProblem?: SetupProblem
  wecomProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get sourceEnvironment(): Record<string, string> { return sourceProcessEnvironment({ PATH: this.path }) }
  get executionEnvironment(): NodeJS.ProcessEnv { return { ...this.variables, PATH: [workerBin(this.host.machine.stateDir), this.path].join(delimiter) } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and optional bots are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem && !this.discordProblem && !this.wecomProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    if ((block === 'source:feishu' || block === 'source:discord' || block === 'source:wecom') && settings.sources[block.slice(7)]?.enabled === false) return
    let check: Promise<unknown>
    if (block === 'source:discord') check = resolveDiscordBot(settings.sources.discord?.config, this.host.lifetime)
    else if (block === 'source:wecom') check = resolveWecomBot(settings.sources.wecom?.config)
    else if (block === 'source:feishu') check = resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
    else check = resolveDeployment(machine, settings.sources.github?.config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    if (machine.scopedEnvironment) return (argv: string[]) => runAsWorker(context.subprocess, argv, machine.stateDir,
      AbortSignal.any([lifetime, AbortSignal.timeout(60_000)]), this.commandEnvironment)
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe)
    const feishu = settings.sources.feishu?.enabled === false ? undefined : await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const discord = settings.sources.discord?.enabled === false ? undefined : await resolveDiscordBot(settings.sources.discord?.config, lifetime).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.discordProblem = error.problem
      context.logger.warn('dsh-superagent leaves Discord out: %s', error.message)
      return undefined
    })
    const wecom = settings.sources.wecom?.enabled === false ? undefined : await resolveWecomBot(settings.sources.wecom?.config).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.wecomProblem = error.problem
      context.logger.warn('dsh-superagent leaves WeCom out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}), ...(discord ? { discord } : {}), ...(wecom ? { wecom } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    if (!machine.scopedEnvironment) this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime, machine.scopedEnvironment ? this.executionEnvironment : undefined).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
