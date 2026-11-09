/** Repository-bound memory persistence on the Runtime's existing SQLite connection. */
import type { SQLInputValue } from 'node:sqlite'
import type { Store } from '../store.ts'
import { KV } from '../../kv.ts'
import { EvidenceInput, MemoryId, MemoryQuery, MemoryStatus, NoteInput, type MemoryDetails, type MemoryNote } from './types.ts'
import { fingerprint, safeText } from './security.ts'

/** A rejected optimistic update; callers must reread and form a new proposal. */
export class MemoryConflict extends Error {}
/** The sole host publisher of notes, evidence and immutable revisions for one bound repository. */
export class MemoryStore {
  readonly fts: boolean
  constructor(readonly store: Store, readonly repository: string) {
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
    const evidence = this.store.db.prepare('SELECT * FROM memory_evidence WHERE note_id=? ORDER BY id LIMIT 100').all(id).map(row => ({
      id: String(row.id), noteId: id, ticketId: String(row.ticket_id), sessionId: String(row.session_id), eventRef: String(row.event_ref),
      kind: EvidenceInput.shape.kind.parse(row.evidence_kind), excerpt: String(row.excerpt_redacted),
      supportsVerification: row.supports_verification === 1, capturedAt: String(row.captured_at),
      ...row.claim_fingerprint ? { claimFingerprint: String(row.claim_fingerprint) } : {},
      ...row.source_commit ? { sourceCommit: String(row.source_commit) } : {},
    }))
    const revisions = this.store.db.prepare('SELECT revision,action,before_json,after_json,reason,source_job_id,at FROM memory_revision WHERE note_id=? ORDER BY revision DESC LIMIT 100').all(id)
    return { note, evidence, revisions }
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
  search(input: MemoryQuery): MemoryNote[] {
    const { query, path, limit } = MemoryQuery.parse(input)
    const params: SQLInputValue[] = [this.repository]
    const scoped = path ? ` AND (json_array_length(n.scope_json,'$.paths')=0 OR EXISTS (
      SELECT 1 FROM json_each(n.scope_json,'$.paths') p WHERE p.value=? OR substr(?,1,length(p.value)+1)=p.value||'/'))` : ''
    if (path) params.push(path, path)
    // Bound the eligible working set even in fallback mode. LIKE wildcards and FTS syntax are never trusted.
    const eligible = `SELECT n.* FROM memory_note n WHERE n.repository=? AND n.status='verified'${scoped} ORDER BY n.updated_at DESC,n.id LIMIT 200`
    if (this.fts && [...query].length >= 3) {
      const match = `"${query.replaceAll('"', '""')}"`
      return this.store.db.prepare(`WITH eligible AS (${eligible}) SELECT n.* FROM memory_note_fts f JOIN eligible n ON f.id=n.id
        WHERE memory_note_fts MATCH ? ORDER BY rank LIMIT ?`).all(...params, match, limit).map(row => this.note(row))
    }
    return this.store.db.prepare(`WITH eligible AS (${eligible}) SELECT * FROM eligible WHERE instr(lower(title||' '||body),lower(?))>0 LIMIT ?`)
      .all(...params, query, limit).map(row => this.note(row))
  }
  /** Trusted fixture/import entrypoint. Workers and analyzers have no access to this method. */
  create(input: NoteInput, evidenceInput: EvidenceInput[], source: string, status: 'candidate' | 'verified' = 'candidate', id = fingerprint([this.repository, source]).slice(0, 40), audit?: { reason: string; job: string }): MemoryNote {
    const parsed = NoteInput.parse(input), evidence = evidenceInput.map(item => EvidenceInput.parse(item))
    if (parsed.scope.paths.some(path => safeText(path, 300) !== path)) throw new Error('memory_sensitive_path')
    MemoryId.parse(id)
    if (!evidence.length) throw new Error('memory_evidence_required')
    if (evidence.some(item => item.sessionId !== `worker-${item.ticketId}`)) throw new Error('memory_source_mismatch')
    if (status === 'verified' && !evidence.some(item => item.supportsVerification && item.kind !== 'observation')) throw new Error('memory_verification_required')
    const clean = { ...parsed, title: safeText(parsed.title, 160), body: safeText(parsed.body, 8000),
      scope: { ...parsed.scope, ...parsed.scope.version ? { version: safeText(parsed.scope.version, 150) } : {} } }
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
      const parsed = NoteInput.parse({ kind: patch.kind ?? before.kind, title: patch.title ?? before.title,
        body: patch.body ?? before.body, scope: patch.scope ?? before.scope })
      const status = MemoryStatus.parse(patch.status ?? before.status)
      if (before.status === 'candidate' && status === 'stale') throw new Error('memory_invalid_transition')
      if (parsed.scope.paths.some(path => safeText(path, 300) !== path)) throw new Error('memory_sensitive_path')
      const selected = evidenceIds.map(id => details.evidence.find(item => item.id === id))
      if (selected.some(item => !item)) throw new Error('memory_unknown_evidence')
      if (status === 'verified' && !selected.some(item => item?.supportsVerification && item.kind !== 'observation'
        && item.claimFingerprint === fingerprint(parsed))) throw new Error('memory_verification_required')
      const at = new Date().toISOString()
      const note: MemoryNote = { ...before, ...parsed, title: safeText(parsed.title, 160), body: safeText(parsed.body, 8000), status,
        scope: { ...parsed.scope, ...parsed.scope.version ? { version: safeText(parsed.scope.version, 150) } : {} },
        revision: revision + 1, updatedAt: at, ...status === 'verified' ? { verifiedAt: at } : {} }
      this.store.db.prepare('UPDATE memory_note SET title=?,body=?,kind=?,scope_json=?,status=?,revision=?,updated_at=?,verified_at=? WHERE id=? AND repository=? AND revision=?')
        .run(note.title, note.body, note.kind, JSON.stringify(note.scope), status, note.revision, at, note.verifiedAt ?? null, id, this.repository, revision)
      this.audit(note, before, status === before.status ? 'update' : status, reason, job)
      this.index(note)
      return note
    })
  }
  private audit(note: MemoryNote, before: MemoryNote | undefined, action: string, reason: string, job: string): void {
    this.store.db.prepare('INSERT INTO memory_revision VALUES (?,?,?,?,?,?,?,?)').run(note.id, note.revision, action,
      before ? JSON.stringify(before) : null, JSON.stringify(note), safeText(reason, 500), fingerprint(job), note.updatedAt)
  }
  private index(note: MemoryNote): void {
    if (!this.fts) return
    this.store.db.prepare('DELETE FROM memory_note_fts WHERE id=?').run(note.id)
    this.store.db.prepare('INSERT INTO memory_note_fts VALUES (?,?,?)').run(note.id, note.title, note.body)
  }
}
