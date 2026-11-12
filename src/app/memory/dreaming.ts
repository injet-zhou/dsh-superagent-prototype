/** Deterministic Host publication of analyzer proposals and single-writer consolidation effects. */
import { z } from 'zod'
import { KV } from '../../kv.ts'
import { Later } from '../effects.ts'
import type { MemoryStore } from './store.ts'
import { MemoryConflict } from './store.ts'
import { MemoryProposal, serializeAnalysisInput, type MemoryAnalysisInput } from './analyzer.ts'
import { analyze, type CaptureHost } from './capture.ts'
import { cleanNote, fingerprint, safeText } from './security.ts'
import type { MemoryDetails, MemoryEvidence, MemorySourceCheck, MemoryReviewRequest, NoteInput } from './types.ts'
import { readMatches } from './retrieval.ts'
import { resolveEvidence } from './evidence.ts'
import { MemoryKnowledge } from './knowledge.ts'

/** All proposals publish together, against only current same-repository source evidence. */
export function publish(memory: MemoryStore, job: string, raw: unknown, offered: readonly MemoryDetails[], sourceChecks: readonly MemorySourceCheck[] = []): void {
  const proposals = z.array(MemoryProposal).max(20).parse(raw)
  memory.store.atomic(() => {
    if (memory.store.get(KV.memory.published(fingerprint(job)))) return
    const current = (id: string, revision: number) => {
      const prior = offered.find(details => details.note.id === id)
      const found = memory.get(id)
      if (!prior || prior.note.repository !== memory.repository || prior.note.revision !== revision || found?.note.revision !== revision) throw new MemoryConflict('memory_revision_conflict')
      if (found.note.status === 'retracted') throw new Error('memory_retracted')
      return found
    }
    const evidence = (ids: string[]) => ids.map(id => {
      const source = offered.find(details => details.evidence.some(item => item.id === id))
      if (!source || source.note.repository !== memory.repository) throw new Error('memory_unknown_evidence')
      const found = memory.get(source.note.id)
      const item = found?.evidence.find(item => item.id === id)
      if (!item) throw new Error('memory_unknown_evidence')
      return item
    })
    const sourceState = (id: string) => {
      const checks = sourceChecks.filter(check => check.evidenceId === id)
      return checks.length === 1 ? checks[0]!.status : 'unavailable'
    }
    const usable = (sources: readonly MemoryEvidence[]) => sources.length > 0 && sources.every(source => ['available', 'host-attested'].includes(sourceState(source.id)))
    const requestReview = (before: MemoryDetails, action: MemoryReviewRequest['action'], references: readonly MemoryEvidence[], reason: string, relatedNoteId?: string, replacement?: NoteInput) => {
      const note = before.note
      const sources = references.map(({ id, noteId, ticketId, sessionId, eventRef }) => ({ id, noteId, ticketId, sessionId, eventRef, status: sourceState(id) }))
      const claimFingerprint = fingerprint({ kind: note.kind, title: note.title, body: note.body, scope: note.scope })
      const signature = fingerprint([claimFingerprint, action, relatedNoteId, replacement, sources.map(source => [source.sessionId, source.eventRef, source.status]).sort()])
      const previous = memory.store.get(KV.memory.reviewRequest(note.id))
      if (previous?.signature === signature) return
      const record: MemoryReviewRequest = { repository: memory.repository, noteRevision: note.revision, revision: (previous?.revision ?? 0) + 1,
        action, ...relatedNoteId ? { relatedNoteId } : {}, ...replacement ? { replacement } : {}, sources, reason: safeText(reason, 500),
        at: new Date().toISOString(), job: fingerprint(job), signature, claimFingerprint }
      memory.store.set(KV.memory.reviewRequest(note.id), record)
      memory.store.set(KV.memory.reviewRequestVersion(note.id, record.revision), record)
      memory.notify()
    }
    const knowledge = new MemoryKnowledge(memory)
    const proposedTopics = new Set(proposals.flatMap(proposal => proposal.action === 'topic' ? [proposal.topic.id] : []))
    for (const proposal of proposals) {
      const reason = `${safeText(proposal.reason, 220)}; uncertainty: ${safeText(proposal.uncertainty, 220)}`
      if (proposal.action === 'topic') knowledge.publish(proposal.topic, proposal.expectedRevision, offered, reason, job, proposedTopics)
      else if (proposal.action === 'prioritize') {
        current(proposal.id, proposal.expectedRevision)
        knowledge.prioritize(proposal.id, proposal.expectedRevision, proposal.expectedImportanceRevision, proposal.level, reason, job)
      } else if (proposal.action === 'merge') {
        const source = current(proposal.sourceId, proposal.sourceRevision), target = current(proposal.targetId, proposal.targetRevision)
        const sourceRefs = offered.find(item => item.note.id === source.note.id)!.evidence, targetRefs = offered.find(item => item.note.id === target.note.id)!.evidence
        const references = evidence([...sourceRefs, ...targetRefs].map(item => item.id))
        if (source.note.status === 'verified' || !sourceRefs.length || !targetRefs.length || !usable(references)) {
          requestReview(source, 'merge', references, reason, target.note.id); continue
        }
        memory.merge(proposal.sourceId, proposal.sourceRevision, proposal.targetId, proposal.targetRevision, reason, job)
      } else if (proposal.action === 'create') {
        const sources = evidence(proposal.evidenceIds)
        const note = cleanNote(proposal.note)
        const duplicate = memory.duplicate(note)
        if (duplicate) memory.addEvidenceFrom(duplicate.id, duplicate.revision, proposal.evidenceIds, reason, job)
        else memory.create(note, sources.map(({ id: _id, noteId: _note, capturedAt: _at, claimFingerprint: _claim, ...item }) => ({ ...item, supportsVerification: false })),
          fingerprint([job, note, proposal.evidenceIds]), 'candidate', undefined, { reason, job })
      } else {
        const before = current(proposal.id, proposal.expectedRevision)
        const references = evidence(proposal.evidenceIds)
        const invalidation = proposal.action === 'stale' || proposal.action === 'retract' || proposal.action === 'update' && proposal.status === 'stale'
        // Readable history is not deterministic counterproof against an already verified claim.
        if (invalidation && (before.note.status === 'verified' || !usable(references))) {
          requestReview(before, proposal.action === 'retract' ? 'retract' : 'stale', references, reason); continue
        }
        if (proposal.action === 'update' && before.note.status === 'verified') {
          const prior = { kind: before.note.kind, title: before.note.title, body: before.note.body, scope: before.note.scope }, replacement = cleanNote(proposal.note)
          if (fingerprint(prior) !== fingerprint(replacement)) { requestReview(before, 'update', references, reason, undefined, replacement); continue }
        }
        if (proposal.evidenceIds.some(id => !before.evidence.some(item => item.id === id))) throw new Error('memory_evidence_not_attached')
        if (proposal.action === 'update') {
          const prior = { kind: before.note.kind, title: before.note.title, body: before.note.body, scope: before.note.scope }
          const replacement = cleanNote(proposal.note)
          if (JSON.stringify(prior) !== JSON.stringify(replacement) || before.note.status !== proposal.status) {
            memory.update(proposal.id, proposal.expectedRevision, { ...replacement, status: proposal.status }, proposal.evidenceIds, reason, job)
          }
        } else {
          const status = proposal.action === 'retract' ? 'retracted' : 'stale'
          if (before.note.status !== status) memory.update(proposal.id, proposal.expectedRevision, { status }, proposal.evidenceIds, reason, job)
        }
      }
    }
    memory.store.set(KV.memory.published(fingerprint(job)), true)
  })
}

/** Runs one bounded analyzer/publisher at a time per repository, with a shared process-wide model reservation. */
export class MemoryDreaming {
  private timer?: ReturnType<typeof setInterval>
  private readonly wakeup = 'repository-memory'
  constructor(private readonly host: CaptureHost) {
    // Legacy rows are snapshot wakeups, not independent work. Review progress remains authoritative.
    try {
      host.store.atomic(() => {
        const head = host.store.db.prepare("SELECT key FROM effect WHERE kind='memory-consolidate' ORDER BY seq LIMIT 1").get()
        if (!head) return
        host.store.db.prepare("DELETE FROM effect WHERE kind='memory-consolidate' AND key<>?").run(String(head.key))
        host.store.db.prepare("UPDATE effect SET key=? WHERE kind='memory-consolidate'").run(this.wakeup)
      })
    } catch { host.memory.degraded('memory_maintenance_unavailable') }
    host.effects.handle('memory-consolidate', () => this.run(), {
      ordered: true, limit: () => host.memory.dreamingEnabled() && !host.paused() && !host.lifetime.aborted ? 1 : 0,
    })
    const schedule = () => {
      if (!host.memory.dreamingEnabled() || host.lifetime.aborted) {
        clearInterval(this.timer); this.timer = undefined; return
      }
      this.timer ??= setInterval(() => this.schedule(), 15 * 60_000).unref()
      this.schedule(true)
    }
    const unsubscribe = host.memory.subscribe(schedule)
    host.lifetime.addEventListener('abort', () => { clearInterval(this.timer); unsubscribe() }, { once: true })
    schedule()
  }
  private schedule(threshold = false): void {
    if (this.host.lifetime.aborted || !this.host.memory.dreamingEnabled()) return
    try {
      if (!threshold || this.host.memory.publisher().list('candidate', 5).length >= 5) this.enqueue()
    } catch { this.host.memory.degraded('memory_maintenance_unavailable') }
  }
  /** One durable wakeup; changed work advances its generation without dropping an in-flight successor. */
  enqueue(): boolean {
    if (!this.host.memory.dreamingEnabled()) return false
    const snapshot = this.input()
    if (!snapshot.notes.length) return false
    const batchId = this.batch(snapshot)
    if (this.host.store.get(KV.memory.published(fingerprint(batchId)))) return false
    const pending = this.host.store.db.prepare("SELECT json_extract(value,'$.batchId') AS batch FROM effect WHERE kind='memory-consolidate' AND key=?").get(this.wakeup)
    if (pending?.batch === batchId) return false
    this.host.effects.enqueue('memory-consolidate', this.wakeup, { batchId }); return true
  }
  private batch(input: MemoryAnalysisInput): string {
    return fingerprint(['memory-review-v3', input.notes.map(item => [item.note.id, item.note.revision, item.note.importance?.revision])])
  }
  private input(): MemoryAnalysisInput {
    const memory = this.host.memory.publisher()
    const notes: MemoryDetails[] = []
    const candidates = memory.reviewable('candidate', 10), verified = memory.reviewable('verified', 5), stale = memory.reviewable('stale', 5)
    for (const note of [...candidates, ...verified, ...stale]) {
      const details = memory.get(note.id)!
      const entry = { note: details.note, evidence: details.evidence.slice(0, 5).map(item => ({ ...item, excerpt: safeText(item.excerpt, 500) })), revisions: [],
        ...details.pendingReview ? { reviewRequired: true } : {} }
      if (Buffer.byteLength(serializeAnalysisInput({ mode: 'consolidate', events: [], notes: [...notes, entry] })) > 40_000) break
      notes.push(entry)
    }
    return { mode: 'consolidate', events: [], notes }
  }
  private async run(): Promise<void> {
    const { host } = this
    try {
      let input = this.input()
      if (!input.notes.length) return
      const batchId = this.batch(input)
      if (host.store.get(KV.memory.published(fingerprint(batchId)))) return
      if (!host.analyzer || !host.memory.status().remainingCalls) {
        const code = !host.analyzer ? 'memory_analyzer_unavailable' : 'memory_budget_exhausted'
        host.memory.degraded(code); throw new Later(code)
      }
      const relatedNotes: MemoryDetails[] = [], memory = host.memory.publisher(), seen = new Set(input.notes.map(item => item.note.id))
      const signal = AbortSignal.any([host.lifetime, host.memory.analysisSignal(), AbortSignal.timeout(5000)])
      const plans = input.notes.map(primary => memory.relatedPlan(primary.note))
      for (const match of await readMatches(host.store.db, plans, signal)) {
        if (seen.has(match.id)) continue
        const found = memory.get(match.id)
        if (!found || found.note.revision !== match.revision) continue
        const details = { note: found.note, evidence: found.evidence.slice(0, 5).map(item => ({ ...item, excerpt: safeText(item.excerpt, 500) })), revisions: [],
          ...found.pendingReview ? { reviewRequired: true } : {} }
        if (Buffer.byteLength(serializeAnalysisInput({ ...input, relatedNotes: [...relatedNotes, details] })) > 50_000) continue
        relatedNotes.push(details); seen.add(match.id)
      }
      const offeredIds = new Set([...input.notes, ...relatedNotes].map(item => item.note.id))
      const topics = new MemoryKnowledge(memory).topics().filter(topic => topic.sections.some(section => section.sources.some(source => offeredIds.has(source.noteId))))
      const selected: typeof topics = []
      for (const topic of topics) {
        if (selected.length >= 5) break
        if (Buffer.byteLength(serializeAnalysisInput({ ...input, relatedNotes, topics: [...selected, topic] })) <= 60_000) selected.push(topic)
      }
      input = await resolveEvidence(host, { ...input, relatedNotes, topics: selected }, signal)
      const proposals = await analyze(host, input)
      if (!host.memory.dreamingEnabled() || host.paused() || host.lifetime.aborted) throw new Later('memory_consolidation_paused')
      host.store.atomic(() => {
        publish(host.memory.publisher(), batchId, proposals, [...input.notes, ...input.relatedNotes ?? []], input.sourceChecks)
        host.store.set(KV.memory.evidenceAudit, { at: new Date().toISOString(), job: fingerprint(batchId), checks: [...input.sourceChecks ?? []] })
        const sequence = (host.store.get(KV.memory.reviewSequence) ?? 0) + 1
        for (const { note } of input.notes) host.store.set(KV.memory.reviewed(note.id), { revision: note.revision, sequence, epoch: 2 })
        host.store.set(KV.memory.reviewSequence, sequence)
        host.store.set(KV.memory.lastConsolidatedAt, new Date().toISOString())
      })
      host.memory.refresh()
      this.enqueue()
    } catch (error) {
      if (error instanceof Later) throw error
      const code = error instanceof MemoryConflict ? 'memory_revision_conflict' : 'memory_consolidation_failed'
      host.memory.degraded(code); throw new Error(code)
    }
  }
}
