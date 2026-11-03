/** Gitea integration through the real Python CLI, HTTP pagination, Source intake, replies and PR lifecycle. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Commands } from '../src/infra/commands.ts'
import { resolveDeployment, repositoryBaseUrl, type Deployment } from '../src/deployment.ts'
import { agentVariables, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { testMachine } from './fixtures/deployment.ts'
import { githubKind, pollRound } from '../src/sources/github.ts'
import { githubAddress, githubPage, githubChannel, CommentSchema } from '../src/sources/github-trigger.ts'
import { sendGithub, githubLink } from '../src/sources/github-channel.ts'
import { readPull, claimPull, observePull, pullEndNotices } from '../src/sources/github-pull.ts'
import { ciFact, ciCounts, ciSummary, pullChecks, readGithub, readRepositoryPath } from '../src/sources/github-read.ts'
import { Store } from '../src/app/store.ts'
import { Engine, type Trigger } from '../src/core/index.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { KV } from '../src/kv.ts'

vi.setConfig({ testTimeout: 30_000 })
type Route = (request: IncomingMessage, response: ServerResponse, url: URL) => unknown | Promise<unknown>
let directory: string, baseUrl: string, cli: string, deployment: Deployment
let routes: Map<string, Route>, requests: { method: string; url: URL; body: unknown }[]
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, baseUrl)
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString()
  requests.push({ method: request.method!, url, body: body ? JSON.parse(body) : undefined })
  if (request.headers.authorization !== 'token test-agent-credential') { response.writeHead(401); response.end('{}'); return }
  const route = routes.get(`${request.method} ${url.pathname.replace('/git/api/v1/', '')}`)
  response.setHeader('Content-Type', 'application/json')
  if (!route) { response.writeHead(404); response.end('{}'); return }
  try { response.end(JSON.stringify(await route(request, response, url))) }
  catch { response.writeHead(500); response.end('{}') }
})
const at = () => new Date(Date.now() + 1000).toISOString()
const issue = (number: number) => ({ id: number, number, title: `Issue ${number}`, body: '@agent_bot fix this',
  state: 'open', user: { login: 'alice', type: 'User' }, created_at: at(), updated_at: at(), html_url: `${baseUrl}/acme/widgets/issues/${number}` })
const comment = (id: number) => ({ id, body: `Comment ${id}`, user: { login: 'alice', type: 'User' },
  created_at: at(), updated_at: at(), html_url: `${baseUrl}/acme/widgets/issues/1#issuecomment-${id}` })
const pull = () => ({ ...issue(2), user: { login: 'agent_bot', type: 'User' }, html_url: `${baseUrl}/acme/widgets/pulls/2`,
  merged: false, head: { sha: 'abc1234', ref: 'agent/fix-ticket', repo: { full_name: 'acme/widgets' } } })
const route = (method: string, path: string, value: unknown) => routes.set(`${method} ${path}`, async () => value)
function paged(path: string, items: unknown[]): void {
  routes.set(`GET ${path}`, async (_request, response, url) => {
    // Simulate a server cap lower than either the Source's or CLI's requested page size.
    const page = Number(url.searchParams.get('page') ?? 1)
    if (page * 2 < items.length) {
      url.searchParams.set('page', String(page + 1))
      response.setHeader('Link', `<${url}>; rel="next"`)
    }
    return items.slice((page - 1) * 2, page * 2)
  })
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-gitea-'))
  routes = new Map(); requests = []
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}/git`
  const config = join(directory, 'account.json')
  writeFileSync(config, JSON.stringify({ baseUrl, token: 'test-agent-credential' }), { mode: 0o600 })
  cli = join(directory, 'agent-gitea')
  writeFileSync(cli, `#!/bin/sh\nexec python3 '${resolve('scripts/dsh-gitea')}' --config '${config}' "$@"\n`, { mode: 0o755 })
  route('GET', 'user', { login: 'agent_bot', id: 7, email: 'agent@example.test' })
  route('GET', 'repos/acme/widgets', { full_name: 'acme/widgets', permissions: { push: true }, default_branch: 'main' })
  const probe = new Commands(() => deployment, {}, new AbortController().signal)
  deployment = await resolveDeployment(testMachine({ stateDir: directory }),
    { provider: 'gitea', baseUrl, repository: 'acme/widgets', cli }, argv => probe.run(argv[0]!, argv.slice(1)))
})
afterEach(async () => {
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
  rmSync(directory, { recursive: true, force: true })
})
const commands = () => new Commands(() => deployment, {}, new AbortController().signal)

/** Runs Git's credential protocol with stdin, so the same helper used by private clones is exercised. */
function credential(url: string): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn('git', ['credential', 'fill'], { env: { ...process.env, ...agentVariables(directory) } })
    let output = '', error = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? done(output) : reject(new Error(error)))
    child.stdin.end(`url=${url}\n\n`)
  })
}

function host() {
  const store = new Store(join(directory, 'state.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { github: { enabled: true, config: { provider: 'gitea', baseUrl,
    repository: 'acme/widgets', cli } } }, policy: { sources: { github: { allowed: [{ id: 'alice' }] } } } }))
  const board = new HealthBoard(), sources = new SourceRegistry(() => store.settings(), board)
  sources.register(githubKind)
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const received: Trigger[] = []
  const receive = (trigger: Trigger) => { received.push(trigger); const result = engine.receive(trigger); engine.evaluateDue(); return result }
  const ctx = sourceContextOf({ store, engine, outbox: { send: vi.fn() }, sources, commands: commands(), deployment,
    ready: Promise.resolve(), configured: () => true, receive }, githubKind)
  return { store, engine, executor, ctx, received }
}

it('resolves the Gitea identity and push access without gh, and verifies that the CLI and Source use the same instance', async () => {
  expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { provider: 'gitea', baseUrl, login: 'agent_bot', noreply: 'agent@example.test' } })
  const probe = commands()
  await expect(resolveDeployment(testMachine(), { provider: 'gitea', baseUrl: 'https://elsewhere.test', repository: 'acme/widgets', cli },
    argv => probe.run(argv[0]!, argv.slice(1)))).rejects.toThrow('same baseUrl')
  route('GET', 'repos/acme/widgets', { full_name: 'acme/widgets', permissions: { push: false } })
  await expect(resolveDeployment(testMachine(), { provider: 'gitea', baseUrl, repository: 'acme/widgets', cli },
    argv => probe.run(argv[0]!, argv.slice(1)))).rejects.toMatchObject({ code: 'repositoryReadOnly' })
})

it('follows server pagination, emulates model-facing pages, and decodes repository files', async () => {
  paged('repos/acme/widgets/issues/1/comments', [1, 2, 3, 4, 5].map(comment))
  expect(await commands().pages(CommentSchema, 'issues/1/comments?per_page=100')).toHaveLength(5)
  const page = await commands().api(z.array(CommentSchema), 'issues/1/comments?per_page=2&page=2')
  expect(page.map(item => item.id)).toEqual([3, 4])
  paged('repos/acme/widgets/issues/1/comments', [comment(1), null, comment(2)])
  const tally = { skipped: 0 }
  expect(await commands().pages(CommentSchema, 'issues/1/comments', tally)).toHaveLength(2)
  expect(tally.skipped).toBe(1)
  route('GET', 'repos/acme/widgets/contents/README.md', { encoding: 'base64', content: Buffer.from('Hello Gitea').toString('base64') })
  expect(await readRepositoryPath(commands(), 'README.md', 'file')).toBe('Hello Gitea')
})

it('reads Gitea review decisions, review comments and commit statuses without GitHub Check Runs', async () => {
  route('GET', 'repos/acme/widgets/pulls/2/reviews', [{ id: 5, state: 'REQUEST_CHANGES', body: '', user: { login: 'alice' }, submitted_at: at() }])
  route('GET', 'repos/acme/widgets/pulls/2/reviews/5/comments', [{ ...comment(9), path: 'src/index.ts', position: 4 }])
  expect(await readGithub(commands(), 'github/pulls/2/reviews/1')).toMatchObject({ messages: [{ text: 'CHANGES_REQUESTED' }] })
  expect(await readGithub(commands(), 'github/pulls/2/comments/1')).toMatchObject({ messages: [{ path: 'src/index.ts', line: 4 }] })
  route('GET', 'repos/acme/widgets/commits/abc1234/statuses', [{ context: 'build', state: 'failure' }])
  expect(ciCounts(await pullChecks(commands(), 'abc1234'))).toEqual({ failed: 1, running: 0 })
  route('GET', 'repos/acme/widgets/commits/abc1234/statuses', [])
  const empty = await pullChecks(commands(), 'abc1234')
  expect(ciSummary(empty, 'PR #2', 'github/pulls/2/checks')).toContain('CI unavailable')
  expect(ciFact(ciCounts(empty)).value).toEqual({ zh: '暂无提交状态', en: 'No commit statuses' })
  expect(requests.some(item => item.url.pathname.includes('check-runs'))).toBe(false)
})

it('intakes an allowed mention once, binds its Gitea PR, and ends the ticket when it merges', async () => {
  route('GET', 'repos/acme/widgets/notifications', [{ repository: { full_name: 'acme/widgets' }, subject: { issue_url: `${baseUrl}/api/v1/repos/acme/widgets/issues/1` } }])
  route('GET', 'repos/acme/widgets/issues/1', issue(1))
  route('GET', 'repos/acme/widgets/issues/1/comments', [])
  const h = host()
  try {
    await pollRound(h.ctx)
    const trigger = h.received[0]!
    expect(h.engine.candidate(trigger.id)?.strength).toBe('explicit')
    h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix', scope: 'Fix this', reason: 'asked' })
    const ticket = h.store.tickets.open()[0]!
    h.store.tickets.save({ ...ticket, execution: { name: 'fix-ticket', directory: '/w/fix-ticket', assignment: 'Fix' } })
    route('GET', 'repos/acme/widgets/pulls/2', pull())
    expect(claimPull(h.ctx, ticket.id, await readPull(h.ctx, 2))).toBeUndefined()
    expect(h.store.tickets.get(ticket.id)?.follows).toEqual([{ thread: 'github:2', own: true }])
    const assignment = h.store.tickets.get(ticket.id)!.assignments.at(-1)!
    h.engine.assignmentStarted(ticket.id, assignment.id)
    h.engine.report(ticket.id, { state: 'ready', summary: 'PR ready' })
    await observePull(h.ctx, { ...await readPull(h.ctx, 2), state: 'closed', merged: true, merged_at: at() })
    expect(h.store.tickets.get(ticket.id)?.ended?.outcome).toBe('merged')
    expect(h.ctx.state.get(KV.github.since)).toBeDefined()
  } finally { h.store.close() }
})

it('does not advance notification cursors on failed reads and keeps the same trigger IDs on replay', async () => {
  route('GET', 'repos/acme/widgets/notifications', [{ repository: { full_name: 'acme/widgets' }, subject: { issue_url: `${baseUrl}/acme/widgets/issues/1` } }])
  const h = host()
  try {
    await expect(pollRound(h.ctx)).rejects.toThrow('HTTP 404')
    expect(h.ctx.state.get(KV.github.retries)).toHaveProperty('1')
    route('GET', 'repos/acme/widgets/issues/1', issue(1))
    route('GET', 'repos/acme/widgets/issues/1/comments', [])
    await pollRound(h.ctx)
    await pollRound(h.ctx)
    expect(h.received.map(item => item.id).every(id => id === h.received[0]!.id)).toBe(true)
    expect(h.store.read.triggerStats('')["github"]?.received).toBe(1)
  } finally { h.store.close() }
})

it('reconciles uncertain replies with their marker and replies to review feedback on the PR conversation', async () => {
  const posted: unknown[] = []
  route('GET', 'repos/acme/widgets/issues/2/comments', [])
  routes.set('POST repos/acme/widgets/issues/2/comments', async () => { posted.push(requests.at(-1)!.body); return { id: 20 } })
  const message = { id: 'reply-1', kind: 'reply' as const, text: 'Fixed src/index.ts:4', channel: githubChannel(2, `${baseUrl}/acme/widgets/pulls/2#issuecomment-9`) }
  expect(await sendGithub({ commands: commands() }, message)).toBe('sent')
  expect(posted).toEqual([{ body: 'Fixed src/index.ts:4\n\n<!-- dsh-superagent:reply-1 -->' }])
  route('GET', 'repos/acme/widgets/issues/2/comments', [{ id: 20, user: { login: 'agent_bot' }, body: (posted[0] as { body: string }).body }])
  expect(await sendGithub({ commands: commands() }, message)).toBe('sent')
  expect(posted).toHaveLength(1)
})

it('pins Git credentials to this instance and repository, blocks gh, and keeps credentials out of public config', async () => {
  await writeEnvironment(deployment, [])
  const gitConfig = readFileSync(workerGitConfig(directory), 'utf8')
  expect(gitConfig).toContain(baseUrl)
  expect(gitConfig).not.toContain('test-agent-credential')
  const run = commands()
  await expect(run.run(join(workerBin(directory), 'gh'), ['api', 'user'])).rejects.toThrow('uses Gitea')
  expect(JSON.parse(await run.run(join(workerBin(directory), 'gitea'), ['config']))).toEqual({ baseUrl })
  expect(agentVariables(directory).GITEA_TOKEN).toBeUndefined()
  expect(await credential(`${baseUrl}/acme/widgets.git`)).toContain('password=test-agent-credential')
  for (const url of [`${baseUrl}/other/repo.git`, baseUrl.replace('/git', '/elsewhere') + '/acme/widgets.git',
    `${baseUrl.replace('127.0.0.1', 'localhost')}/acme/widgets.git`]) await expect(credential(url)).rejects.toThrow()
})

it('refuses cross-instance pagination and redirects without forwarding its credential', async () => {
  routes.set('GET repos/acme/widgets/issues/1/comments', async (_request, response) => {
    response.setHeader('Link', '<https://another-instance.test/api/v1/user>; rel="next"')
    return [comment(1)]
  })
  await expect(commands().pages(CommentSchema, 'issues/1/comments')).rejects.toThrow('left the configured API')
  routes.set('GET repos/acme/widgets/issues/1', async (_request, response) => {
    response.statusCode = 302
    response.setHeader('Location', 'https://another-instance.test/api/v1/user')
    return {}
  })
  await expect(commands().api('issues/1')).rejects.toThrow('HTTP 302')
})

it('keeps Gitea links in the panel and Feishu terminal notices, and rejects another instance or unsafe API path', async () => {
  expect(githubPage('acme/widgets', 2, true, baseUrl)).toBe(`${baseUrl}/acme/widgets/pulls/2`)
  expect(githubAddress(`${baseUrl}/api/v1/repos/acme/widgets/pulls/2`, 'acme/widgets', baseUrl)).toEqual({ number: 2, pr: true })
  expect(githubAddress('https://evil.test/acme/widgets/pulls/2', 'acme/widgets', baseUrl)).toBeUndefined()
  expect(githubLink(githubChannel(2).address, deployment).url).toBe(`${baseUrl}/acme/widgets/issues/2`)
  const ticket = { id: 'ticket', ended: { outcome: 'merged' }, follows: [{ thread: 'github:2', own: true, closed: { outcome: 'merged', at: at() } }],
    channels: [{ source: 'feishu', address: { chatId: 'chat' } }] }
  expect(pullEndNotices(ticket as never, '完成', deployment.repository, baseUrl)[0]?.text).toContain(`${baseUrl}/acme/widgets/pulls/2`)
  for (const path of ['../other', '/user', 'https://elsewhere.test/user', 'issues/%2e%2e/%2e%2e/user']) {
    await expect(commands().api(path)).rejects.toThrow()
  }
  for (const value of ['file:///tmp/test', 'https://user:password@host', 'https://host/?token=secret']) expect(() => repositoryBaseUrl(value)).toThrow()
})
