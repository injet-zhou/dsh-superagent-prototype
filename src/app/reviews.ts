/** Independent PR review scheduling, isolated checkouts, result publication and worker feedback. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { key, liveTicket, type Engine, type Ticket, type Trigger } from '../core/index.ts'
import type { WorkerSlots } from '../executor/dsh.ts'
import { runningJobs, stopBackground, until, untilQuiet } from '../executor/background.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { agentPull, pullsOf, readPull, type Pull } from '../sources/github-pull.ts'
import { sendGithub } from '../sources/github-channel.ts'
import type { SourceContext } from '../sources/host.ts'
import { Later, type Effects } from './effects.ts'
import { promptFile } from './skill-files.ts'
import { ReviewResultSchema, type ReviewResult, type ReviewRun } from './review-types.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { Tool } from './tools/tool.ts'

const now = () => new Date().toISOString()
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const REVIEW_LIMIT_MS = 30 * 60_000
const reviewerPrompt = promptFile('reviewer')

export interface ReviewsHost {
  readonly context: Context
  readonly store: Store
  readonly effects: Effects
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt'>
  readonly commands: Commands
  readonly github: SourceContext
  readonly engine: Pick<Engine, 'note'>
  readonly slots: WorkerSlots
  readonly stateDir: string
  readonly lifetime: AbortSignal
  paused(): boolean
  closing(): boolean
  authorized?(ticket: Ticket): boolean
  repliedTo(trigger: Trigger): Trigger | undefined
}

/** Fetch only committed repository state into an independent repository, never copying a worker's files or git config. */
export async function prepareReview(commands: Commands, run: Pick<ReviewRun, 'base' | 'head'> & { directory: string }, remote: string): Promise<void> {
  await mkdir(dirname(run.directory), { recursive: true })
  await commands.git(['init', '--', run.directory], dirname(run.directory))
  await commands.git(['remote', 'add', 'origin', remote], run.directory)
  await commands.git(['fetch', '--no-tags', 'origin', run.base, run.head], run.directory)
  await commands.git(['checkout', '--detach', run.head], run.directory)
}

/** Include original requests, human follow-ups and their human reply context, without Session history or reports. */
export function reviewRequests(store: Pick<Store, 'triggers'>, ticket: Ticket, repliedTo: ReviewsHost['repliedTo']) {
  const ids = [...new Set([...ticket.origin.triggerIds, ticket.origin.triggerId, ...ticket.inputs.flatMap(input =>
    input.kind === 'trigger' && input.human && !input.context ? [input.triggerId] : [])])]
  const pending = ids.flatMap(id => {
    const trigger = store.triggers.get(id)
    return trigger && (trigger.human || id === ticket.origin.triggerId) ? [trigger] : []
  })
  const requests = new Map<string, { id: string; at: string; text: string; context?: true; replies_to?: string }>(pending
    .map(trigger => [trigger.id, { id: trigger.id, at: trigger.at, text: trigger.text }]))
  for (let index = 0; index < pending.length; index++) {
    const trigger = pending[index]!, parent = repliedTo(trigger)
    if (!parent?.human) continue
    requests.get(trigger.id)!.replies_to = parent.id
    if (requests.has(parent.id)) continue
    requests.set(parent.id, { id: parent.id, at: parent.at, text: parent.text, context: true })
    pending.push(parent)
  }
  return [...requests.values()]
}

export function reviewText(run: ReviewRun): string {
  const result = run.result!
  const verdict = { clear: 'No actionable findings', issues: 'Issues found', incomplete: 'Review incomplete' }[result.verdict]
  return [`Independent review: ${verdict}`, `Commit: \`${run.head}\` · Base: \`${run.base}\``, result.summary,
    ...result.findings.map(finding => `**${finding.severity.toUpperCase()} · ${finding.path}:${finding.line} · ${finding.title}**\n${finding.body}`),
    ...(result.checks.length ? [`Checks:\n${result.checks.map(check => `- ${check}`).join('\n')}`] : []),
    'This automated review is advisory and does not replace required approvals.'].join('\n\n')
}

/**
 * Owns durable ReviewRuns below their original Ticket, with one fresh root Session and checkout per attempt.
 * Uses the same local/global slots as workers, and persists publication and feedback independently of model execution.
 */
export class Reviews {
  private readonly active = new Set<string>()
  private readonly launching = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly settling = new Map<string, AbortController>()
  private readonly cleanup = new Set<Promise<void>>()
  private readonly stopping = new Set<string>()
  private readonly disposers: (() => void)[] = []
  constructor(private readonly host: ReviewsHost) {
    host.effects.handle('review', ({ runId }) => this.launch(runId), {
      limit: () => host.paused() ? 0 : host.slots.launches(), retry: [5000, 60_000] })
    host.effects.handle('review-publish', ({ runId }) => this.publish(runId), { limit: () => host.paused() ? 0 : 1 })
    host.effects.handle('review-cleanup', ({ sessionId }) => this.reclaim(sessionId))
  }
  list(ticketId?: string): ReviewRun[] {
    return this.host.store.keys(KV.reviews.run).map(name => this.host.store.get(name)!)
      .filter(run => !ticketId || run.ticketId === ticketId)
  }
  activeIds(): string[] { return [...this.active] }
  endTicket(ticketId: string): void {
    for (const run of this.list(ticketId)) if (run.state !== 'stale') this.stale(run)
  }
  private get(id: string): ReviewRun | undefined { return this.host.store.get(KV.reviews.run(id)) }
  private save(run: ReviewRun): void { this.host.store.set(KV.reviews.run(run.id), run) }
  private owned(run: ReviewRun): boolean {
    const ticket = this.host.store.tickets.get(run.ticketId)
    return run.repository === this.host.commands.repository && !!ticket && liveTicket(ticket) && pullsOf(ticket, true).includes(run.number)
      && ticket.follows?.some(follow => follow.thread === `github:${run.number}` && follow.own) === true
      && this.host.authorized?.(ticket) !== false
  }
  observe(ticketId: string | undefined, pr: Pull): void {
    const { store, commands, effects } = this.host
    const previousId = store.get(KV.reviews.latest(pr.number))
    const previous = previousId && this.get(previousId)
    const reviewable = pr.state === 'open' && !pr.merged && !pr.draft && agentPull(pr, commands.deployment)
    const matches = (run: ReviewRun) => reviewable && run.head === pr.head.sha && run.base === pr.base?.sha && run.baseRef === pr.base?.ref
    store.atomic(() => {
      if (previous && previous.state !== 'stale' && (!matches(previous) || !this.owned(previous))) this.stale(previous)
      if (!ticketId || !reviewable || !SHA.test(pr.head.sha) || !SHA.test(pr.base?.sha ?? '')) return
      const revisionId = key(commands.repository, ticketId, String(pr.number), pr.base!.ref, pr.base!.sha!, pr.head.sha)
      if (previous && matches(previous) && previous.state !== 'stale' && previous.ticketId === ticketId) return
      const id = this.get(revisionId) ? key(revisionId, previousId ?? '') : revisionId
      const run: ReviewRun = { id, ticketId, repository: commands.repository, number: pr.number, url: pr.html_url,
        base: pr.base!.sha!, baseRef: pr.base!.ref, head: pr.head.sha, state: 'queued', createdAt: now(), attempt: 0 }
      if (!this.owned(run)) return
      this.save(run); store.set(KV.reviews.latest(pr.number), id)
      effects.enqueue('review', id, { runId: id })
    })
  }
  private stale(run: ReviewRun): void {
    this.save({ ...run, state: 'stale' })
    this.host.effects.cancel('review', run.id); this.host.effects.cancel('review-publish', run.id)
    this.host.store.afterCommit(() => { if (run.sessionId) this.stop(run.sessionId) })
  }
  /** Reconcile with the provider before reporting, publishing, or delivering a conclusion about a revision. */
  private async current(run: ReviewRun, signal?: AbortSignal): Promise<boolean> {
    const pr = await readPull(this.host.github, run.number, signal)
    this.observe(undefined, pr)
    return this.get(run.id)?.state !== 'stale' && this.owned(run)
      && this.host.store.get(KV.reviews.latest(run.number)) === run.id
  }
  /** Resolve only a Session recorded as this run's current attempt. No Worker tools, skills or memory are registered. */
  session(sessionId: string) {
    const id = this.host.store.get(KV.reviews.session(sessionId)), run = id ? this.get(id) : undefined
    if (!run) return undefined
    const active = () => { const current = this.get(run.id); return current?.state === 'running' && current.sessionId === sessionId && this.owned(current) }
    return { prompt: reviewerPrompt, active,
      tools: [{ name: 'orchestrator_review_report', description: 'Submit the independent review of this exact PR revision once. Incomplete never means passed.',
        schema: ReviewResultSchema, execute: async (args, signal) => {
          const result = ReviewResultSchema.parse(args)
          if (!active() || !await this.current(run, signal)) throw new Error('This review is no longer current')
          if (runningJobs(this.host.context, sessionId).length) throw new Error('Local checks are still running; submit after they finish')
          for (const finding of result.findings) {
            const text = await this.host.commands.withSignal(signal).git(['show', `${run.head}:${finding.path}`], run.directory!)
            if (finding.line > text.replace(/\n$/, '').split('\n').length) throw new Error('Finding line is outside the cited file')
          }
          if (!await this.current(run, signal) || !active()) throw new Error('This review is no longer current')
          this.complete(this.get(run.id)!, result)
          return { recorded: true, publication: 'queued' }
        } } satisfies Tool] }
  }
  install(): void {
    const { context } = this.host
    this.disposers.push(context.on('agent/status', ({ agent, status }) => {
      if (!this.active.has(agent.id) || this.host.closing()) return
      this.settling.get(agent.id)?.abort()
      if (status === 'idle') {
        const controller = new AbortController(); this.settling.set(agent.id, controller)
        this.track(untilQuiet(context, agent, controller.signal).then(quiet => {
          if (quiet && !this.host.closing()) this.incomplete(agent.id, 'The reviewer ended without submitting a complete result.')
        }).finally(() => { if (this.settling.get(agent.id) === controller) this.settling.delete(agent.id) }))
      }
    }), context.on('agent/error', ({ agent }) => {
      if (!this.host.closing()) this.incomplete(agent.id, 'The reviewer could not finish because its model request failed.')
    }), context.on('agent/disposed', ({ agent }) => {
      if (!this.host.closing()) this.incomplete(agent.id, 'The reviewer Session ended before it submitted a result.')
    }))
  }
  resume(): void {
    this.host.store.atomic(() => {
      for (const run of this.list()) {
        for (let attempt = 1; attempt <= run.attempt; attempt++) this.queueCleanup(`reviewer-${run.id}-${attempt}`)
        if (!this.owned(run)) { if (run.state !== 'stale') this.stale(run); continue }
        if (run.state === 'running') { run.state = 'queued'; this.save(run) }
        if (run.state === 'queued') this.host.effects.enqueue('review', run.id, { runId: run.id })
        else if (run.state === 'completed' && !run.notifiedAt) this.host.effects.enqueue('review-publish', run.id, { runId: run.id })
      }
    })
  }
  private async launch(id: string): Promise<void> {
    let run = this.get(id)
    if (!run || run.state !== 'queued') return
    if (!this.owned(run)) { this.stale(run); return }
    if (this.host.paused()) throw new Later('Processing is paused')
    const sessionId = `reviewer-${id}-${run.attempt + 1}`
    this.host.slots.reserve(sessionId, 'launch')
    this.active.add(sessionId)
    this.launching.add(sessionId)
    try {
      run = { ...run, attempt: run.attempt + 1, sessionId, directory: join(this.host.stateDir, 'reviews', id, String(run.attempt + 1)) }
      this.host.store.atomic(() => { this.save(run!); this.host.store.set(KV.reviews.session(sessionId), id) })
      if (!await this.current(run)) return
      const { github } = this.host.commands.deployment
      const remote = `${github.baseUrl || 'https://github.com'}/${run.repository}.git`
      await prepareReview(this.host.commands, { ...run, directory: run.directory! }, remote)
      if (!await this.current(run)) return
      if (this.host.paused()) throw new Later('Processing is paused')
      const ticket = this.host.store.tickets.get(run.ticketId)!
      const agent = await this.host.sessions.ensure(sessionId, run.directory!, `Review #${run.number} · ${run.head.slice(0, 8)}`, 'reviewer')
      if (!await this.current(run)) return
      this.save({ ...run, state: 'running' })
      this.timers.set(sessionId, setTimeout(() => this.incomplete(sessionId, 'The independent review exceeded its 30-minute time limit.'), REVIEW_LIMIT_MS))
      this.timers.get(sessionId)!.unref?.()
      const request = JSON.stringify({ review_id: id, pr: run.number, base: run.base, head: run.head,
        requests: reviewRequests(this.host.store, ticket, trigger => this.host.repliedTo(trigger)) })
      await this.host.sessions.prompt(agent.id, `review:${id}:${run.attempt}`, request, 'queue', () => {
        if (this.host.paused() || this.get(id)?.state !== 'running' || !this.owned(run!)) throw new Later('Review authorization changed')
      })
    } catch (error) {
      if (this.host.closing()) throw error
      if (this.get(id)?.state === 'stale') return
      const current = this.get(id)!
      if (current.state === 'completed' || current.sessionId !== sessionId) return
      if (error instanceof Later || current.attempt < 3) {
        this.save({ ...current, state: 'queued' }); throw error
      }
      this.complete(current, { verdict: 'incomplete', summary: 'The reviewer could not prepare or start its isolated checkout after three attempts.', findings: [], checks: [] })
    } finally {
      this.launching.delete(sessionId)
      this.host.slots.free(sessionId)
      if (this.get(id)?.state !== 'running') this.stop(sessionId)
      this.host.effects.kick()
    }
  }
  private incomplete(sessionId: string, summary: string): void {
    const id = this.host.store.get(KV.reviews.session(sessionId)), run = id ? this.get(id) : undefined
    if (run?.state === 'running' && run.sessionId === sessionId) this.complete(run, { verdict: 'incomplete', summary, findings: [], checks: [] })
  }
  private complete(run: ReviewRun, result: ReviewResult): void {
    this.host.store.atomic(() => {
      this.save({ ...run, state: 'completed', result, finishedAt: now() })
      this.host.effects.enqueue('review-publish', run.id, { runId: run.id })
      this.host.store.afterCommit(() => { if (run.sessionId) this.stop(run.sessionId) })
    })
  }
  private async publish(id: string): Promise<void> {
    let run = this.get(id)
    if (!run || run.state !== 'completed' || !run.result || run.notifiedAt) return
    if (!await this.current(run)) return
    if (!run.publishedAt && !run.publicationUnavailableAt) {
      const sent = await sendGithub({ commands: this.host.commands }, { id: `review-${id}`, kind: 'notice', ticketId: run.ticketId,
        channel: { source: 'github', thread: `github:${run.number}`, address: { number: String(run.number) } }, text: reviewText(run) }, async () => {
        if (this.host.paused()) throw new Later('Review publication is paused')
        if (!await this.current(run!)) throw new Later('Review superseded before publication')
      })
      if (!await this.current(run)) return
      run = { ...this.get(id)!, ...sent === 'sent' ? { publishedAt: now() } : { publicationUnavailableAt: now() } }; this.save(run)
    }
    if (!await this.current(run)) return
    this.host.store.atomic(() => {
      const current = this.get(id)!
      if (current.state !== 'completed' || current.notifiedAt || !this.owned(current)) return
      this.host.engine.note(current.ticketId, `${reviewText(current)}\n\nPR: ${current.url}\nReview ID: ${current.id}\n`
        + (current.publicationUnavailableAt ? 'The PR did not accept the review comment; this result is retained internally.\n' : '')
        + 'This is independent review feedback for context, not a new implementation request or authorization to expand scope.')
      this.save({ ...current, notifiedAt: now() })
    })
  }
  private track(work: Promise<void>): void {
    const tracked = work.catch(() => { this.host.context.logger.warn('dsh-superagent: reviewer background cleanup failed') })
      .finally(() => { this.cleanup.delete(tracked) })
    this.cleanup.add(tracked)
  }
  private stop(sessionId: string): void {
    clearTimeout(this.timers.get(sessionId)); this.timers.delete(sessionId)
    this.settling.get(sessionId)?.abort()
    if (!this.active.has(sessionId)) { this.queueCleanup(sessionId); return }
    if (this.stopping.has(sessionId)) return
    this.stopping.add(sessionId)
    this.track((async () => {
      const agent = this.host.context.agents.get(sessionId as SessionId)
      try {
        await stopBackground(this.host.context, sessionId, 'Independent review ended')
      } finally {
        try {
          agent?.cancel({ kind: 'user' }, { keepInbox: false })
          if (agent) await until(agent.whenIdle(), undefined, 10_000)
        } finally {
          this.active.delete(sessionId); this.stopping.delete(sessionId)
          this.queueCleanup(sessionId); this.host.effects.kick()
        }
      }
    })())
  }
  private queueCleanup(sessionId: string): void {
    if (!this.host.store.get(KV.reviews.cleaned(sessionId)) && !this.host.effects.pending('review-cleanup', sessionId)) {
      this.host.effects.enqueue('review-cleanup', sessionId, { sessionId })
    }
  }
  private async reclaim(sessionId: string): Promise<void> {
    if (this.host.store.get(KV.reviews.cleaned(sessionId))) return
    const match = /^reviewer-([a-f0-9]{32})-([1-9]\d*)$/.exec(sessionId)
    const run = match && this.get(match[1]!)
    const attempt = Number(match?.[2])
    if (!run || run.id !== match?.[1] || !Number.isSafeInteger(attempt) || attempt > run.attempt) throw new Error('Invalid review checkout identity')
    if (this.launching.has(sessionId) || this.active.has(sessionId)) throw new Later('Review checkout is still in use')
    const agent = this.host.context.agents.get(sessionId as SessionId)
    if (agent?.status === 'running' || runningJobs(this.host.context, sessionId).length) {
      try { await stopBackground(this.host.context, sessionId, 'Reclaiming independent review checkout') }
      finally {
        agent?.cancel({ kind: 'user' }, { keepInbox: false })
        if (agent) await until(agent.whenIdle(), undefined, 10_000)
      }
    }
    if (agent && agent.status !== 'idle' || runningJobs(this.host.context, sessionId).length) throw new Later('Review processes have not exited')
    const directory = join(this.host.stateDir, 'reviews', run.id, String(attempt))
    const actual = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (actual && actual !== join(await realpath(this.host.stateDir), 'reviews', run.id, String(attempt))) {
      throw new Error('Review checkout is outside its managed directory')
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    this.host.store.set(KV.reviews.cleaned(sessionId), true)
  }
  async shutdown(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose()
    const ids = [...this.active]
    for (const id of ids) this.stop(id)
    await Promise.all([...this.cleanup])
    await Promise.all(ids.map(id => this.reclaim(id).catch(() => {
      this.host.context.logger.warn('dsh-superagent: review checkout cleanup remains queued')
    })))
  }
}
