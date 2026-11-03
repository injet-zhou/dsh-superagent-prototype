/** Adapts Gitea REST records to the repository Source's existing Issue, PR, review and notification contracts. */
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'

type RecordValue = Record<string, unknown>
type Run = (program: string, args: string[]) => Promise<string>
const record = z.record(z.string(), z.unknown())
const timestamp = (item: unknown): number => {
  const parsed = record.safeParse(item)
  return parsed.success ? Date.parse(String(parsed.data.updated_at ?? parsed.data.created_at ?? '')) || 0 : 0
}

/** Retains the remote URL and identity; fills only fields whose names differ between the two REST APIs. */
export function giteaRecord(value: RecordValue, path: string, deployment: Pick<Deployment, 'repository' | 'github'>): RecordValue {
  const item = { ...value }
  const root = `${deployment.github.baseUrl}/api/v1/repos/${deployment.repository}`
  if (item.pull_request && typeof item.pull_request === 'object') {
    item.pull_request = { ...item.pull_request, url: `${root}/pulls/${item.number}` }
  }
  if (typeof item.html_url !== 'string' && typeof item.url === 'string') item.html_url = item.url
  if ('has_merged' in item) item.merged = item.has_merged
  if (/\/reviews(?:\?|$)/.test(path)) {
    if (item.state === 'COMMENT') item.state = 'COMMENTED'
    if (item.state === 'REQUEST_CHANGES') item.state = 'CHANGES_REQUESTED'
    item.submitted_at ??= item.created_at
  }
  if (typeof item.position === 'number') item.line ??= item.position
  if (item.state === 'warning') item.state = 'pending'
  // Gitea notifications name `issue_url` or `pull_url`, rather than GitHub's `url`.
  if (item.subject && typeof item.subject === 'object') {
    const subject = record.parse(item.subject)
    item.subject = { ...subject, url: subject.pull_url || subject.issue_url || subject.url }
  }
  return item
}

/** Runs the configured, account-isolated Gitea CLI; pagination and authentication stay in that CLI. */
export async function giteaApi(run: Run, deployment: Deployment, path: string, flags: string[]): Promise<string> {
  const url = new URL(path || '.', 'https://repository.invalid/')
  const resource = url.pathname.slice(1).replace(/\/$/, '')
  const query = url.searchParams
  const normalize = (item: unknown): unknown => {
    const parsed = record.safeParse(item)
    return parsed.success ? giteaRecord(parsed.data, path, deployment) : item
  }
  const request = async (suffix: string, options: string[] = [], all = false): Promise<unknown> => {
    const raw = await run(deployment.github.cli, ['api', `repos/${deployment.repository}${suffix ? `/${suffix}` : ''}`,
      ...options, ...all ? ['--paginate', '--slurp'] : []])
    const parsed: unknown = JSON.parse(raw)
    return all ? z.array(z.array(z.unknown())).parse(parsed).flat() : parsed
  }
  const list = async (suffix: string): Promise<RecordValue[]> => z.array(z.unknown()).parse(await request(suffix, [], true))
    .flatMap(item => { const parsed = record.safeParse(item); return parsed.success ? [parsed.data] : [] })
  const reviewComments = async (number: string): Promise<RecordValue[]> => {
    const reviews = await list(`pulls/${number}/reviews`)
    const comments: RecordValue[] = []
    for (const review of reviews) {
      if (typeof review.id !== 'number') continue
      for (const comment of await list(`pulls/${number}/reviews/${review.id}/comments`)) {
        comments.push({ ...giteaRecord(comment, path, deployment), pull_request_url: `${deployment.github.baseUrl}/api/v1/repos/${deployment.repository}/pulls/${number}` })
      }
    }
    return comments
  }
  const paginate = flags.includes('--paginate')
  const include = flags.includes('--include')
  const rawFile = flags.some(flag => /application\/vnd\.github\.raw/.test(flag))
  const writeFlags = flags.filter((flag, index) => flag !== '--include' && flag !== '--paginate' && flag !== '--slurp'
    && flag !== '-H' && flags[index - 1] !== '-H')
  const writing = writeFlags.includes('--method') && writeFlags[writeFlags.indexOf('--method') + 1] !== 'GET'
  let result: unknown
  if (writing) {
    result = await request(path, writeFlags)
  } else if (resource === 'pulls/comments' || /^pulls\/\d+\/comments$/.test(resource)) {
    const number = /^pulls\/(\d+)\/comments$/.exec(resource)?.[1]
    if (number) result = await reviewComments(number)
    else {
      const since = query.get('since')
      const params = new URLSearchParams({ state: 'all', type: 'pulls', sort: 'recentupdate', ...since ? { since } : {} })
      const pulls = await list(`issues?${params}`)
      const comments: RecordValue[] = []
      for (const pull of pulls) if (typeof pull.number === 'number') comments.push(...await reviewComments(String(pull.number)))
      result = comments.filter(item => !since || timestamp(item) >= Date.parse(since))
    }
    if (!paginate && !include) {
      const size = Number(query.get('per_page') ?? 20), page = Number(query.get('page') ?? 1)
      result = (result as RecordValue[]).slice((page - 1) * size, page * size)
    }
  } else {
    // Gitea uses limit and named Issue sort orders; fetch streams completely before advancing their timestamp cursors.
    if (query.has('per_page')) { query.set('limit', query.get('per_page')!); query.delete('per_page') }
    if (resource === 'issues' && query.get('sort') === 'updated') query.set('sort', 'recentupdate')
    query.delete('direction')
    const listing = /(?:^|\/)(issues|pulls|notifications|comments|reviews|statuses)$/.test(resource)
    const pageSize = Number(query.get('limit') ?? 20)
    const pageNumber = Number(query.get('page') ?? 1)
    if (listing) { query.delete('page'); query.set('limit', '50') }
    const suffix = /^commits\/[^/]+$/.test(resource) ? `git/${resource}` : resource
    const target = `${suffix}${query.size ? `?${query}` : ''}`
    result = await request(target, [], listing)
    if (rawFile) {
      const file = z.object({ encoding: z.literal('base64'), content: z.string() }).parse(result)
      return Buffer.from(file.content, 'base64').toString('utf8')
    }
    if (Array.isArray(result)) {
      result = result.map(normalize)
      if (!paginate && !include && listing) result = (result as RecordValue[]).slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
    }
    else result = normalize(result)
  }
  if (include && Array.isArray(result)) {
    result.sort((a: unknown, b: unknown) => timestamp(a) - timestamp(b))
  }
  const body = JSON.stringify(paginate && flags.includes('--slurp') ? [result] : result)
  // The Source needs an HTTP header boundary, but Gitea polling does not use GitHub's ETag or rate-limit headers.
  return include ? `HTTP/1.1 200 OK\r\n\r\n${body}` : body
}
