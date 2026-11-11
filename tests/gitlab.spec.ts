/** GitLab integration through the real Python CLI, HTTP pagination, Source intake, replies and PR lifecycle. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
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
import { githubAddress, githubPage, githubChannel, commentTrigger, CommentSchema } from '../src/sources/github-trigger.ts'
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
  if (request.headers['private-token'] !== 'test-agent-credential') { response.writeHead(401); response.end('{}'); return }
  const route = routes.get(`${request.method} ${url.pathname.replace('/git/api/v4/', '')}`)
  response.setHeader('Content-Type', 'application/json')
  if (!route) { response.writeHead(404); response.end('{}'); return }
  try { response.end(JSON.stringify(await route(request, response, url))) }
  catch { response.writeHead(500); response.end('{}') }
})
const at = () => new Date(Date.now() + 1000).toISOString()
const issue = (iid: number) => ({ id: 100 + iid, iid, title: `Issue ${iid}`, description: '@agent_bot fix this',
  state: 'opened', author: { id: 1, username: 'alice' }, created_at: at(), updated_at: at(), web_url: `${baseUrl}/acme/team/widgets/-/issues/${iid}` })
const mergeRequest = (iid: number) => ({ ...issue(iid), id: 200 + iid, title: `MR ${iid}`, sha: 'abc1234', source_branch: 'agent/fix', target_branch: 'main',
  source_project_id: 42, target_project_id: 42, web_url: `${baseUrl}/acme/team/widgets/-/merge_requests/${iid}` })
const comment = (id: number) => ({ id, author: { id: 1, username: 'alice' }, body: '@agent_bot fix the test', created_at: at(), updated_at: at(), system: false })
const project = 'projects/acme%2Fteam%2Fwidgets'
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
  directory = mkdtempSync(join(tmpdir(), 'dsh-gitlab-'))
  routes = new Map(); requests = []
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}/git`
  const config = join(directory, 'account.json')
  writeFileSync(config, JSON.stringify({ baseUrl, token: 'test-agent-credential' }), { mode: 0o600 })
  cli = join(directory, 'agent-gitlab')
  writeFileSync(cli, `#!/bin/sh\nexec python3 '${resolve('scripts/dsh-gitlab')}' --config '${config}' "$@"\n`, { mode: 0o755 })
  route('GET', 'todos', [])
  route('GET', 'users/1', { id: 1, username: 'alice', bot: false })
  route('GET', 'users/7', { id: 7, username: 'agent_bot', bot: false })
  route('GET', 'user', { username: 'agent_bot', id: 7, email: 'agent@example.test' })
  route('GET', 'projects/acme%2Fteam%2Fwidgets', { id: 42, path_with_namespace: 'acme/team/widgets', permissions: { project_access: { access_level: 30 }, group_access: null }, default_branch: 'main' })
  const probe = new Commands(() => deployment, {}, new AbortController().signal)
  deployment = await resolveDeployment(testMachine({ stateDir: directory }),
    { provider: 'gitlab', baseUrl, repository: 'acme/team/widgets', cli }, argv => probe.run(argv[0]!, argv.slice(1)))
})
afterEach(async () => {
  vi.restoreAllMocks()
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
  store.saveSettings(SettingsSchema.parse({ sources: { github: { enabled: true, config: { provider: 'gitlab', baseUrl,
    repository: 'acme/team/widgets', cli } } }, policy: { sources: { github: { allowed: [{ id: 'alice' }] } } } }))
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

it('verifies the instance, canonical subgroup project, dedicated account and Developer access', async () => {
  expect(deployment).toMatchObject({ repository: 'acme/team/widgets', github: { provider: 'gitlab', baseUrl, login: 'agent_bot', noreply: 'agent@example.test' } })
  const resolve = () => resolveDeployment(testMachine(), { provider: 'gitlab', baseUrl, repository: deployment.repository, cli }, argv => commands().run(argv[0]!, argv.slice(1)))
  route('GET', project, { id: 42, path_with_namespace: deployment.repository, permissions: { group_access: { access_level: 20 } } })
  await expect(resolve()).rejects.toMatchObject({ code: 'repositoryReadOnly' })
  route('GET', project, { id: 42, path_with_namespace: deployment.repository, permissions: { group_access: { access_level: 40 } } })
  await expect(resolve()).resolves.toMatchObject({ repository: deployment.repository })
  route('GET', project, { id: 42, path_with_namespace: deployment.repository, archived: true, permissions: { group_access: { access_level: 40 } } })
  await expect(resolve()).rejects.toMatchObject({ code: 'repositoryReadOnly' })
  await expect(resolveDeployment(testMachine(), { provider: 'gitlab', baseUrl: 'https://elsewhere.test', repository: deployment.repository, cli },
    argv => commands().run(argv[0]!, argv.slice(1)))).rejects.toThrow('same baseUrl')
})

it('rejects unsafe instance URLs and repository paths before probing', async () => {
  const probe = vi.fn()
  for (const baseUrl of ['not a URL', 'http://git.example.test', 'https://git.example.test/api/v4/', 'https://user:pass@git.example.test', 'https://git.example.test/?token=secret']) {
    await expect(resolveDeployment(testMachine(), { provider: 'gitlab', baseUrl }, probe)).rejects.toMatchObject({ code: 'baseUrlInvalid' })
  }
  await expect(resolveDeployment(testMachine(), { provider: 'gitlab', baseUrl, repository: 'group/../widgets', cli }, probe)).rejects.toThrow()
  expect(probe).not.toHaveBeenCalled()
})

it('canonicalizes default HTTPS ports consistently with Source settings and Git credential hosts', async () => {
  const config = join(directory, 'canonical.json')
  writeFileSync(config, JSON.stringify({ baseUrl: 'https://GITLAB.example.test:443/code/', token: 'test-agent-credential' }))
  expect(JSON.parse(await commands().run('python3', [resolve('scripts/dsh-gitlab'), '--config', config, 'config'])))
    .toEqual({ baseUrl: repositoryBaseUrl('https://GITLAB.example.test:443/code/') })
})

it('follows capped server pages, keeps Issue/MR identifiers separate, and reads repository paths', async () => {
  paged(`${project}/issues/1/notes`, [1, 2, 3, 4, 5].map(comment))
  expect((await commands().pages(CommentSchema, 'issues/issue-1/comments')).map(item => item.id)).toEqual([1, 2, 3, 4, 5])
  expect(await readGithub(commands(), 'github/issues/1/comments/1')).toMatchObject({ messages: expect.arrayContaining([{ id: '1', from: 'alice', at: expect.any(String), text: '@agent_bot fix the test', url: `${baseUrl}/acme/team/widgets/-/issues/1#note_1` }]) })
  route('GET', `${project}/issues/1`, issue(1))
  route('GET', `${project}/merge_requests/1`, mergeRequest(1))
  expect(await readGithub(commands(), 'github/issues/1')).toMatchObject({ number: 'issue-1', title: 'Issue 1' })
  expect(await readGithub(commands(), 'github/pulls/1')).toMatchObject({ number: 1, title: 'MR 1', head: 'agent/fix', base: 'main' })
  route('GET', `${project}/repository/files/src%2Findex.ts`, { encoding: 'base64', content: Buffer.from('Hello GitLab').toString('base64') })
  expect(await readRepositoryPath(commands(), 'src/index.ts', 'file')).toBe('Hello GitLab')
  const names = Array.from({ length: 24 }, (_, i) => `file-${String(i).padStart(2, '0')}`)
  paged(`${project}/repository/tree`, [...names.map(name => ({ name })), { name: '.gitlab' }])
  expect(await readRepositoryPath(commands(), '', 'directory')).toBe(names.join('\n'))
})

it('follows X-Next-Page pagination and stops at the configured HTTP request budget', async () => {
  routes.set(`GET ${project}/issues/1/notes`, async (_request, response, url) => {
    const page = Number(url.searchParams.get('page') ?? 1)
    response.setHeader('X-Next-Page', page < 3 ? String(page + 1) : '')
    return [comment(page)]
  })
  expect((await commands().pages(CommentSchema, 'issues/issue-1/comments')).map(item => item.id)).toEqual([1, 2, 3])
  await expect(commands().run(cli, ['api', `${project}/issues/1/notes`, '--paginate', '--slurp', '--max-requests', '1'])).rejects.toThrow('operation budget exceeded')
})

it('creates and closes an MR through the isolated worker CLI using native GitLab JSON', async () => {
  route('POST', `${project}/merge_requests`, mergeRequest(5))
  const created = JSON.parse(await commands().run(cli, ['api', `${project}/merge_requests`, '--method', 'POST',
    '-f', 'source_branch=agent/fix', '-f', 'target_branch=main', '-f', 'title=Fix', '-f', 'description=Verified']))
  expect(created.iid).toBe(5)
  expect(requests.at(-1)?.body).toEqual({ source_branch: 'agent/fix', target_branch: 'main', title: 'Fix', description: 'Verified' })
  route('PUT', `${project}/merge_requests/5`, { ...mergeRequest(5), state: 'closed' })
  await commands().run(cli, ['api', `${project}/merge_requests/5`, '--method', 'PUT', '-f', 'state_event=close'])
  expect(requests.at(-1)?.body).toEqual({ state_event: 'close' })
})

it('reads diff discussions as threads, preserving author, file, line and reply relationships', async () => {
  route('GET', 'users/2', { id: 2, username: 'review_bot', bot: true })
  route('GET', `${project}/merge_requests/1/discussions`, [{ id: 'discussion-a', notes: [
    { ...comment(10), type: 'DiffNote', position: { new_path: 'src/index.ts', new_line: 12 } },
    { ...comment(11), type: 'DiffNote', author: { id: 2, username: 'review_bot' } },
  ] }])
  expect(await readGithub(commands(), 'github/pulls/1/thread/11')).toMatchObject({ messages: [
    { id: '10', from: 'alice', path: 'src/index.ts', line: 12 }, { id: '11', reply_to: '10', bot: true },
  ] })
})

it('polls mentions into separate Issue/MR candidates and never gives system notes authority', async () => {
  route('GET', 'todos', [
    { target_type: 'Issue', target: issue(1) }, { target_type: 'MergeRequest', target: mergeRequest(1) },
  ])
  route('GET', `${project}/issues/1`, issue(1))
  route('GET', `${project}/merge_requests/1`, mergeRequest(1))
  route('GET', `${project}/issues/1/notes`, [{ ...comment(2), system: true }])
  route('GET', `${project}/merge_requests/1/notes`, [])
  route('GET', `${project}/merge_requests/1/discussions`, [])
  const h = host()
  try {
    await pollRound(h.ctx)
    expect(h.received).toHaveLength(2)
    expect(new Set(h.received.flatMap(item => item.threads.map(thread => thread.id)))).toEqual(new Set(['issue-1', '1']))
    for (const item of h.received) expect(h.engine.candidate(item.id)?.strength).toBe('explicit')
    expect(h.received[0]!.id).not.toBe(h.received[1]!.id)
    expect(h.ctx.state.get(KV.github.cursor('issue-1'))).toBeDefined()
    expect(h.ctx.state.get(KV.github.cursor(1))).toBeDefined()
    const config = githubKind.schema.parse({ provider: 'gitlab' })
    expect(githubKind.environment!.values({ deployment, config, trigger: h.received.find(item => item.meta.isPr === false)! }).DSH_SUPERAGENT_GITHUB_NUMBER).toBe('1')
    expect(githubKind.environment!.values({ deployment, config, trigger: h.received.find(item => item.meta.isPr === true)! }).DSH_SUPERAGENT_GITHUB_PR_HEAD).toBe('refs/merge-requests/1/head')
  } finally { h.store.close() }
})

it('keeps a bot mention inferred when basic note authors omit bot and unlisted human mentions are explicit', async () => {
  const login = 'project_42_bot_review'
  const old = new Date(Date.now() - 60_000).toISOString()
  route('GET', 'todos', [{ target_type: 'Issue', target: issue(1) }])
  route('GET', `${project}/issues/1`, { ...issue(1), created_at: old })
  route('GET', `${project}/issues/1/notes`, [{ ...comment(90), author: { id: 2, username: login } }])
  route('GET', 'users/2', { id: 2, username: login, bot: true })
  const h = host()
  try {
    h.store.saveSettings(SettingsSchema.parse({ ...h.store.settings(), eval: { mode: 'auto' },
      policy: { sources: { github: { allowed: [], bots: [{ id: login }], admission: { comments: { unlistedAddressed: 'explicit' } } } } } }))
    h.ctx.state.set(KV.github.since, new Date(Date.now() - 10_000).toISOString())
    await pollRound(h.ctx)
    const trigger = h.received.find(item => item.meta.commentId === 90)!
    expect(h.engine.candidate(trigger.id)?.strength).toBe('inferred')
    expect(trigger).toMatchObject({ actor: { id: login }, human: false })
  } finally { h.store.close() }
})

it('rejects an unlisted bot even when the human allowed list and explicit admission would accept its username', async () => {
  const login = 'review_bot'
  route('GET', 'todos', [{ target_type: 'Issue', target: issue(1) }])
  route('GET', `${project}/issues/1`, { ...issue(1), created_at: new Date(Date.now() - 60_000).toISOString() })
  route('GET', `${project}/issues/1/notes`, [{ ...comment(90), author: { id: 2, username: login } }])
  route('GET', 'users/2', { id: 2, username: login, bot: true })
  const h = host()
  try {
    h.store.saveSettings(SettingsSchema.parse({ ...h.store.settings(), policy: { sources: { github: {
      allowed: [{ id: login }], bots: [], admission: { comments: { unlistedAddressed: 'explicit' } },
    } } } }))
    await pollRound(h.ctx)
    const trigger = h.received.find(item => item.meta.commentId === 90)!
    expect(h.engine.candidate(trigger.id)).toBeUndefined()
    expect(trigger.human).toBe(false)
  } finally { h.store.close() }
})

it.each(['unavailable', 'missing bot', 'wrong identity'] as const)('retries a note without authorization when its account lookup is %s', async failure => {
  const login = 'review_bot'
  route('GET', 'todos', [{ target_type: 'Issue', target: issue(1) }])
  route('GET', `${project}/issues/1`, { ...issue(1), created_at: new Date(Date.now() - 60_000).toISOString() })
  route('GET', `${project}/issues/1/notes`, [{ ...comment(90), author: { id: 2, username: login } }])
  if (failure === 'missing bot') route('GET', 'users/2', { id: 2, username: login })
  if (failure === 'wrong identity') route('GET', 'users/2', { id: 3, username: 'alice', bot: false })
  const h = host()
  try {
    await expect(pollRound(h.ctx)).rejects.toThrow()
    expect(h.received).toEqual([])
    expect(h.ctx.state.get(KV.github.cursor('issue-1'))).toBeUndefined()
    expect(h.ctx.state.get(KV.github.retries)).toHaveProperty('issue-1')
    route('GET', 'users/2', { id: 2, username: login, bot: true })
    await pollRound(h.ctx)
    expect(h.received).toMatchObject([{ human: false, actor: { id: login } }])
    expect(h.ctx.state.get(KV.github.cursor('issue-1'))).toBeDefined()
    expect(h.ctx.state.get(KV.github.retries)).toEqual({})
  } finally { h.store.close() }
})

it('retains failed reads for retry and deduplicates repeated pending to-dos', async () => {
  route('GET', 'todos', [{ target_type: 'Issue', target: issue(1) }])
  const h = host()
  try {
    await expect(pollRound(h.ctx)).rejects.toThrow('HTTP 404')
    expect(h.ctx.state.get(KV.github.retries)).toHaveProperty('issue-1')
    route('GET', `${project}/issues/1`, issue(1))
    route('GET', `${project}/issues/1/notes`, [])
    await pollRound(h.ctx)
    await pollRound(h.ctx)
    expect(h.store.read.triggerStats('').github?.received).toBe(1)
    expect(h.ctx.state.get(KV.github.retries)).toEqual({})
  } finally { h.store.close() }
})

it('observes repository-wide Issue/MR and discussion streams with stable ETags', async () => {
  paged(`${project}/issues`, [issue(1), issue(2), issue(3)])
  route('GET', `${project}/merge_requests`, [mergeRequest(1)])
  for (const iid of [1, 2, 3]) route('GET', `${project}/issues/${iid}/notes`, [comment(10 + iid)])
  route('GET', `${project}/merge_requests/1/notes`, [comment(20)])
  route('GET', `${project}/merge_requests/1/discussions`, [{ id: 'a', notes: [{ ...comment(30), type: 'DiffNote', position: { old_path: 'src/old.ts', old_line: 9 } }] }])
  const stream = await commands().api('issues?state=all&since=2000-01-01T00:00:00Z', '--include')
  expect(stream).toContain('issue-3')
  const etag = /^ETag: (.+)$/im.exec(stream)![1]!.trim()
  // Reuse immutable timestamps for an unchanged server response.
  await expect(commands().api('issues?state=all&since=2000-01-01T00:00:00Z', '--include', '-H', `If-None-Match: ${etag}`)).rejects.toMatchObject({ code: 304 })
  expect(await commands().pages(CommentSchema, 'issues/comments')).toHaveLength(4)
  expect(await commands().pages(CommentSchema, 'pulls/comments')).toMatchObject([{ id: 30, path: 'src/old.ts', line: 9 }])
})

it('binds an agent MR on the ticket branch and ends the ticket after merge', async () => {
  route('GET', 'todos', [{ target_type: 'Issue', target: issue(1) }])
  route('GET', `${project}/issues/1`, issue(1))
  route('GET', `${project}/issues/1/notes`, [])
  route('GET', `${project}/merge_requests/1`, { ...mergeRequest(1), author: { id: 7, username: 'agent_bot' } })
  const h = host()
  try {
    await pollRound(h.ctx)
    const trigger = h.received[0]!
    h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix', scope: 'Fix this', reason: 'asked' })
    const ticket = h.store.tickets.open()[0]!
    h.store.tickets.save({ ...ticket, execution: { name: 'fix', directory: '/w/fix', assignment: 'Fix' } })
    expect(claimPull(h.ctx, ticket.id, await readPull(h.ctx, 1))).toBeUndefined()
    expect(h.store.tickets.get(ticket.id)?.follows).toEqual([{ thread: 'github:1', own: true }])
    const assignment = h.store.tickets.get(ticket.id)!.assignments.at(-1)!
    h.engine.assignmentStarted(ticket.id, assignment.id)
    h.engine.report(ticket.id, { state: 'ready', summary: 'MR ready' })
    route('GET', `${project}/merge_requests/1`, { ...mergeRequest(1), author: { id: 7, username: 'agent_bot' }, state: 'merged', merged_at: at() })
    await observePull(h.ctx, await readPull(h.ctx, 1))
    expect(h.store.tickets.get(ticket.id)?.ended?.outcome).toBe('merged')
  } finally { h.store.close() }
})

it('reports commit status failure, running and unavailability without GitHub check runs', async () => {
  route('GET', `${project}/repository/commits/abc1234/statuses`, [{ id: 1, name: 'build', status: 'failed' }, { id: 2, name: 'test', status: 'running' }])
  expect(ciCounts(await pullChecks(commands(), 'abc1234'))).toEqual({ failed: 1, running: 1 })
  route('GET', `${project}/repository/commits/abc1234/statuses`, [])
  expect(ciSummary(await pullChecks(commands(), 'abc1234'), 'MR !1', 'github/pulls/1/checks')).toContain('CI unavailable')
  expect(requests.some(item => item.url.pathname.includes('check-runs'))).toBe(false)
})

it('uses the newest same-name status across paginated pipelines instead of an older success', async () => {
  paged(`${project}/repository/commits/abc1234/statuses`, [
    { id: 10, pipeline_id: 100, name: 'build', status: 'success' },
    { id: 11, pipeline_id: 100, name: 'test', status: 'success' },
    { id: 20, pipeline_id: 200, name: 'build', status: 'failed' },
    { id: 21, pipeline_id: 200, name: 'test', status: 'running' },
  ])
  const snapshot = await pullChecks(commands(), 'abc1234')
  expect(snapshot.statuses).toEqual([{ context: 'build', state: 'failure' }, { context: 'test', state: 'pending' }])
  expect(ciCounts(snapshot)).toEqual({ failed: 1, running: 1 })
  expect(ciSummary(snapshot, 'MR !1', 'github/pulls/1/checks')).toContain('CI failed')
})

it('reports recovery from the highest status ID even when pipeline pages arrive out of order', async () => {
  paged(`${project}/repository/commits/abc1234/statuses`, [
    { id: 30, pipeline_id: 300, name: 'build', status: 'failed' },
    { id: 50, pipeline_id: 500, name: 'build', status: 'success' },
    { id: 40, pipeline_id: 400, name: 'build', status: 'failed' },
  ])
  const snapshot = await pullChecks(commands(), 'abc1234')
  expect(snapshot.statuses).toEqual([{ context: 'build', state: 'success' }])
  expect(ciSummary(snapshot, 'MR !1', 'github/pulls/1/checks')).toContain('CI passed 1/1')
})

it('posts idempotent replies to the correct Issue or MR conversation', async () => {
  for (const [number, kind] of [['issue-1', 'issues'], [1, 'merge_requests']] as const) {
    route('GET', `${project}/${kind}/1/notes`, [])
    const posts: unknown[] = []
    routes.set(`POST ${project}/${kind}/1/notes`, async () => { posts.push(requests.at(-1)!.body); return { id: 99 } })
    const message = { id: `reply-${number}`, kind: 'reply' as const, text: 'Fixed', channel: githubChannel(number) }
    expect(await sendGithub({ commands: commands() }, message)).toBe('sent')
    const body = (posts[0] as { body: string }).body
    expect(body).toContain(`<!-- dsh-superagent:reply-${number} -->`)
    route('GET', `${project}/${kind}/1/notes`, [{ ...comment(99), author: { id: 7, username: 'agent_bot' }, body }])
    expect(await sendGithub({ commands: commands() }, message)).toBe('sent')
    expect(posts).toHaveLength(1)
  }
})

it('scopes Git credentials and CLI shims to the account, project and instance', async () => {
  await writeEnvironment(deployment, [])
  expect(readFileSync(workerGitConfig(directory), 'utf8')).not.toContain('test-agent-credential')
  await expect(commands().run(join(workerBin(directory), 'gh'), ['api', 'user'])).rejects.toThrow('uses GitLab')
  await expect(commands().run(join(workerBin(directory), 'glab'), ['api', 'user'])).rejects.toThrow('account-isolated')
  expect(JSON.parse(await commands().run(join(workerBin(directory), 'gitlab'), ['config']))).toEqual({ baseUrl })
  expect(await credential(`${baseUrl}/acme/team/widgets.git`)).toContain('password=test-agent-credential')
  for (const url of [`${baseUrl}/other/repo.git`, `${baseUrl.replace('127.0.0.1', 'localhost')}/acme/team/widgets.git`]) await expect(credential(url)).rejects.toThrow()
  expect(agentVariables(directory).GITLAB_TOKEN).toBeUndefined()
})

it('rejects unsafe API paths, cross-instance pagination and credential forwarding on redirects', async () => {
  for (const path of ['../user', '/user', 'https://elsewhere.test/user', 'issues/%2e%2e/user']) await expect(commands().api(path)).rejects.toThrow()
  routes.set(`GET ${project}/issues/1/notes`, async (_request, response) => {
    response.setHeader('Link', '<https://another.test/api/v4/user>; rel="next"')
    return [comment(1)]
  })
  await expect(commands().pages(CommentSchema, 'issues/issue-1/comments')).rejects.toThrow('left the configured API')
  routes.set(`GET ${project}/issues/1`, async (_request, response) => {
    response.statusCode = 302
    response.setHeader('Location', 'https://another.test/api/v4/user')
    return {}
  })
  await expect(commands().api('issues/issue-1')).rejects.toThrow('HTTP 302')
})

it('keeps native GitLab links in the panel, search results and terminal IM notices', () => {
  const url = `${baseUrl}/acme/team/widgets/-/issues/1`
  expect(githubAddress(url, deployment.repository, baseUrl, 'gitlab')).toEqual({ number: 'issue-1', pr: false })
  expect(githubAddress(url.replace('/git/', '/other/'), deployment.repository, baseUrl, 'gitlab')).toBeUndefined()
  expect(githubLink(githubChannel('issue-1').address, deployment)).toEqual({ url, label: { zh: 'GitLab #1', en: 'GitLab #1' } })
  expect(githubPage(deployment.repository, 1, true, baseUrl, 'gitlab')).toBe(`${baseUrl}/acme/team/widgets/-/merge_requests/1`)
  expect(githubKind.find!(url).threads).toEqual(['github:issue-1'])
  const ticket = { id: 'ticket', ended: { outcome: 'merged' }, follows: [{ thread: 'github:1', own: true, closed: { outcome: 'merged', at: at() } }], channels: [{ source: 'feishu', address: { chatId: 'chat' } }] }
  expect(pullEndNotices(ticket as never, '完成', deployment.repository, baseUrl, 'gitlab')[0]?.text).toContain(`[MR !1](${baseUrl}/acme/team/widgets/-/merge_requests/1)`)
})
