/** Durable, version-specific independent pull-request reviews. */
import { z } from 'zod'

export const ReviewResultSchema = z.object({
  verdict: z.enum(['clear', 'issues', 'incomplete']),
  summary: z.string().trim().min(1).max(6000),
  findings: z.array(z.object({
    severity: z.enum(['high', 'medium', 'low']),
    path: z.string().min(1).max(1000).refine(path => !/^[\/\\]|\\|[\r\n]|(^|\/)\.\.?(\/|$)/.test(path), 'Use a repository-relative file path'),
    line: z.number().int().positive(),
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(4000),
  }).strict()).max(30),
  checks: z.array(z.string().trim().min(1).max(1000)).max(30),
}).strict().refine(result => result.verdict === 'issues' ? result.findings.length > 0
  : result.verdict !== 'clear' || result.findings.length === 0, 'A clear review has no findings; issues requires at least one finding')
  .refine(result => new TextEncoder().encode(JSON.stringify(result)).length <= 48_000, 'Keep the complete review below 48,000 UTF-8 bytes')

export type ReviewResult = z.infer<typeof ReviewResultSchema>
export interface ReviewRun {
  id: string; ticketId: string; repository: string; number: number; url: string
  base: string; head: string; baseRef: string
  state: 'queued' | 'running' | 'completed' | 'stale'
  createdAt: string; attempt: number; sessionId?: string; directory?: string
  result?: ReviewResult; finishedAt?: string; publishedAt?: string; publicationUnavailableAt?: string; notifiedAt?: string
}
