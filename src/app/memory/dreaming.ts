/** Deterministic Host publication of analyzer proposals and single-writer consolidation effects. */
import { z } from 'zod'
import { KV } from '../../kv.ts'
import { Later } from '../effects.ts'
import type { MemoryStore } from './store.ts'
import { MemoryConflict } from './store.ts'
import { MemoryProposal, MEMORY_INPUT_BYTES, serializeAnalysisInput, type MemoryAnalysisInput } from './analyzer.ts'
import { analyze, type CaptureHost } from './capture.ts'
import { cleanNote, fingerprint, safeText } from './security.ts'
import type { MemoryDetails } from './types.ts'

/** All proposals publish together, against only current same-repository source evidence. */
export function publish(memory: MemoryStore, job: string, raw: unknown, offered: readonly MemoryDetails[]): void {
  const proposals = z.array(MemoryProposal).max(20).parse(raw)
  memory.store.atomic(() => {
    if (memory.store.get(KV.memory.published(fingerprint(job)))) return
    const current = (id: string, revision: number) => {
      const prior = offered.find(details => details.note.id === id)
      const found = memory.get(id)
      if (!prior || prior.note.repository !== memory.repository || prior.note.revision !== revision || found?.note.revision !== revision) throw new MemoryConflict('memory_revision_conflict')
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
    for (const proposal of proposals) {
      const reason = `${safeText(proposal.reason, 220)}; uncertainty: ${safeText(proposal.uncertainty, 220)}`
      if (proposal.action === 'merge') {
        current(proposal.sourceId, proposal.sourceRevision); current(proposal.targetId, proposal.targetRevision)
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
        evidence(proposal.evidenceIds)
        if (proposal.evidenceIds.some(id => !before.evidence.some(item => item.id === id))) throw new Error('memory_evidence_not_attached')
        if (proposal.action === 'update') {
          const prior = { kind: before.note.kind, title: before.note.title, body: before.note.body, scope: before.note.scope }
          if (JSON.stringify(prior) !== JSON.stringify(proposal.note) || before.note.status !== proposal.status) {
            memory.update(proposal.id, proposal.expectedRevision, { ...proposal.note, status: proposal.status }, proposal.evidenceIds, reason, job)
          }
        } else memory.update(proposal.id, proposal.expectedRevision, { status: proposal.action === 'retract' ? 'retracted' : 'stale' }, proposal.evidenceIds, reason, job)
      }
    }
    memory.store.set(KV.memory.published(fingerprint(job)), true)
  })
}

/** Runs one bounded analyzer/publisher at a time per repository, with a shared process-wide model reservation. */
export class MemoryDreaming {
  constructor(private readonly host: CaptureHost) {
    host.effects.handle('memory-consolidate', ({ batchId }) => this.run(batchId), {
      ordered: true, limit: () => host.memory.dreamingEnabled() && !host.paused() && !host.lifetime.aborted ? 1 : 0,
    })
    host.memory.subscribe(() => {
      if (host.memory.dreamingEnabled() && host.memory.publisher().list('candidate', 5).length >= 5) this.enqueue()
    })
  }
  /** Manual Host entrypoint; the stable snapshot key also coalesces repeated scheduling. */
  enqueue(): boolean {
    if (!this.host.memory.dreamingEnabled()) return false
    const snapshot = this.input()
    if (!snapshot.notes.length) return false
    // A new key version permits an initial review of pages published before durable rotation existed.
    const batchId = fingerprint(['memory-review-v1', snapshot.notes.map(item => [item.note.id, item.note.revision])])
    if (this.host.store.get(KV.memory.published(fingerprint(batchId)))) return false
    this.host.effects.enqueue('memory-consolidate', batchId, { batchId }); return true
  }
  private input(): MemoryAnalysisInput {
    const memory = this.host.memory.publisher()
    const notes: MemoryDetails[] = []
    const candidates = memory.reviewable('candidate', 10), verified = memory.reviewable('verified', 5), stale = memory.reviewable('stale', 5)
    for (const note of [...candidates, ...verified, ...stale]) {
      const details = memory.get(note.id)!
      const entry = { note: details.note, evidence: details.evidence.slice(0, 5).map(item => ({ ...item, excerpt: safeText(item.excerpt, 500) })), revisions: [] }
      if (Buffer.byteLength(serializeAnalysisInput({ mode: 'consolidate', events: [], notes: [...notes, entry] })) > MEMORY_INPUT_BYTES) break
      notes.push(entry)
    }
    return { mode: 'consolidate', events: [], notes }
  }
  private async run(batchId: string): Promise<void> {
    const { host } = this
    if (host.store.get(KV.memory.published(fingerprint(batchId)))) return
    try {
      const input = this.input()
      if (!input.notes.length) return
      const proposals = await analyze(host, input)
      if (!host.memory.dreamingEnabled() || host.paused() || host.lifetime.aborted) throw new Later('memory_consolidation_paused')
      host.store.atomic(() => {
        publish(host.memory.publisher(), batchId, proposals, input.notes)
        const sequence = (host.store.get(KV.memory.reviewSequence) ?? 0) + 1
        for (const { note } of input.notes) host.store.set(KV.memory.reviewed(note.id), { revision: note.revision, sequence })
        host.store.set(KV.memory.reviewSequence, sequence)
      })
      host.memory.refresh()
    } catch (error) {
      if (error instanceof Later) throw error
      const code = error instanceof MemoryConflict ? 'memory_revision_conflict' : 'memory_consolidation_failed'
      host.memory.degraded(code); throw new Error(code)
    }
  }
}
