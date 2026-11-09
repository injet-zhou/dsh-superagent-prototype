/** Failure-isolated repository memory facade; prompt rendering reads only the precomputed snapshot. */
import type { MemoryConfig } from '../../policy.ts'
import type { HealthEntry } from '../../infra/health.ts'
import type { Store } from '../store.ts'
import { MEMORY_BOUNDARY, MemoryQuery, type MemoryQuery as Query } from './types.ts'
import { MemoryStore } from './store.ts'

/** Owns one repository's optional memory, cached index and observable degradation. No Engine dependency. */
export class MemoryService {
  private database?: MemoryStore
  private snapshot = ''
  private config: MemoryConfig
  private problem?: string
  constructor(private readonly store: Store, private readonly health: HealthEntry) {
    this.config = store.settings().memory
    this.report()
  }
  configure(config: MemoryConfig): void { this.config = config; this.refresh() }
  bind(repository: string): void {
    try { this.database = new MemoryStore(this.store, repository); this.refresh() }
    catch { this.problem = 'memory_repository_mismatch'; this.report() }
  }
  enabled(): boolean { return this.config.enabled && this.config.retrieval && !!this.database && this.problem !== 'memory_repository_mismatch' }
  /** No database, file or model access on this synchronous prompt path. */
  index(): string { return this.enabled() ? this.snapshot : '' }
  /** Rebuild the short snapshot outside prompt rendering. Titles remain JSON data, never instructions. */
  refresh(): void {
    if (!this.database || this.problem === 'memory_repository_mismatch') { this.report(); return }
    try {
      const notes = this.database.list('verified', 20)
      const lines = notes.map(note => JSON.stringify({ id: note.id, title: note.title, read: `memory/${note.id}` }))
      // UTF-8 bytes form a conservative token upper bound; no unverified tokenizer estimate is presented as an exact count.
      const prefix = `${MEMORY_BOUNDARY}\nSearch with orchestrator_memory_search; read with orchestrator_read memory/<id>.\n`
      let body = prefix
      for (const line of lines) { if (Buffer.byteLength(body + line + '\n') > 600) break; body += line + '\n' }
      this.snapshot = body
      this.problem = undefined
    } catch { this.problem = 'memory_index_unavailable'; this.snapshot = '' }
    this.report()
  }
  /** Host-only import/publisher access; never provided to model tools. */
  publisher(): MemoryStore {
    if (!this.database || this.problem === 'memory_repository_mismatch') throw new Error('memory_unavailable')
    return this.database
  }
  async search(input: Query, signal?: AbortSignal) {
    const parsed = MemoryQuery.parse(input)
    if (!this.enabled() || signal?.aborted) return { boundary: MEMORY_BOUNDARY, items: [], degraded: this.problem ?? 'memory_disabled' }
    try {
      const start = performance.now()
      const items = this.publisher().search(parsed).map(note => ({ id: note.id, title: note.title, snippet: note.body.slice(0, 300),
        kind: note.kind, status: note.status, revision: note.revision, scope: note.scope, verifiedAt: note.verifiedAt,
        evidenceCount: this.publisher().get(note.id)!.evidence.length, read: `memory/${note.id}` }))
      if (signal?.aborted || performance.now() - start > 100) throw new Error('timeout')
      return { boundary: MEMORY_BOUNDARY, items }
    } catch { this.degraded('memory_retrieval_unavailable'); return { boundary: MEMORY_BOUNDARY, items: [], degraded: 'memory_retrieval_unavailable' } }
  }
  read(id: string): string {
    if (!this.enabled()) return JSON.stringify({ boundary: MEMORY_BOUNDARY, degraded: this.problem ?? 'memory_disabled' })
    try {
      const details = this.publisher().get(id)
      if (!details || details.note.status !== 'verified') return JSON.stringify({ boundary: MEMORY_BOUNDARY, missing: true })
      return JSON.stringify({ boundary: MEMORY_BOUNDARY, ...details })
    } catch { this.degraded('memory_read_unavailable'); return JSON.stringify({ boundary: MEMORY_BOUNDARY, degraded: 'memory_read_unavailable' }) }
  }
  degraded(code: string): void { this.problem = code; this.report() }
  private report(): void {
    this.health.set({ state: !this.config.enabled ? 'paused' : this.problem ? 'error' : 'ready',
      detail: !this.config.enabled ? 'Memory disabled; automatic model budget defaults to 0' : this.problem
        ?? (this.database?.fts ? 'Memory ready; FTS5' : 'Memory ready; bounded substring fallback'), at: new Date().toISOString() })
  }
}
