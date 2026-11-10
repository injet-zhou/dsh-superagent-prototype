/** Repository-bound memory persistence on the Runtime's existing SQLite connection. */
import type { SQLInputValue } from 'node:sqlite'
import type { Store } from '../store.ts'
import { KV } from '../../kv.ts'
import { EvidenceInput, MemoryBrowse, MemoryId, MemoryQuery, MemoryStatus, NoteInput, type MemoryDetails, type MemoryEvidence, type MemoryNote, type MemoryPage } from './types.ts'
import { cleanNote, fingerprint, safeText } from './security.ts'
import { searchPlan } from './retrieval.ts'
import { executionReceipt } from './attestation.ts'

/** A rejected optimistic update; callers must reread and form a new proposal. */
export class MemoryConflict extends Error {}
/** The sole host publisher of notes, evidence and immutable revisions for one bound repository. */
export class MemoryStore {
  readonly fts: boolean
  constructor(readonly store: Store, readonly repository: string, private readonly changed: () => void = () => {}) {
    const bound = store.get(KV.memory.repository)
    if (bound && bound !== repository) throw new Error('memory_repository_mismatch')
    if (!bound) store.set(KV.memory.repository, repository)
    this.fts = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_note_fts'").get()
  }
  get(id: string): MemoryDetails | undefined {
    MemoryId.parse(id)
    const row = this.store.db.prepare('SELECT * FROM memory_note WHERE id=? AND repository=?').get(id, this.repository)
    if (!row) return undefined
    const note = this.note(row)
    const evidence = this.store.db.prepare('SELECT * FROM memory_evidence WHERE note_id=? ORDER BY id LIMIT 100').all(id).map(row => this.evidence(row))
    const revisions = this.store.db.prepare('SELECT revision,action,before_json,after_json,reason,source_job_id,at FROM memory_revision WHERE note_id=? ORDER BY revision DESC LIMIT 100').all(id)
    const executions = evidence.flatMap(item => { const receipt = executionReceipt(this.store, this.repository, item); return receipt ? [receipt] : [] })
    return { note, evidence, ...executions.length ? { executions } : {}, revisions: revisions.map(row => ({ revision: Number(row.revision), action: String(row.action), reason: String(row.reason),
      at: String(row.at), source_job_id: String(row.source_job_id), before_json: row.before_json === null ? null : String(row.before_json), after_json: String(row.after_json) })) }
  }
  private evidence(row: Record<string, SQLInputValue>): MemoryEvidence {
    return {
      id: String(row.id), noteId: String(row.note_id), ticketId: String(row.ticket_id), sessionId: String(row.session_id), eventRef: String(row.event_ref),
      kind: EvidenceInput.shape.kind.parse(row.evidence_kind), excerpt: String(row.excerpt_redacted),
      supportsVerification: row.supports_verification === 1, capturedAt: String(row.captured_at),
      ...row.claim_fingerprint ? { claimFingerprint: String(row.claim_fingerprint) } : {},
      ...row.source_commit ? { sourceCommit: String(row.source_commit) } : {},
    }
  }
  private note(row: Record<string, SQLInputValue>): MemoryNote {
    return { ...NoteInput.parse({ kind: row.kind, title: row.title, body: row.body, scope: JSON.parse(String(row.scope_json)) }),
      id: String(row.id), repository: String(row.repository), status: MemoryStatus.parse(row.status), revision: Number(row.revision),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...row.verified_at ? { verifiedAt: String(row.verified_at) } : {} }
  }
  list(status: MemoryNote['status'] = 'verified', limit = 200): MemoryNote[] {
    return this.store.db.prepare('SELECT * FROM memory_note WHERE repository=? AND status=? ORDER BY updated_at DESC,id LIMIT ?')
      .all(this.repository, status, Math.min(limit, 200)).map(row => this.note(row))
  }
  /** Management-only browsing includes invalidated notes, with bounded pages and no model work. */
  browse(input: MemoryBrowse): MemoryPage {
    const { query, status, offset, limit } = MemoryBrowse.parse(input)
    const params: SQLInputValue[] = [this.repository]
    let where = 'repository=?'
    if (status !== 'all') { where += ' AND status=?'; params.push(status) }
    if (query) { where += " AND instr(lower(title||' '||body),lower(?))>0"; params.push(query) }
    const total = Number(this.store.db.prepare(`SELECT count(*) AS n FROM memory_note WHERE ${where}`).get(...params)?.n ?? 0)
    const items = this.store.db.prepare(`SELECT n.*,(SELECT count(*) FROM memory_evidence e WHERE e.note_id=n.id) AS evidence_count
      FROM memory_note n WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...params, limit, offset).map(row => {
      const { body, repository: _repository, ...note } = this.note(row)
      return { ...note, snippet: body.slice(0, 300), evidenceCount: Number(row.evidence_count) }
    })
    const counts = { candidate: 0, verified: 0, stale: 0, retracted: 0 }
    for (const row of this.store.db.prepare('SELECT status,count(*) AS n FROM memory_note WHERE repository=? GROUP BY status').all(this.repository)) {
      counts[MemoryStatus.parse(row.status)] = Number(row.n)
    }
    return { items, counts, total, next_offset: offset + items.length < total ? offset + items.length : null }
  }
  /** Explicit operator confirmation is fresh human evidence, bound to this exact claim and immutable review revision. */
  confirm(id: string, revision: number, reason: string): MemoryDetails {
    return this.store.atomic(() => {
      const details = this.get(id)
      if (!details || details.note.revision !== revision) throw new MemoryConflict('memory_revision_conflict')
      const before = details.note, anchor = details.evidence[0]
      if (!anchor || !['candidate', 'stale'].includes(before.status)) throw new MemoryConflict('memory_review_conflict')
      const at = new Date().toISOString()
      const note: MemoryNote = { ...before, revision: revision + 1, status: 'verified', updatedAt: at, verifiedAt: at }
      const claim = { kind: note.kind, title: note.title, body: note.body, scope: note.scope }
      this.addEvidence(id, { ticketId: anchor.ticketId, sessionId: anchor.sessionId, kind: 'human', supportsVerification: true,
        eventRef: `review:${id}:${note.revision}:${fingerprint(reason)}`, excerpt: safeText(reason, 500) }, at, fingerprint(claim))
      this.write(note, before, 'confirm', reason, `human-review:${id}:${note.revision}`)
      return this.get(id)!
    })
  }
  /** Durable review rotation: unseen notes precede changed notes, ordered by their last successful review. */
  reviewable(status: MemoryNote['status'], limit: number): MemoryNote[] {
    return this.store.db.prepare(`SELECT n.* FROM memory_note n LEFT JOIN kv r ON r.key=?||n.id
      WHERE n.repository=? AND n.status=? AND (r.value IS NULL OR json_extract(r.value,'$.revision')<>n.revision)
      ORDER BY COALESCE(json_extract(r.value,'$.sequence'),0),n.id LIMIT ?`)
      .all(KV.memory.reviewed.prefix, this.repository, status, Math.min(limit, 200)).map(row => this.note(row))
  }
  /** Compare new work against historical knowledge, including revisions already reviewed in previous rounds. */
  relatedPlan(note: NoteInput & { id: string }) {
    const words = [...new Set((note.title.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []))].slice(0, 6)
    const paths = JSON.stringify(note.scope.paths)
    const overlap = `EXISTS(SELECT 1 FROM json_each(n.scope_json,'$.paths') p JOIN json_each(?) q
      WHERE p.value=q.value OR substr(p.value,1,length(q.value)+1)=q.value||'/' OR substr(q.value,1,length(p.value)+1)=p.value||'/')`
    const terms = words.map(() => "(instr(lower(n.title||' '||n.body),?)>0)").join('+') || '0'
    return { sql: `SELECT * FROM (SELECT n.*,(n.title=?)*40+(n.body=?)*80+${overlap}*10+${terms} AS relevance
      FROM memory_note n WHERE n.repository=? AND n.id<>? AND n.status IN ('candidate','verified','stale'))
      WHERE relevance>0 ORDER BY relevance DESC,status='verified' DESC,updated_at DESC,id LIMIT 4`,
    params: [note.title, note.body, paths, ...words, this.repository, note.id] }
  }
  /** Bounded pages for rebuilding the private projection, including stale/retracted records. */
  page(after = ''): MemoryNote[] {
    return this.store.db.prepare('SELECT * FROM memory_note WHERE repository=? AND id>? ORDER BY id LIMIT 100')
      .all(this.repository, after).map(row => this.note(row))
  }
  evidenceCount(id: string): number {
    return Number(this.store.db.prepare('SELECT count(*) AS n FROM memory_evidence e JOIN memory_note n ON e.note_id=n.id WHERE n.repository=? AND n.id=?')
      .get(this.repository, id)?.n ?? 0)
  }
  duplicate(input: NoteInput): MemoryNote | undefined {
    const row = this.store.db.prepare("SELECT * FROM memory_note WHERE repository=? AND kind=? AND title=? AND body=? AND scope_json=? AND status IN ('candidate','verified') LIMIT 1")
      .get(this.repository, input.kind, input.title, input.body, JSON.stringify(input.scope))
    return row ? this.note(row) : undefined
  }
  search(input: MemoryQuery): MemoryNote[] {
    const { sql, params } = searchPlan(this.repository, this.fts, input)
    return this.store.db.prepare(sql).all(...params).map(row => this.note(row))
  }
  /** Trusted fixture/import entrypoint. Workers and analyzers have no access to this method. */
  create(input: NoteInput, evidenceInput: EvidenceInput[], source: string, status: 'candidate' | 'verified' = 'candidate', id = fingerprint([this.repository, source]).slice(0, 40), audit?: { reason: string; job: string }): MemoryNote {
    const clean = cleanNote(input), evidence = evidenceInput.map(item => EvidenceInput.parse(item))
    MemoryId.parse(id)
    if (!evidence.length) throw new Error('memory_evidence_required')
    if (evidence.some(item => item.sessionId !== `worker-${item.ticketId}`)) throw new Error('memory_source_mismatch')
    if (status === 'verified' && !evidence.some(item => item.supportsVerification && item.kind !== 'observation')) throw new Error('memory_verification_required')
    return this.store.atomic(() => {
      const hash = fingerprint([this.repository, source])
      const existing = this.store.db.prepare('SELECT id FROM memory_note WHERE source_fingerprint=? AND repository=?').get(hash, this.repository)
      if (existing) return this.get(String(existing.id))!.note
      const at = new Date().toISOString()
      const note: MemoryNote = { ...clean, id, repository: this.repository, status, revision: 1, createdAt: at, updatedAt: at,
        ...status === 'verified' ? { verifiedAt: at } : {} }
      this.store.db.prepare('INSERT INTO memory_note VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, this.repository, note.kind, note.title, note.body, status, JSON.stringify(note.scope), hash, 1, at, at, note.verifiedAt ?? null)
      for (const item of evidence) this.addEvidence(note.id, item, at, fingerprint(clean))
      this.audit(note, undefined, 'create', audit?.reason ?? 'Evidence-backed host import', audit?.job ?? source)
      this.index(note)
      return note
    })
  }
  private addEvidence(id: string, item: EvidenceInput, at: string, claim: string): void {
    this.store.db.prepare('INSERT OR IGNORE INTO memory_evidence VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(fingerprint([id, item.sessionId, item.eventRef]), id, item.ticketId, item.sessionId, item.eventRef, item.kind,
        safeText(item.excerpt, 2000), item.sourceCommit ?? null, Number(item.supportsVerification), at, item.supportsVerification ? claim : null)
  }
  /** CAS publication. Evidence IDs refer only to already stored, host-attested records in this repository. */
  update(id: string, revision: number, patch: Partial<NoteInput> & { status?: MemoryNote['status'] }, evidenceIds: string[], reason: string, job: string): MemoryNote {
    return this.store.atomic(() => {
      const details = this.get(id)
      if (!details || details.note.revision !== revision) throw new MemoryConflict('memory_revision_conflict')
      const before = details.note
      if (before.status === 'retracted') throw new Error('memory_retracted')
      const parsed = cleanNote({ kind: patch.kind ?? before.kind, title: patch.title ?? before.title,
        body: patch.body ?? before.body, scope: patch.scope ?? before.scope })
      const status = MemoryStatus.parse(patch.status ?? before.status)
      if (before.status === 'candidate' && status === 'stale' || before.status !== 'candidate' && status === 'candidate') throw new Error('memory_invalid_transition')
      const selected = evidenceIds.map(id => details.evidence.find(item => item.id === id))
      if (selected.some(item => !item)) throw new Error('memory_unknown_evidence')
      const invalidatedAt = before.status === 'stale' ? String(this.store.db.prepare("SELECT at FROM memory_revision WHERE note_id=? AND action='stale' ORDER BY revision DESC LIMIT 1").get(id)?.at ?? before.updatedAt) : ''
      if (status === 'verified' && !selected.some(item => item?.supportsVerification && item.kind !== 'observation'
        && item.claimFingerprint === fingerprint(parsed)
        && (before.status !== 'stale' || item.capturedAt > invalidatedAt))) throw new Error('memory_verification_required')
      const at = new Date().toISOString()
      const prior = { kind: before.kind, title: before.title, body: before.body, scope: before.scope }
      const verifiedAt = status === 'verified' && (before.status !== 'verified' || fingerprint(prior) !== fingerprint(parsed)) ? at : before.verifiedAt
      const note: MemoryNote = { ...before, ...parsed, status, revision: revision + 1, updatedAt: at, ...verifiedAt ? { verifiedAt } : {} }
      this.write(note, before, patch.status === 'stale' ? 'stale' : status === before.status ? 'update' : status, reason, job)
      return note
    })
  }
  /** Copies evidence only from live same-repository notes, preserving original attestations and capture times. */
  addEvidenceFrom(id: string, revision: number, evidenceIds: string[], reason: string, job: string): MemoryNote {
    return this.store.atomic(() => {
      const target = this.get(id)
      if (!target || target.note.revision !== revision) throw new MemoryConflict('memory_revision_conflict')
      let added = 0
      for (const evidenceId of evidenceIds) {
        const row = this.store.db.prepare('SELECT e.*,n.status AS source_status FROM memory_evidence e JOIN memory_note n ON e.note_id=n.id WHERE e.id=? AND n.repository=?')
          .get(evidenceId, this.repository)
        if (!row) throw new Error('memory_unknown_evidence')
        if (row.source_status === 'stale' || row.source_status === 'retracted') throw new Error('memory_invalidated_evidence')
        const evidence = this.evidence(row)
        // Copy the original claim fingerprint, never attest a new claim just because it cites this evidence.
        const result = this.store.db.prepare('INSERT OR IGNORE INTO memory_evidence VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(fingerprint([id, evidence.sessionId, evidence.eventRef]), id, evidence.ticketId, evidence.sessionId, evidence.eventRef, evidence.kind,
            evidence.excerpt, evidence.sourceCommit ?? null, Number(evidence.supportsVerification), evidence.capturedAt, evidence.claimFingerprint ?? null)
        added += Number(result.changes)
      }
      if (!added) return target.note
      return this.update(id, revision, {}, this.get(id)!.evidence.map(item => item.id), reason, job)
    })
  }
  /** Exact duplicate claims only. Both revisions and all source links move atomically; contradictions are refused. */
  merge(sourceId: string, sourceRevision: number, targetId: string, targetRevision: number, reason: string, job: string): void {
    this.store.atomic(() => {
      if (sourceId === targetId) throw new Error('memory_merge_conflict')
      const source = this.get(sourceId), target = this.get(targetId)
      if (!source || !target || source.note.revision !== sourceRevision || target.note.revision !== targetRevision) throw new MemoryConflict('memory_revision_conflict')
      const claim = (note: MemoryNote) => JSON.stringify({ kind: note.kind, title: note.title, body: note.body, scope: note.scope })
      if (source.note.status === 'retracted' || target.note.status === 'retracted' || claim(source.note) !== claim(target.note)) throw new Error('memory_merge_conflict')
      this.addEvidenceFrom(targetId, targetRevision, source.evidence.map(item => item.id), `Merged from ${sourceId}: ${reason}`, job)
      this.update(sourceId, sourceRevision, { status: 'retracted' }, source.evidence.map(item => item.id), `Merged into ${targetId}: ${reason}`, job)
    })
  }
  /** Rebuild optional FTS from authoritative rows; no read path depends on Markdown. */
  rebuildIndex(): void {
    if (!this.fts) return
    this.store.atomic(() => {
      this.store.db.exec("DROP TABLE IF EXISTS memory_note_fts; CREATE VIRTUAL TABLE memory_note_fts USING fts5(id UNINDEXED,title,body,tokenize='trigram')")
      this.store.db.prepare('INSERT INTO memory_note_fts SELECT id,title,body FROM memory_note WHERE repository=?').run(this.repository)
    })
  }
  private audit(note: MemoryNote, before: MemoryNote | undefined, action: string, reason: string, job: string): void {
    this.store.db.prepare('INSERT INTO memory_revision VALUES (?,?,?,?,?,?,?,?)').run(note.id, note.revision, action,
      before ? JSON.stringify(before) : null, JSON.stringify(note), safeText(reason, 500), fingerprint(job), note.updatedAt)
    this.store.afterCommit(this.changed)
  }
  private write(note: MemoryNote, before: MemoryNote, action: string, reason: string, job: string): void {
    this.store.db.prepare('UPDATE memory_note SET title=?,body=?,kind=?,scope_json=?,status=?,revision=?,updated_at=?,verified_at=? WHERE id=? AND repository=? AND revision=?')
      .run(note.title, note.body, note.kind, JSON.stringify(note.scope), note.status, note.revision, note.updatedAt, note.verifiedAt ?? null, note.id, this.repository, before.revision)
    this.audit(note, before, action, reason, job)
    this.index(note)
  }
  private index(note: MemoryNote): void {
    if (!this.fts) return
    this.store.db.prepare('DELETE FROM memory_note_fts WHERE id=?').run(note.id)
    this.store.db.prepare('INSERT INTO memory_note_fts VALUES (?,?,?)').run(note.id, note.title, note.body)
  }
}
