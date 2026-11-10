/** Failure-isolated repository memory facade; prompt rendering reads only the precomputed snapshot. */
import type { MemoryConfig } from '../../policy.ts'
import type { HealthEntry } from '../../infra/health.ts'
import type { Store } from '../store.ts'
import { KV } from '../../kv.ts'
import { MEMORY_BOUNDARY, MemoryQuery, MemoryReview, type MemoryBrowse, type MemoryHealth, type MemoryQuery as Query } from './types.ts'
import { MemoryStore } from './store.ts'
import { readMatches, searchPlan } from './retrieval.ts'

/** Owns one repository's optional memory, cached index and observable degradation. No Engine dependency. */
export class MemoryService {
  private database?: MemoryStore
  private snapshot = ''
  private config: MemoryConfig
  private problem?: string
  private analyzer = false
  private summary = ''
  private remainingCalls = 0
  private retrieving = false
  private readonly listeners = new Set<() => void>()
  private projectionProblem?: string
  private analysisController = new AbortController()
  private maintenance?: { consolidate(): boolean; rebuild(): Promise<void> }
  constructor(private readonly store: Store, private readonly health: HealthEntry) {
    this.config = store.settings().memory
    this.report()
  }
  configure(config: MemoryConfig): boolean {
    if (JSON.stringify(config) === JSON.stringify(this.config)) return false
    const enabled = this.enabled()
    this.analysisController.abort(); this.analysisController = new AbortController()
    this.config = config; this.refresh()
    return enabled !== this.enabled()
  }
  analyzerAvailable(available: boolean): void { this.analyzer = available; this.report() }
  analysisSignal(): AbortSignal { return this.analysisController.signal }
  maintenanceWith(maintenance: { consolidate(): boolean; rebuild(): Promise<void> }): void { this.maintenance = maintenance }
  requestConsolidation(): { queued: boolean } {
    if (!this.dreamingEnabled() || !this.maintenance) return { queued: false }
    try { return { queued: this.maintenance.consolidate() } }
    catch { this.degraded('memory_maintenance_unavailable'); return { queued: false } }
  }
  async rebuildProjection(): Promise<{ rebuilt: boolean }> {
    if (!this.active() || !this.maintenance) return { rebuilt: false }
    try { await this.maintenance.rebuild(); return { rebuilt: !this.projectionProblem } }
    catch { this.degraded('memory_rebuild_failed'); return { rebuilt: false } }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  projectionResult(failed: boolean): void { this.projectionProblem = failed ? 'memory_projection_failed' : undefined; this.report() }
  bind(repository: string): void {
    try { this.database = new MemoryStore(this.store, repository, () => { this.refresh() }); this.refresh() }
    catch { this.problem = 'memory_repository_mismatch'; this.report() }
  }
  active(): boolean { return this.config.enabled && !!this.database && this.problem !== 'memory_repository_mismatch' }
  enabled(): boolean { return this.active() && this.config.retrieval }
  captureEnabled(): boolean { return this.active() && this.config.autoCapture }
  dreamingEnabled(): boolean { return this.active() && this.config.dreaming }
  /** No database, file or model access on this synchronous prompt path. */
  index(): string { return this.enabled() ? this.snapshot : '' }
  /** Rebuild the short snapshot outside prompt rendering. Titles remain JSON data, never instructions. */
  refresh(): void {
    if (!this.database || this.problem === 'memory_repository_mismatch') { this.report(); return }
    try {
      const notes = this.database.list('verified', 20)
      const candidates = this.database.list('candidate', 200).length
      const partial = Number(this.store.db.prepare("SELECT count(*) AS n FROM memory_capture_checkpoint WHERE json_extract(cursor_json,'$.partial')=1").get()?.n ?? 0)
      const usage = this.store.get(KV.memory.usage)
      this.remainingCalls = Math.max(0, this.config.dailyCallBudget - (usage?.day === new Date().toISOString().slice(0, 10) ? usage.calls : 0))
      this.summary = `; ${candidates}${candidates === 200 ? '+' : ''} candidates awaiting review; ${this.remainingCalls} model calls remaining today`
      const lines = notes.map(note => JSON.stringify({ id: note.id, title: note.title, read: `memory/${note.id}` }))
      // UTF-8 bytes form a conservative token upper bound; no unverified tokenizer estimate is presented as an exact count.
      const prefix = `${MEMORY_BOUNDARY}\nSearch with orchestrator_memory_search; read with orchestrator_read memory/<id>.\n`
      let body = prefix
      for (const line of lines) { if (Buffer.byteLength(body + line + '\n') > 600) break; body += line + '\n' }
      this.snapshot = body
      const unresolved = this.store.get(KV.memory.evidenceAudit)?.checks.some(check => !['available', 'host-attested'].includes(check.status))
      this.problem = partial ? 'partial_capture' : unresolved ? 'memory_evidence_unavailable' : undefined
    } catch { this.problem = 'memory_index_unavailable'; this.snapshot = '' }
    this.report()
    for (const listener of this.listeners) {
      try { listener() } catch { this.degraded('memory_maintenance_unavailable') }
    }
  }
  /** Host-only import/publisher access; never provided to model tools. */
  publisher(): MemoryStore {
    if (!this.database || this.problem === 'memory_repository_mismatch') throw new Error('memory_unavailable')
    return this.database
  }
  /** Management access remains available when retrieval is disabled; all paths stay bound to this Runtime. */
  browse(input: MemoryBrowse) { return { ...this.publisher().browse(input), health: this.status() } }
  details(id: string) { return this.publisher().get(id) }
  review(id: string, input: MemoryReview) {
    const review = MemoryReview.parse(input), memory = this.publisher()
    if (review.action === 'confirm') return memory.confirm(id, review.revision, review.reason)
    memory.update(id, review.revision, { status: review.action === 'stale' ? 'stale' : 'retracted' }, [], review.reason, `human-review:${id}:${review.revision + 1}`)
    return memory.get(id)!
  }
  status(): MemoryHealth {
    const day = new Date().toISOString().slice(0, 10), usage = this.store.get(KV.memory.usage)
    const usedCalls = usage?.day === day ? usage.calls : 0
    const pending = (kind: string) => Number(this.store.db.prepare('SELECT count(*) AS n FROM effect WHERE kind=?').get(kind)?.n ?? 0)
    return { enabled: this.config.enabled, fts: !!this.database?.fts, dailyCallBudget: this.config.dailyCallBudget, usedCalls,
      retrieval: this.config.retrieval, autoCapture: this.config.autoCapture, dreaming: this.config.dreaming, analyzerAvailable: this.analyzer,
      remainingCalls: Math.max(0, this.config.dailyCallBudget - usedCalls), capturePending: pending('memory-capture'), consolidationPending: pending('memory-consolidate'),
      partialCaptures: Number(this.store.db.prepare("SELECT count(*) AS n FROM memory_capture_checkpoint WHERE json_extract(cursor_json,'$.partial')=1").get()?.n ?? 0),
      lastCaptureAt: this.store.get(KV.memory.lastCapturedAt) ?? null, lastConsolidationAt: this.store.get(KV.memory.lastConsolidatedAt) ?? null,
      ...this.problem || this.projectionProblem ? { problem: this.problem ?? this.projectionProblem } : {} }
  }
  async search(input: Query, signal?: AbortSignal) {
    const parsed = MemoryQuery.parse(input)
    if (!this.enabled() || signal?.aborted) return { boundary: MEMORY_BOUNDARY, items: [], degraded: this.problem ?? 'memory_disabled' }
    if (this.retrieving) return { boundary: MEMORY_BOUNDARY, items: [], degraded: 'memory_retrieval_busy' }
    this.retrieving = true
    try {
      const memory = this.publisher()
      const matches = await readMatches(this.store.db, searchPlan(memory.repository, memory.fts, parsed), AbortSignal.any([this.analysisSignal(), ...signal ? [signal] : []]))
      const items = matches.flatMap(match => {
        const note = memory.get(match.id)?.note
        return note?.status === 'verified' && note.revision === match.revision ? [note] : []
      }).map(note => ({ id: note.id, title: note.title, snippet: note.body.slice(0, 300),
        kind: note.kind, status: note.status, revision: note.revision, scope: note.scope, verifiedAt: note.verifiedAt,
        evidenceCount: this.publisher().evidenceCount(note.id), read: `memory/${note.id}` }))
      return { boundary: MEMORY_BOUNDARY, items }
    } catch { this.degraded('memory_retrieval_unavailable'); return { boundary: MEMORY_BOUNDARY, items: [], degraded: 'memory_retrieval_unavailable' } }
    finally { this.retrieving = false }
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
    const automatic = this.config.enabled && (this.config.autoCapture || this.config.dreaming)
    const problem = this.problem ?? this.projectionProblem ?? (automatic && !this.analyzer ? 'memory_analyzer_unavailable'
      : automatic && !this.remainingCalls ? 'memory_budget_exhausted' : undefined)
    this.health.set({ state: !this.config.enabled ? 'paused' : problem ? 'error' : 'ready',
      detail: !this.config.enabled ? 'Memory disabled; automatic model budget defaults to 0' : problem
        ?? ((this.database?.fts ? 'Memory ready; FTS5' : 'Memory ready; bounded substring fallback') + this.summary), at: new Date().toISOString() })
  }
}
