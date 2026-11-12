/** Host and context interfaces connecting Source plugins to the application; also imported by the web panel, so it must not import Node-only modules. */
import type { ChannelRef, ReceiveResult, OutboundMessage, Thread, ThreadFact, ThreadRef, Ticket, Trigger } from '../core/index.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SourceKind } from './kind.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceRegistry } from './registry.ts'
import type { SetupProblem } from '../setup.ts'
import type { Family, Key } from '../kv.ts'
import { fill } from '../infra/text.ts'

/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  feishuCliUnset: 'The Source is on, and its bot lark-cli is not set',
  feishuBotMissing: 'Waiting for the Feishu bot',
  discordTokenUnset: 'The Source is on, and its bot token file is not set',
  wecomSecretUnset: 'The Source is on, and its robot secret file is not set',
  wecomDisconnected: 'The connection to WeCom dropped; reconnecting',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: HealthCode; values?: Record<string, string> }
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} }
}
export interface SourceHost {
  /** Application contexts mount chat adapters only. */
  sourceKinds?: readonly string[]
  readonly sources: SourceRegistry
  /** Local repository contexts; omitted by single-repository hosts and third-party fixtures. */
  repositoryHosts?(): readonly SourceHost[]
  /** Subscribe to current and subsequently mounted repositories. Disposing unregisters every mounted adapter. */
  watchRepositories?(mount: RepositoryMount): SourceDisposer
  /** Returns the context for one Source kind; its `report` writes only the health entries declared by the kind. */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}
export type SourceDisposer = () => void | Promise<void>
export type RepositoryMount = (host: SourceHost) => SourceDisposer
export const repositoryHosts = (host: SourceHost): readonly SourceHost[] => host.repositoryHosts?.() ?? [host]
/** Mount a Source once per repository, including repositories created after the root service becomes active. */
export function mountSource<C extends Record<string, unknown>>(ctx: Context & { orchestrator: SourceHost }, kind: SourceKind<C>,
  start: (source: SourceContext, signal: AbortSignal) => Promise<unknown>): void {
  ctx.effect(() => {
    const mount = (host: SourceHost) => {
      if (host.sourceKinds && !host.sourceKinds.includes(kind.kind)) return () => {}
      const unregister = host.sources.register(kind)
      const source = sourceContext(host, kind), controller = new AbortController()
      let abort!: () => void
      const stopped = new Promise<void>(resolve => { abort = resolve })
      controller.signal.addEventListener('abort', abort, { once: true })
      const running = Promise.race([source.ready, stopped]).then(() => controller.signal.aborted ? undefined : start(source, controller.signal))
        .catch(error => { if (!controller.signal.aborted && kind.health[0]) source.report(kind.health[0], { state: 'error', detail: String(error) }) })
        .finally(() => controller.signal.removeEventListener('abort', abort))
      return async () => { controller.abort(); try { await running } finally { unregister() } }
    }
    if (ctx.orchestrator.watchRepositories) return ctx.orchestrator.watchRepositories(mount)
    const disposers = repositoryHosts(ctx.orchestrator).map(mount)
    return async () => { await Promise.all(disposers.reverse().map(dispose => dispose())) }
  })
}
/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
export interface SourceContext {
  readonly deployment: Deployment
  readonly commands: Commands
  /** Sanitized environment for long-lived native Source subprocesses, not a Worker shell environment. */
  readonly commandEnvironment?: Readonly<Record<string, string>>
  readonly ready: Promise<void>
  /** True once setup resolved the repository and accounts; Sources poll only then. */
  configured(): boolean
  /** Setup problem keeping this Source's account from running; optional bot checks can report one. */
  readonly problem?: SetupProblem | undefined
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** Ingests a trigger into the Engine and schedules the next evaluation pass; callers should await completion before advancing read cursors. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  /** Registers a listener for Tickets the Engine creates from any Trigger, called after the transaction commits; returns a disposer. */
  onTicketCreated(listener: (ticket: Ticket) => void | Promise<void>): () => void
  atomic<T>(work: () => T): T
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void; keys<V>(family: Family<V, never>): Key<V>[] }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** Open tickets, newest first. */
    open(): Ticket[]
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; /** The newest Trigger on a Thread. */ latest(thread: string): Trigger | undefined }
  notify(message: OutboundMessage): void
  /** Reports the state of one of this kind's declared health entries; throws for undeclared entry names. */
  report(entry: string, health: Health): void
}
export const sourceContext = (host: SourceHost, kind: { kind: string; health: readonly string[] }): SourceContext => host.context(kind)

/** Routes a shared bot's event to its receiving repository; unassigned chats remain discoverable as filtered messages. */
export function chatRecipients(contexts: Iterable<SourceContext>, kind: string, trigger: Trigger): SourceContext[] {
  const active = [...contexts].filter(ctx => ctx.config(kind))
  const receiving = active.filter(ctx => {
    const config = ctx.config(kind)!
    if (trigger.meta.direct === true) return config.directMessages === true
    const chats = config.chats as { chatId: string }[] | undefined
    return chats?.some(chat => chat.chatId === trigger.meta.chatId) || config.otherChats === 'mentions'
  })
  return receiving.length ? receiving : active
}
