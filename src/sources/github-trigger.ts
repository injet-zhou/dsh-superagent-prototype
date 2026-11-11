/** Normalizes GitHub issues, pull requests, comments, reviews, and CI transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'github'
/** GitLab has separate Issue/MR IID sequences; prefix Issue IDs while keeping native MR numbers for worker reports. */
export const RepositoryNumberSchema = z.union([z.number(), z.string().regex(/^issue-[1-9]\d*$/)])
export type RepositoryNumber = z.infer<typeof RepositoryNumberSchema>
export const repositoryNumber = (value: string): RepositoryNumber => value.startsWith('issue-') ? value : Number(value)
export const displayNumber = (value: RepositoryNumber): string => typeof value === 'string' ? `#${value.slice(6)}` : `#${value}`
/** GitHub reply address: issue/PR conversation, or a review thread when `url` points at a discussion comment. */
export const githubChannel = (number: RepositoryNumber, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `github:${number}`, address: { number: String(number), ...(url ? { url } : {}) } })
export function githubPage(repository: string, number: RepositoryNumber, pr = false, baseUrl = 'https://github.com', provider?: string): string {
  if (provider === 'gitlab') return `${baseUrl}/${repository}/-/${pr ? 'merge_requests' : 'issues'}/${String(number).replace(/^issue-/, '')}`
  let section = 'issues'
  if (pr) section = baseUrl === 'https://github.com' ? 'pull' : 'pulls'
  return `${baseUrl}/${repository}/${section}/${number}`
}
/** Parses a web or API URL for an Issue, PR, or review comment in `repository`; returns undefined for other URLs or repositories. */
export function githubAddress(url: string, repository: string, baseUrl?: string): { number: number; pr: boolean; discussion?: number } | undefined
export function githubAddress(url: string, repository: string, baseUrl: string | undefined, provider: string | undefined): { number: RepositoryNumber; pr: boolean; discussion?: number } | undefined
export function githubAddress(url: string, repository: string, baseUrl = 'https://github.com', provider?: string): { number: RepositoryNumber; pr: boolean; discussion?: number } | undefined {
  if (provider === 'gitlab') {
    const root = `${baseUrl}/${repository}/-/`
    if (!url.startsWith(root)) return undefined
    const match = /^(issues|merge_requests)\/([1-9]\d*)\/?(?:#note_\d+)?$/.exec(url.slice(root.length))
    return match ? { number: match[1] === 'issues' ? `issue-${match[2]}` : Number(match[2]), pr: match[1] === 'merge_requests' } : undefined
  }
  if (baseUrl !== 'https://github.com') {
    const roots = [`${baseUrl}/${repository}/`, `${baseUrl}/api/v1/repos/${repository}/`]
    const root = roots.find(root => url.toLowerCase().startsWith(root.toLowerCase()))
    if (!root) return undefined
    const match = /^(issues|pulls)\/(\d+)\/?(?:#[\w-]+)?$/i.exec(url.slice(root.length))
    return match ? { number: Number(match[2]), pr: match[1]!.toLowerCase() === 'pulls' } : undefined
  }
  const address = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues', ...match[4] ? { discussion: Number(match[4]) } : {} }
}
/** GitHub returns a deleted account as `null` and displays it as `ghost`. */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/**
 * A GitHub comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
 * line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  diff_position: z.number().nullish(), original_diff_position: z.number().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>
/** An Issue as `issues/<number>` returns it; GitHub sets `pull_request` when the number is a pull request. */
export const IssueSchema = CommentSchema.extend({
  number: RepositoryNumberSchema, title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
export interface PullRef { number: RepositoryNumber; isPr: boolean; url?: string; prAuthor?: string }
/**
 * True when GitHub reports the account as a regular user rather than a bot or GitHub App.
 * Review bots running under ordinary user accounts count as human here; the prompts identify which accounts are automated.
 */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
/** Formats an inline review comment's file:line and the trailing lines of its diff hunk, which GitHub ends at the commented line. */
export function reviewPlace(comment: GithubComment): string {
  const line = comment.line ?? comment.original_line
  const position = comment.diff_position ?? comment.original_diff_position
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  const place = line != null ? `${comment.path}:${line}` : comment.path
  const diff = line == null && position != null ? `Diff position ${position} (not a file line number)` : ''
  return [place, diff, hunk].filter(Boolean).join('\n')
}
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: { login: string; type?: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user) && !sameName(user.login, agent) })
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
export function commentTrigger(comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = key('github-comment', comment.html_url ?? `github:${ref.number}`, String(comment.id), version)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: String(ref.number) }], ...author(comment.user, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
}
/**
 * Builds the trigger for a newly opened Issue's title and body.
 * The ID is the same as when Issue bodies were stored previously, so already-stored bodies are not ingested again.
 */
export function issueTrigger(issue: Opened, agent: string): Trigger {
  const body = issue.body ?? ''
  return { id: key('github-issue', String(issue.number)), source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.number) }], ...author(issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(issue.number, issue.html_url), url: issue.html_url, meta: { number: issue.number, isPr: false, kind: 'issue' } }
}
/**
 * Builds the trigger for a newly opened PR's title and description.
 * PR and Issue numbers share one sequence in GitHub and never collide, so this reuses `issueTrigger`'s `github-issue` ID format.
 */
export function pullTrigger(pull: Opened, agent: string): Trigger {
  return { ...issueTrigger(pull, agent), meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
}
/** Builds a trigger for a default-branch CI transition; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('github-ci', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision } }
}
export function ciTrigger(pr: { number: number; html_url: string; user: { login: string } }, revision: number, summary: string): Trigger {
  return { id: key('github-ci', String(pr.number), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: String(pr.number) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: githubChannel(pr.number), url: pr.html_url,
    meta: { number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision } }
}
