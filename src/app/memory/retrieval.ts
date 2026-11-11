/** Full-repository matching, with only the returned results bounded. SQL runs off the Runtime thread. */
import { spawn } from 'node:child_process'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import { MemoryId, MemoryQuery } from './types.ts'

export function searchPlan(repository: string, fts: boolean, input: z.input<typeof MemoryQuery>) {
  const { query, path, limit } = MemoryQuery.parse(input)
  const params: SQLInputValue[] = [repository]
  const scope = path ? ` AND (json_array_length(n.scope_json,'$.paths')=0 OR EXISTS (
    SELECT 1 FROM json_each(n.scope_json,'$.paths') p WHERE p.value=? OR substr(?,1,length(p.value)+1)=p.value||'/'))` : ''
  if (path) params.push(path, path)
  const where = `n.repository=? AND n.status='verified'${scope}`
  return fts && [...query].length >= 3
    ? { sql: `SELECT n.* FROM memory_note_fts f JOIN memory_note n ON f.id=n.id
        WHERE ${where} AND memory_note_fts MATCH ? ORDER BY rank,n.id LIMIT ?`, params: [...params, `"${query.replaceAll('"', '""')}"`, limit] }
    : { sql: `SELECT n.* FROM memory_note n WHERE ${where} AND instr(lower(n.title||' '||n.body),lower(?))>0
        ORDER BY n.updated_at DESC,n.id LIMIT ?`, params: [...params, query, limit] }
}

/** Host-owned SQL only. The read-only connection is terminated on deadline/cancellation, including native SQLite work. */
export async function readMatches(db: DatabaseSync, plan: ReturnType<typeof searchPlan>, signal?: AbortSignal) {
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file
  if (typeof file !== 'string' || !file) throw new Error('memory_retrieval_unavailable')
  const stop = AbortSignal.any([AbortSignal.timeout(500), ...signal ? [signal] : []])
  stop.throwIfAborted()
  const reader = spawn(process.execPath, ['--max-old-space-size=16', '-e', `
    const { DatabaseSync } = require('node:sqlite')
    let input = ''
    process.stdin.on('data', chunk => { input += chunk })
    process.stdin.on('end', () => {
      let db
      try {
        const plan = JSON.parse(input)
        db = new DatabaseSync(plan.file, { readOnly: true })
        db.exec('PRAGMA busy_timeout=100; PRAGMA query_only=ON')
        const rows = db.prepare(plan.sql).all(...plan.params)
        process.stdout.write(JSON.stringify(rows.map(row => ({ id: row.id, revision: row.revision }))))
      } catch { process.exitCode = 1 }
      finally { db?.close() }
    })
  `], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] })
  reader.stdin.on('error', () => {})
  reader.stdin.end(JSON.stringify({ file, ...plan }))
  let abort!: () => void
  try {
    return await new Promise<{ id: string; revision: number }[]>((resolve, reject) => {
      abort = () => { reject(new Error('memory_retrieval_unavailable')) }
      stop.addEventListener('abort', abort, { once: true })
      let output = ''
      reader.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 8192) { abort(); reader.kill('SIGKILL') } })
      reader.once('close', code => {
        if (code !== 0) return abort()
        let value: unknown
        try { value = JSON.parse(output) } catch { return abort() }
        const parsed = z.array(z.object({ id: MemoryId, revision: z.number().int().positive() })).max(10).safeParse(value)
        if (parsed.success) resolve(parsed.data); else abort()
      })
      reader.once('error', abort)
      if (stop.aborted) abort()
    })
  } finally { stop.removeEventListener('abort', abort); reader.kill('SIGKILL') }
}
