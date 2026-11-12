/** Normalizes GitLab REST v4 into the existing repository Source without merging Issue and MR IID sequences. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'

const record = z.record(z.string(), z.unknown())
type Item = z.infer<typeof record>
type Run = (program: string, args: string[]) => Promise<string>
const Account = z.object({ id: z.number().int().positive(), username: z.string(), bot: z.boolean() })
const CommitStatus = z.looseObject({ id: z.number().int().positive(), name: z.string(), status: z.string() })
const at = (value: unknown): number => {
  const item = record.safeParse(value)
  return item.success ? Date.parse(String(item.data.updated_at ?? item.data.created_at ?? '')) || 0 : 0
}

/** Each operation has a shared deadline in Commands; the CLI also bounds HTTP requests and follows server pagination. */
export async function gitlabApi(run: Run, deployment: Deployment, path: string, flags: string[]): Promise<string> {
  const project = `projects/${encodeURIComponent(deployment.repository)}`
  const web = `${deployment.github.baseUrl}/${deployment.repository}/-`
  const url = new URL(path || '.', 'https://repository.invalid/')
  const resource = url.pathname.slice(1).replace(/\/$/, '')
  const query = url.searchParams
  const paginate = flags.includes('--paginate'), include = flags.includes('--include')
  const raw = flags.some(flag => /application\/vnd\.github\.raw/.test(flag))
  const method = flags[flags.indexOf('--method') + 1]
  const writing = flags.includes('--method') && method !== 'GET'
  const writeFlags = flags.filter((flag, index) => !['--include', '--paginate', '--slurp', '-H'].includes(flag) && flags[index - 1] !== '-H')
  const request = async (suffix: string, all = false, options: string[] = [], global = false): Promise<unknown> => {
    const result: unknown = JSON.parse(await run(deployment.github.cli, ['api', global ? suffix : `${project}${suffix ? `/${suffix}` : ''}`,
      ...options, ...all ? ['--paginate', '--slurp'] : []]))
    return all ? z.array(z.array(z.unknown())).parse(result).flat() : result
  }
  const list = async (suffix: string): Promise<Item[]> => z.array(record).parse(await request(suffix, true))
  // Basic author records omit bot. Verify each account once per operation; lookup failures must retain read cursors.
  const accounts = new Map<number, Promise<z.infer<typeof Account>>>()
  const user = async (value: unknown): Promise<Item> => {
    if (value == null) return { login: 'ghost', type: 'Bot' }
    const item = Account.partial({ bot: true }).parse(value)
    let bot = item.bot
    if (bot === undefined) {
      let account = accounts.get(item.id)
      if (!account) {
        account = request(`users/${item.id}`, false, [], true).then(value => Account.parse(value))
        accounts.set(item.id, account)
      }
      const verified = await account
      if (verified.id !== item.id || verified.username !== item.username) throw new Error('GitLab author identity changed during read')
      bot = verified.bot
    }
    return { ...item, login: item.username, type: bot ? 'Bot' : 'User' }
  }
  const page = async (item: Item, pr: boolean): Promise<Item> => {
    const number = pr ? item.iid : `issue-${item.iid}`
    return { ...item, number, body: item.description, user: await user(item.author), html_url: item.web_url,
      state: item.state === 'opened' || item.state === 'locked' ? 'open' : 'closed',
      labels: Array.isArray(item.labels) ? item.labels.map(name => ({ name })) : [],
      ...pr ? { pull_request: { url: item.web_url }, merged: item.state === 'merged',
        head: { sha: item.sha ?? (item.diff_refs as Item | null)?.head_sha ?? '', ref: item.source_branch,
          repo: item.source_project_id === item.target_project_id ? { full_name: deployment.repository } : null },
        base: { ref: item.target_branch } } : {} }
  }
  const note = async (item: Item, iid: string, pr: boolean, root?: number): Promise<Item> => {
    const position = item.position && typeof item.position === 'object' ? record.parse(item.position) : undefined
    const target = `${web}/${pr ? 'merge_requests' : 'issues'}/${iid}`
    return { ...item, user: await user(item.author), html_url: `${target}#note_${item.id}`, issue_url: target,
      ...pr ? { pull_request_url: target } : {},
      ...position ? { path: position.new_path ?? position.old_path, line: position.new_line ?? position.old_line } : {},
      ...root && item.id !== root ? { in_reply_to_id: root } : {} }
  }
  const notes = async (iid: string, pr: boolean): Promise<Item[]> => {
    const result: Item[] = []
    for (const item of await list(`${pr ? 'merge_requests' : 'issues'}/${iid}/notes?sort=asc&order_by=updated_at&per_page=100`)) {
      if (!item.system && item.type !== 'DiffNote' && !item.position) result.push(await note(item, iid, pr))
    }
    return result
  }
  const discussions = async (iid: string): Promise<Item[]> => {
    const result: Item[] = []
    for (const discussion of await list(`merge_requests/${iid}/discussions?per_page=100`)) {
      const items = z.array(record).parse(discussion.notes).filter(item => !item.system)
      if (!items.some(item => item.type === 'DiffNote' || item.position)) continue
      const root = items[0]?.id
      for (const item of items) result.push(await note(item, iid, true, typeof root === 'number' ? root : undefined))
    }
    return result
  }
  const recent = async (pr: boolean): Promise<Item[]> => {
    const params = new URLSearchParams({ state: 'all', scope: 'all', order_by: 'updated_at', sort: 'asc', per_page: '100' })
    if (query.get('since')) params.set('updated_after', query.get('since')!)
    return list(`${pr ? 'merge_requests' : 'issues'}?${params}`)
  }
  let result: unknown
  const target = /^(issues|pulls)\/(issue-)?([1-9]\d*)(?:\/(comments|reviews))?$/.exec(resource)
  if (target) {
    const [, kind, issuePrefix, iid, section] = target
    const pr = !issuePrefix
    if (kind === 'pulls' && !pr) throw new Error('A merge request requires its native IID')
    const endpoint = `${pr ? 'merge_requests' : 'issues'}/${iid}`
    if (writing) {
      if (section !== 'comments' || method !== 'POST') throw new Error('Unsupported GitLab repository write')
      result = await request(`${endpoint}/notes`, false, writeFlags)
    } else if (section === 'reviews') result = [] // Approval rules vary by edition; never invent a review decision.
    else if (section === 'comments') result = kind === 'pulls' ? await discussions(iid!) : await notes(iid!, pr)
    else result = await page(record.parse(await request(endpoint)), pr)
  } else if (resource === 'notifications') {
    const info = z.object({ id: z.number() }).parse(await request(''))
    result = (await listGlobalTodos()).filter(item => item.target_type === 'Issue' || item.target_type === 'MergeRequest').map(item => ({
      repository: { full_name: deployment.repository }, subject: { url: (item.target as Item | undefined)?.web_url ?? item.target_url } }))
    async function listGlobalTodos(): Promise<Item[]> {
      return z.array(record).parse(await request(`todos?project_id=${info.id}&state=pending&per_page=100`, true, [], true))
    }
  } else if (resource === 'issues') {
    const items: Item[] = []
    for (const pr of [false, true]) for (const item of await recent(pr)) items.push(await page(item, pr))
    result = items
  } else if (resource === 'issues/comments' || resource === 'pulls/comments') {
    const resultNotes: Item[] = []
    for (const pr of resource === 'pulls/comments' ? [true] : [false, true]) {
      for (const item of await recent(pr)) resultNotes.push(...await (resource === 'pulls/comments' ? discussions(String(item.iid)) : notes(String(item.iid), pr)))
    }
    result = resultNotes
  } else if (/^commits\/[^/]+\/statuses$/.test(resource)) {
    const sha = resource.split('/')[1]!
    // Fetch every page before ordering: the consumer keeps the first status per name, while GitLab defaults to ascending IDs.
    const statuses = (await list(`repository/commits/${sha}/statuses?per_page=100`)).map(item => CommitStatus.parse(item))
    result = statuses.sort((a, b) => b.id - a.id).map(item => ({ ...item, context: item.name,
      state: ({ failed: 'failure', canceled: 'error', running: 'pending', created: 'pending', scheduled: 'pending', manual: 'pending', waiting_for_resource: 'pending', skipped: 'success' } as Record<string, string>)[String(item.status)] ?? item.status }))
  } else if (resource.startsWith('commits/')) {
    const item = record.parse(await request(`repository/${resource}`))
    result = { ...item, sha: item.id }
  } else if (resource === 'contents' || resource.startsWith('contents/')) {
    const filePath = decodeURIComponent(resource.slice('contents/'.length))
    const ref = encodeURIComponent(query.get('ref') ?? 'HEAD')
    if (raw) {
      const file = z.object({ encoding: z.literal('base64'), content: z.string() }).parse(await request(`repository/files/${encodeURIComponent(filePath)}?ref=${ref}`))
      return Buffer.from(file.content, 'base64').toString('utf8')
    }
    result = await request(`repository/tree?ref=${ref}&per_page=100&path=${encodeURIComponent(filePath)}`, true)
  } else if (!resource) result = await request('')
  else throw new Error(`Unsupported GitLab repository resource: ${resource}`)
  if (Array.isArray(result)) {
    let items: unknown[] = result
    const since = query.get('since')
    if (since && resource !== 'notifications') items = items.filter(item => at(item) >= Date.parse(since))
    if (include) items.sort((a, b) => at(a) - at(b))
    if (!paginate && !include && resource !== 'contents' && !resource.startsWith('contents/')) {
      const size = Number(query.get('per_page') ?? 20), offset = (Number(query.get('page') ?? 1) - 1) * size
      items = items.slice(offset, offset + size)
    }
    result = items
  }
  const body = JSON.stringify(paginate && flags.includes('--slurp') ? [result] : result)
  if (!include) return body
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`
  const conditional = flags.find((flag, index) => flags[index - 1] === '-H' && /^If-None-Match:/i.test(flag))
  return conditional?.slice(conditional.indexOf(':') + 1).trim() === etag
    ? `HTTP/1.1 304 Not Modified\r\nETag: ${etag}\r\n\r\n`
    : `HTTP/1.1 200 OK\r\nETag: ${etag}\r\n\r\n${body}`
}
