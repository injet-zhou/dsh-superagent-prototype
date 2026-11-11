/** Sanitization is applied before analysis and again before persistence; raw errors never enter health. */
import { createHash } from 'node:crypto'
import { NoteInput } from './types.ts'

export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function redact(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED TOKEN]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/\b((?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)|token|password|secret|api[_-]?key)["']?\s*[=:]\s*)["']?[^\s,"';}]+["']?/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, '[REDACTED URL]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED EMAIL]')
    .replace(/\b(?:\d[ -]?){11,16}\b/g, '[REDACTED NUMBER]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}
export const safeText = (text: string, limit: number): string => redact(text).slice(0, limit)
/** Validate again after redaction so sanitization cannot produce invalid persisted records. */
export function cleanNote(input: unknown): NoteInput {
  const parsed = NoteInput.parse(input)
  if (parsed.scope.paths.some(path => safeText(path, 300) !== path)) throw new Error('memory_sensitive_path')
  return NoteInput.parse({ ...parsed, title: safeText(parsed.title, 160), body: safeText(parsed.body, 8000),
    scope: { ...parsed.scope, ...parsed.scope.version ? { version: safeText(parsed.scope.version, 150) } : {} } })
}
