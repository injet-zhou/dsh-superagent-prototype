/** Independent review lifecycle, revision races, recovery, isolation and publication. */
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CliError, Commands } from '../src/infra/commands.ts'
import { claimPull, observePull, type Pull } from '../src/sources/github-pull.ts'
import { pollTicketPulls } from '../src/sources/github.ts'
import { KV } from '../src/kv.ts'
import { prepareReview } from '../src/app/reviews.ts'
import { REVIEWER_PRESET } from '../src/app/sessions.ts'
import { ReviewResultSchema } from '../src/app/review-types.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'

let h: Host
let pull: Pull
let comments: { id: number; body: string; user: { login: string } }[]
const base = 'a'.repeat(40), head = 'b'.repeat(40), nextHead = 'c'.repeat(40)
const result = { verdict: 'clear', summary: '没有发现需要修改的问题。', findings: [], checks: ['pnpm test: passed'] }
const source = () => h.runtime.context({ kind: 'github', health: ['github'] })
const runs = () => h.runtime.reviews.list()
const latest = () => runs().find(run => run.id === h.runtime.store.get(KV.reviews.latest(9)))!
const idle = (id: string) => {
  const agent = h.agents.get(id)!; agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}
function repositoryApi() {
  vi.mocked(Commands.prototype.gh).mockImplementation(async args => {
    if (args[1]?.endsWith('/pulls/9')) return pull
    if (args[1]?.includes('/issues/9/comments')) {
      if (args.includes('POST')) {
        const comment = { id: comments.length + 1, body: args.find(arg => arg.startsWith('body='))!.slice(5), user: { login: 'agent-bot' } }
        comments.push(comment); return comment
      }
      return [comments]
    }
    if (args[1]?.includes('/commits/')) return [[]]
    return { login: 'agent-bot', default_branch: 'master', permissions: { push: true } }
  })
  vi.mocked(Commands.prototype.git).mockImplementation(async args => args[0] === 'show' ? 'one\ntwo\n' : '')
}
async function ownedPull(trigger = feishu('1', '修复登录回归，保留现有接口。')) {
  const work = await h.acceptedTicket(trigger)
  pull = { number: 9, state: 'open', draft: false, html_url: 'https://github.com/acme/widgets/pull/9',
    user: { login: 'agent-bot' }, head: { sha: head, ref: `agent/${work.ticket.execution!.name}`, repo: { full_name: 'acme/widgets' } },
    base: { sha: base, ref: 'main' } }
  repositoryApi()
  return work
}
async function startReview(trigger?: ReturnType<typeof feishu>) {
  const work = await ownedPull(trigger)
  await h.runTool(work.sessionId, 'orchestrator_report', { state: 'progress', summary: 'Worker self-review claims everything is correct.', pr_number: 9 })
  await h.runtime.idle()
  return { ...work, review: latest() }
}
beforeEach(async () => {
  h = await startRuntime(store => {
    const settings = store.settings(); store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 2 } })
  })
  comments = []
})
afterEach(async () => { await h.stop() })

it('automatically starts one fresh root reviewer with only original requirements, without claiming a second Ticket', async () => {
  const { ticket, sessionId, review } = await startReview()
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Repeated PR report.', pr_number: 9 })
  await observePull(source(), pull); await h.runtime.idle()
  expect(runs()).toHaveLength(1)
  expect(review).toMatchObject({ state: 'running', attempt: 1, head, base, ticketId: ticket.id })
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  const created = h.controller.create.mock.calls.map(([args]) => args).find(args => args.sessionId === review.sessionId)
  expect(created).toMatchObject({ agentPreset: REVIEWER_PRESET, workspaceId: review.directory })
  expect(created).not.toHaveProperty('parentSession')
  expect(review.directory).not.toBe(ticket.execution!.directory)
  expect([...h.tools.get(review.sessionId!)!.keys()]).toEqual(['orchestrator_review_report'])
  const packets = h.relays(review.sessionId!)
  expect(packets).toHaveLength(1)
  expect(packets[0]).toMatchObject({ base, head, requests: [{ text: '修复登录回归，保留现有接口。' }] })
  expect(JSON.stringify(packets)).not.toContain('claims everything is correct')
  const agent = h.agents.get(review.sessionId!) as unknown as Agent
  const section = (agent.ctx.systemPrompt.section as Mock).mock.calls[0]![0]
  expect(section).toMatchObject({ complete: true, interpolate: false })
  expect(section.text()).toContain('independent code reviewer')
  expect(section.text()).not.toContain('repository experience')
  expect(h.runtime.executor.activeCount()).toBe(2)
})

it('includes the full referenced human reply chain even when those messages are not Ticket inputs', async () => {
  const original = feishu('1', `${'需求背景。'.repeat(100)}最后一个要求：保留现有接口。`, { mentions: [] })
  const parent = feishu('2', '第二个方案是只改登录状态判断。', { mentions: [], root_id: 'om_1', parent_id: 'om_1' })
  h.runtime.store.triggers.save(original); h.runtime.store.triggers.save(parent)
  const { review, ticket } = await startReview(feishu('3', '修这个，用第二个方案。', { root_id: 'om_1', parent_id: 'om_2' }))
  expect(ticket.origin.triggerIds).not.toContain(parent.id)
  expect(ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === original.id)).toBe(false)
  expect(h.relays(review.sessionId!)[0]!.requests).toEqual([
    { id: ticket.origin.triggerId, at: expect.any(String), text: '修这个，用第二个方案。', replies_to: parent.id },
    { id: parent.id, at: parent.at, text: parent.text, context: true, replies_to: original.id },
    { id: original.id, at: original.at, text: original.text, context: true },
  ])
})

it('preserves human follow-up reply links and deduplicates shared parents and original requests', async () => {
  const { ticket, sessionId } = await ownedPull()
  const parent = feishu('2', '方案一：重写接口。方案二：保留接口，只修状态判断。', { mentions: [], root_id: 'om_1', parent_id: 'om_1' })
  h.runtime.store.triggers.save(parent)
  const followup = feishu('3', '用第二个方案。', { mentions: [], root_id: 'om_1', parent_id: 'om_2' })
  const confirmation = feishu('4', '就按这个来。', { mentions: [], root_id: 'om_1', parent_id: 'om_2' })
  h.runtime.receive(followup); h.runtime.receive(confirmation)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Worker claims the chosen plan is implemented.', pr_number: 9 })
  await h.runtime.idle()
  const packet = h.relays(latest().sessionId!)[0]!
  expect(packet.requests).toEqual([
    { id: ticket.origin.triggerId, at: expect.any(String), text: '修复登录回归，保留现有接口。' },
    { id: followup.id, at: followup.at, text: followup.text, replies_to: parent.id },
    { id: confirmation.id, at: confirmation.at, text: confirmation.text, replies_to: parent.id },
    { id: parent.id, at: parent.at, text: parent.text, context: true, replies_to: ticket.origin.triggerId },
  ])
  expect(JSON.stringify(packet)).not.toContain('Worker claims')
})

it('excludes bot or agent reply context and unrelated human conversations', async () => {
  const parent = { ...feishu('1', 'Worker implementation report must not enter the review context.'), human: false }
  const unrelated = feishu('2', 'An unrelated private discussion.')
  h.runtime.store.triggers.save(parent); h.runtime.store.triggers.save(unrelated)
  const { review, ticket } = await startReview(feishu('3', '修复登录回归。', { parent_id: 'om_1' }))
  expect(h.relays(review.sessionId!)[0]!.requests).toEqual([
    { id: ticket.origin.triggerId, at: expect.any(String), text: '修复登录回归。' },
  ])
})

it('recovers a missing worker PR report from repository polling and waits for Draft PRs to become reviewable', async () => {
  const { ticket } = await ownedPull()
  pull.draft = true
  await observePull(source(), pull); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.follows).toHaveLength(1)
  expect(runs()).toHaveLength(0)
  pull.draft = false
  await pollTicketPulls(source()); await h.runtime.idle()
  expect(latest()).toMatchObject({ state: 'running', head })
})

it('publishes once as the author account and delivers internal feedback once, without relying on comment polling', async () => {
  const { ticket, review } = await startReview()
  await h.runTool(review.sessionId!, 'orchestrator_review_report', result)
  await h.runtime.idle()
  expect(comments).toHaveLength(1)
  expect(comments[0]!.body).toContain(`Commit: \`${head}\``)
  expect(comments[0]!.body).toContain(`<!-- dsh-superagent:review-${review.id} -->`)
  const feedback = () => h.runtime.store.tickets.get(ticket.id)!.inputs.filter(input => input.kind === 'note')
  expect(feedback()).toHaveLength(1)
  expect(feedback()[0]).toMatchObject({ text: expect.stringContaining('没有发现需要修改的问题') })
  expect(latest()).toMatchObject({ state: 'completed', result: { verdict: 'clear' }, publishedAt: expect.any(String), notifiedAt: expect.any(String) })
  h.runtime.reviews.resume(); await h.runtime.idle()
  expect(comments).toHaveLength(1); expect(feedback()).toHaveLength(1)
  await expect(h.runTool(review.sessionId!, 'orchestrator_review_report', result)).rejects.toThrow('no longer current')
  const detail = await h.api('GET', `tickets/${ticket.id}`)
  expect(detail.body).toMatchObject({ reviews: [{ sessionId: review.sessionId, result: { verdict: 'clear' } }] })
})

it('discards an obsolete running review and starts a new clean Session after a push', async () => {
  const { review } = await startReview()
  pull = { ...pull, head: { ...pull.head, sha: nextHead } }
  await observePull(source(), pull); await h.runtime.idle()
  await waitUntil(() => latest().state === 'running')
  expect(h.runtime.reviews.list().find(run => run.id === review.id)).toMatchObject({ state: 'stale' })
  expect(latest()).toMatchObject({ state: 'running', head: nextHead })
  expect(latest().sessionId).not.toBe(review.sessionId)
  expect(h.agents.get(review.sessionId!)!.cancel).toHaveBeenCalled()
  await expect(h.runTool(review.sessionId!, 'orchestrator_review_report', result)).rejects.toThrow('no longer current')
  expect(comments).toHaveLength(0)
})

it('checks the revision again immediately before publishing, including after a slow comment lookup', async () => {
  const { review } = await startReview()
  const gh = vi.mocked(Commands.prototype.gh), normal = gh.getMockImplementation()!
  gh.mockImplementation(async args => {
    if (args[1]?.includes('/issues/9/comments') && !args.includes('POST')) {
      pull = { ...pull, head: { ...pull.head, sha: nextHead } }
    }
    return normal(args)
  })
  await h.runTool(review.sessionId!, 'orchestrator_review_report', result); await h.runtime.idle()
  expect(comments).toHaveLength(0)
  expect(runs().find(run => run.id === review.id)!.state).toBe('stale')
})

it('reconciles an acknowledged-late publication by its marker instead of posting a duplicate', async () => {
  const { review } = await startReview()
  const gh = vi.mocked(Commands.prototype.gh), normal = gh.getMockImplementation()!
  let lost = false
  gh.mockImplementation(async args => {
    const response = await normal(args)
    if (args.includes('POST') && !lost) { lost = true; throw new Error('Connection reset after server accepted comment') }
    return response
  })
  await h.runTool(review.sessionId!, 'orchestrator_review_report', result); await h.runtime.idle()
  expect(comments).toHaveLength(1)
  h.runtime.store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'review-publish'").run()
  await h.runtime.idle()
  expect(comments).toHaveLength(1)
  expect(latest().notifiedAt).toEqual(expect.any(String))
})

it('still delivers the result internally when a locked PR refuses comments', async () => {
  const { ticket, review } = await startReview()
  const gh = vi.mocked(Commands.prototype.gh), normal = gh.getMockImplementation()!
  gh.mockImplementation(async args => {
    if (args.includes('POST')) throw new CliError('Conversation locked', 403)
    return normal(args)
  })
  await h.runTool(review.sessionId!, 'orchestrator_review_report', result); await h.runtime.idle()
  expect(latest()).toMatchObject({ publicationUnavailableAt: expect.any(String), notifiedAt: expect.any(String) })
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs.some(input => input.kind === 'note' && input.text.includes('retained internally'))).toBe(true)
  expect(comments).toHaveLength(0)
})

it('uses the shared worker slot without deadlocking when only one slot is configured', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const { sessionId, review } = await startReview()
  expect(review.state).toBe('queued')
  expect(h.controller.create.mock.calls.filter(([args]) => args.sessionId.startsWith('reviewer-'))).toHaveLength(0)
  idle(sessionId)
  await waitUntil(() => h.runtime.executor.activeCount() === 0)
  await h.runtime.idle()
  await waitUntil(() => latest().state === 'running')
  expect(latest().state).toBe('running')
  expect(h.runtime.executor.activeCount()).toBe(1)
  await h.runTool(latest().sessionId!, 'orchestrator_review_report', result); await h.runtime.idle()
  await waitUntil(() => h.runtime.reviews.activeIds().length === 0)
  expect(h.runtime.store.tickets.open()[0]!.inputs.some(input => input.kind === 'note')).toBe(true)
})

it('reports an unfinished review honestly and retains its slot while required background checks are running', async () => {
  const { review } = await startReview()
  const job = h.jobs.run(review.sessionId!, 'focused tests')
  await expect(h.runTool(review.sessionId!, 'orchestrator_review_report', result)).rejects.toThrow('checks are still running')
  idle(review.sessionId!)
  await Promise.resolve()
  expect(latest().state).toBe('running')
  expect(h.runtime.reviews.activeIds()).toContain(review.sessionId)
  h.jobs.end(job)
  await waitUntil(() => h.agents.get(review.sessionId!)!.status === 'running')
  idle(review.sessionId!)
  await waitUntil(() => latest().state === 'completed')
  await h.runtime.idle()
  expect(latest().result).toMatchObject({ verdict: 'incomplete' })
  expect(comments[0]!.body).toContain('Review incomplete')
})

it('rejects invalid verdicts and findings outside an existing head file', async () => {
  const { review } = await startReview()
  expect(ReviewResultSchema.safeParse({ ...result, verdict: 'issues' }).success).toBe(false)
  const finding = { severity: 'high', path: 'src/login.ts', line: 3, title: 'Session is lost', body: 'The new branch drops the session when the token expires.' }
  expect(ReviewResultSchema.safeParse({ ...result, findings: [finding] }).success).toBe(false)
  await expect(h.runTool(review.sessionId!, 'orchestrator_review_report', { ...result, verdict: 'issues', findings: [finding] }))
    .rejects.toThrow('outside the cited file')
  expect(latest().state).toBe('running')
  expect(ReviewResultSchema.safeParse({ ...result, verdict: 'issues', findings: [{ ...finding, path: '../secret' }] }).success).toBe(false)
})

it('does not review another author, a fork, or a PR that belongs to no worker', async () => {
  const { ticket } = await ownedPull()
  expect(claimPull(source(), ticket.id, { ...pull, user: { login: 'alice' } })).toMatch(/does not belong/)
  await observePull(source(), { ...pull, head: { ...pull.head, repo: { full_name: 'outsider/widgets' } } })
  expect(runs()).toHaveLength(0)
})

it('keeps automatic reviews queued while processing or the repository Source is disabled', async () => {
  const work = await ownedPull()
  await h.runtime.settings.pause(true, 'panel')
  expect(claimPull(source(), work.ticket.id, pull)).toBeUndefined()
  await h.runtime.idle(); expect(latest().state).toBe('queued')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, paused: false, sources: { ...settings.sources,
    github: { ...settings.sources.github!, enabled: false } } })
  await h.runtime.idle(); expect(latest().state).toBe('queued')
  h.runtime.store.saveSettings({ ...settings, paused: false }); await h.runtime.idle()
  expect(latest().state).toBe('running')
})

it('invalidates a reviewed base even when the head commit has not changed', async () => {
  const { review } = await startReview()
  pull = { ...pull, base: { ref: 'release', sha: 'd'.repeat(40) } }
  await observePull(source(), pull)
  await waitUntil(() => latest().state === 'running')
  expect(latest()).toMatchObject({ base: 'd'.repeat(40), baseRef: 'release', head })
  expect(latest().sessionId).not.toBe(review.sessionId)
})

it('stops a reviewer and its background jobs as soon as the original Ticket ends', async () => {
  const { ticket, review } = await startReview()
  const job = h.jobs.run(review.sessionId!, 'long check')
  h.runtime.engine.stopTicket(ticket.id, 'panel')
  await waitUntil(() => h.runtime.reviews.activeIds().length === 0)
  expect(h.jobs.service.kill).toHaveBeenCalledWith(job, review.sessionId, expect.any(String))
  expect(latest().state).toBe('stale')
  expect(comments).toHaveLength(0)
})

it('bounds failed launch attempts and publishes an incomplete review instead of silently passing', async () => {
  const work = await ownedPull()
  vi.mocked(Commands.prototype.git).mockRejectedValue(new Error('Fetch unavailable'))
  claimPull(source(), work.ticket.id, pull)
  for (let attempt = 0; attempt < 3; attempt++) {
    h.runtime.store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'review'").run()
    await h.runtime.idle()
    await waitUntil(() => h.runtime.reviews.activeIds().length === 0)
  }
  expect(latest()).toMatchObject({ state: 'completed', attempt: 3, result: { verdict: 'incomplete' } })
  expect(comments).toHaveLength(1)
})

it('does not let an older Session submit or use tools after a fresh recovery attempt takes over', async () => {
  const { review } = await startReview()
  const current = { ...review, sessionId: `reviewer-${review.id}-2`, attempt: 2 }
  h.runtime.store.set(KV.reviews.run(review.id), current)
  expect(h.runtime.reviews.session(review.sessionId!)!.active()).toBe(false)
  await expect(h.runTool(review.sessionId!, 'orchestrator_review_report', result)).rejects.toThrow('no longer current')
})

it('recovers durable review work after restart in a fresh attempt without reusing the old context', async () => {
  const { ticket, review } = await startReview()
  const trigger = h.runtime.store.triggers.get(ticket.origin.triggerId)!
  const savedTicket = h.runtime.store.tickets.get(ticket.id)!
  await h.stop()
  h = await startRuntime(store => {
    const root = dirname(String(store.db.prepare('PRAGMA database_list').get()!.file))
    store.triggers.save(trigger)
    store.tickets.save({ ...savedTicket, execution: { ...savedTicket.execution!, directory: join(root, 'worker') } })
    store.set(KV.reviews.run(review.id), review); store.set(KV.reviews.latest(9), review.id)
    const settings = store.settings(); store.saveSettings({ ...settings, paused: true, executor: { ...settings.executor, maxWorkers: 2 } })
  })
  repositoryApi()
  await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle()
  expect(latest()).toMatchObject({ state: 'running', attempt: 2 })
  expect(latest().sessionId).not.toBe(review.sessionId)
  expect(latest().directory).not.toBe(review.directory)
  expect(h.relays(latest().sessionId!)[0]).not.toHaveProperty('previous_result')
})

it('fetches an isolated committed snapshot, excluding worker dirt, untracked files and local git configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'independent-review-git-'))
  const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git(['init']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com'])
    writeFileSync(join(root, 'code.txt'), 'base\n'); git(['add', '.']); git(['commit', '-m', 'base'])
    const base = git(['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'code.txt'), 'committed head\n'); git(['commit', '-am', 'change'])
    const head = git(['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'code.txt'), 'uncommitted worker change\n')
    writeFileSync(join(root, 'worker-transcript.txt'), 'private implementation history')
    git(['config', 'review.workerPrivate', 'do not inherit'])
    const directory = join(root, 'review', 'checkout')
    const commands = new Commands(() => testDeployment(), gitEnv(), new AbortController().signal)
    vi.spyOn(commands, 'git').mockImplementation(async (args, cwd) => git(args, cwd))
    await prepareReview(commands, { base, head, directory }, root)
    expect(git(['rev-parse', 'HEAD'], directory)).toBe(head)
    expect(git(['status', '--porcelain'], directory)).toBe('')
    expect(readFileSync(join(directory, 'code.txt'), 'utf8')).toBe('committed head\n')
    expect(existsSync(join(directory, 'worker-transcript.txt'))).toBe(false)
    expect(git(['config', '--local', '--list'], directory)).not.toContain('workerprivate')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
