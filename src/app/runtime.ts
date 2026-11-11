/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId, type WorkerSlots, type ExecutorHost } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost, type RepositoryMount, type SourceDisposer } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import type { Settings as SettingsValue } from '../policy.ts'
import { MemoryService } from './memory/service.ts'
import { MemoryCapture } from './memory/capture.ts'
import type { MemoryAnalyzer } from './memory/analyzer.ts'
import { DshMemoryAnalyzer } from './memory/dsh-analyzer.ts'
import { MemoryDreaming } from './memory/dreaming.ts'
import { MemoryProjection } from './memory/projection.ts'
import { MemoryAttestor } from './memory/attestation.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()
export interface RuntimeOptions {
  /** Explicit host injection for offline analysis; production never borrows a Worker Session. */
  memoryAnalyzer?: MemoryAnalyzer
  repositories?: () => readonly { id: string; name: string; runtime?: Runtime; error?: string }[]
  watchRepositories?: (mount: RepositoryMount) => SourceDisposer
  globalLoad?: () => { running: number; maxWorkers: number }
  aggregateHealth?: () => Record<string, Health>
  http?: boolean
  slots?: WorkerSlots
  validateSettings?: (settings: SettingsValue) => void
}

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly memory: MemoryService
  private readonly memoryProjection: MemoryProjection
  private readonly memoryAttestation: MemoryAttestor
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  /** Source listeners for created Tickets; they run after the creating transaction commits and need not survive a restart. */
  private readonly ticketCreatedListeners = new Set<(ticket: Ticket) => void | Promise<void>>()
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  private startupError?: string
  private startupStage = 'registerHttp'
  constructor(ctx: Context, readonly machine: Machine, restart: () => void, private readonly options: RuntimeOptions = {}) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu, () => setup.configured() && !!setup.deployment.discord, () => setup.configured() && !!setup.deployment.wecom)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const memory = this.memory = new MemoryService(store, board.claim('memory'))
      const attestor = this.memoryAttestation = new MemoryAttestor({ store, memory, lifetime: this.lifetime, paused: () => this.paused() })
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const executionEnvironment = (ticket?: Ticket): NodeJS.ProcessEnv => ({ ...setup.executionEnvironment,
        ...ticket ? Object.fromEntries(environment(ticket).map(variable => [variable.key, variable.value])) : {} })
      const resources: ResourceHost = { store, memory, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime, memory, observeExecution: (context, sessionId) => attestor.bind(context, sessionId),
        closing: () => this.closing(), environment, ...machine.scopedEnvironment ? { executionEnvironment } : {},
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      const memoryHost = { context: ctx, store, effects, memory, lifetime: this.lifetime,
        get analyzer(): MemoryAnalyzer | undefined {
          const model = store.settings().memory.analyzerModel
          return options.memoryAnalyzer ?? (model ? new DshMemoryAnalyzer(ctx.llm, model, SessionId(`memory-${masterId}`)) : undefined)
        }, paused: () => this.paused() }
      const capture = new MemoryCapture(memoryHost)
      const dreaming = new MemoryDreaming(memoryHost)
      const projection = this.memoryProjection = new MemoryProjection(memory, machine.stateDir, this.lifetime)
      memory.maintenanceWith({ consolidate: () => dreaming.enqueue(), rebuild: async () => {
        memory.publisher().rebuildIndex(); memory.refresh(); await projection.rebuild()
      } })
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() },
        settingsChanged: settings => {
          memory.analyzerAvailable(!!options.memoryAnalyzer || !!settings.memory.analyzerModel)
          if (memory.configure(settings.memory)) {
            try { sessions.refreshMemoryTools() } catch { memory.degraded('memory_tools_unavailable') }
          }
        },
        ...options.validateSettings ? { validateSettings: options.validateSettings } : {} })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        get onTurnSettled(): ExecutorHost['onTurnSettled'] { return memory.captureEnabled() ? (ticketId, assignmentId, event) => { capture.enqueue(ticketId, assignmentId, event) } : undefined },
        onMemoryError: () => { memory.degraded('memory_settlement_failed') },
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger), ...options.slots ? { slots: options.slots } : {},
        ...machine.scopedEnvironment ? { executionEnvironment: () => setup.executionEnvironment } : {} })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, ...machine.repositoryId ? { namespace: machine.repositoryId } : {},
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository, setup.deployment.github.baseUrl, setup.deployment.github.provider)) outbox.send(message)
          }
          // A Source may show its own receipt once a Ticket is dispatched; a cosmetic follow-up runs after the commit.
          if (event.type === 'ticket.created') {
            store.afterCommit(() => {
              const ticket = store.tickets.get(event.data.ticketId)
              if (!ticket) return
              const failed = (error: unknown) => { ctx.logger.warn('dsh-superagent: a Source ticket listener failed: %s', String(error)) }
              for (const listener of this.ticketCreatedListeners) {
                try { void Promise.resolve(listener(ticket)).catch(failed) } catch (error) { failed(error) }
              }
            })
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get commandEnvironment() { return setup.sourceEnvironment },
        get deployment() { return setup.deployment }, configured: () => runtime.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, get discordProblem() { return setup.discordProblem }, get wecomProblem() { return setup.wecomProblem }, receive: trigger => passes.receive(trigger),
        onTicketCreated: listener => { this.ticketCreatedListeners.add(listener); return () => { this.ticketCreatedListeners.delete(listener) } } }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize().catch(error => {
        const problem = new SetupError('startupFailed', { stage: this.startupStage, output: String(error) }).problem
        this.startupError = problem.detail
        this.setup.problem = problem
        this.ctx.logger.error('dsh-superagent repository %s failed during %s: %s', machine.repositoryId ?? 'default',
          this.startupStage, error instanceof Error ? error.stack ?? error.message : String(error))
        // Setup may have succeeded before Session initialization failed; keep the panel, but release process-wide overrides now.
        this.setup.restore()
        this.runtimeHealth.set({ state: 'error', detail: this.startupError, at: now() })
        this.stopped.abort()
      })
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  repositoryHosts(): readonly SourceHost[] { return this.options.repositories?.().flatMap(entry => entry.runtime ? [entry.runtime] : []) ?? [this] }
  watchRepositories(mount: RepositoryMount): SourceDisposer {
    if (this.options.watchRepositories) return this.options.watchRepositories(mount)
    const disposers = this.repositoryHosts().map(mount)
    return async () => { await Promise.all(disposers.reverse().map(dispose => dispose())) }
  }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return !this.startupError && this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  /** Why the WeCom robot is unavailable even though its Source names a secret file. */
  get wecomProblem(): SetupProblem | undefined { return this.setup.wecomProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, github: resolved.github, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { if (this.startupError) this.setup.restart(); else this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    if (this.options.http !== false) this.disposers.push(registerHttp(this.ctx, this.httpHost(), () =>
      this.options.repositories?.().map(({ id, name, runtime, error }) => ({ id, name, host: runtime?.httpHost(), error })) ?? [{ id: 'default', name: 'Default', host: this.httpHost() }]))
    this.startupStage = 'validateSettings'
    this.options.validateSettings?.(this.store.settings())
    this.startupStage = 'setup.run'
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('error', 'setupPending'), at: now() })
      return
    }
    if (this.closing()) return
    const deployment = this.setup.deployment
    this.memory.bind(JSON.stringify([this.machine.repositoryId ?? 'default', deployment.github.provider ?? 'github',
      deployment.github.baseUrl ?? 'https://github.com', deployment.repository.toLowerCase()]))
    this.startupStage = 'sessions.install'
    this.sessions.install()
    this.startupStage = 'executor.install'
    this.executor.install()
    this.startupStage = 'sessions.ensure'
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    this.startupStage = 'settings.sync'
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.startupStage = 'executor.resume'
    this.executor.resume()
    this.startupStage = 'passes.start'
    this.passes.start()
    this.startupStage = 'effects.start'
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, machine, masterId, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, memory: this.memory, machine, masterId, sourceLinks,
      get ready() { return runtime.ready }, get health() { return { ...runtime.health, ...runtime.options.aggregateHealth?.() } },
      get repositoryHealth() { return runtime.health },
      globalLoad: this.options.globalLoad,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, get discordProblem() { return setup.discordProblem }, get wecomProblem() { return setup.wecomProblem },
      configured: () => runtime.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { runtime.checkSetup() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      await this.memoryAttestation.idle()
      await this.memoryProjection.idle()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
