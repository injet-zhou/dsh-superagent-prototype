/** Durable incremental capture at confirmed turn boundaries; every failure is confined to memory. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { KV } from '../../kv.ts'
import { Later, type Effects } from '../effects.ts'
import type { Store } from '../store.ts'
import type { MemoryService } from './service.ts'
import { CaptureProposal, type MemoryAnalyzer, type MemoryAnalysisInput } from './analyzer.ts'
import { fingerprint, safeText } from './security.ts'

export interface CaptureBatch { ticketId: string; assignmentId: string; sessionId: string; endSeq: number; endHash: string }
const Cursor = z.object({ seq: z.number().int(), hash: z.string(), partial: z.boolean() }).strict()
type Cursor = z.infer<typeof Cursor>
export interface CaptureHost {
  store: Store; effects: Effects; memory: MemoryService; context: Context; lifetime: AbortSignal
  analyzer?: MemoryAnalyzer
  paused(): boolean
}
// Across every local Runtime, only one memory model call may run. It never consumes a WorkerSlot.
let analyzing = false

/** Stops waiting even when an integration fails to honor cancellation; late results have no publication path. */
export function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(new Error('memory_operation_aborted')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  return Promise.race([pending, stopped]).finally(() => { signal.removeEventListener('abort', abort) })
}

/** Shares bounded, cancellable analyzer calls and reserves a durable per-repository daily call budget. */
export async function analyze(host: CaptureHost, input: MemoryAnalysisInput): Promise<unknown> {
  if (!host.analyzer) { host.memory.degraded('memory_analyzer_unavailable'); throw new Later('memory_analyzer_unavailable') }
  if (analyzing) throw new Later('memory_analyzer_busy')
  const signal = AbortSignal.any([host.lifetime, AbortSignal.timeout(15_000)])
  const config = host.store.settings().memory, day = new Date().toISOString().slice(0, 10)
  host.store.atomic(() => {
    const previous = host.store.get(KV.memory.usage)
    const calls = previous?.day === day ? previous.calls : 0
    if (!config.dailyCallBudget || calls >= config.dailyCallBudget) {
      host.memory.degraded('memory_budget_exhausted'); throw new Later('memory_budget_exhausted')
    }
    host.store.set(KV.memory.usage, { day, calls: calls + 1 })
  })
  analyzing = true
  const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return host.analyzer!.propose(input, signal) })
  // A non-cooperative adapter retains its process-wide reservation until it actually ends.
  void pending.then(() => { analyzing = false }, () => { analyzing = false })
  const result = await withAbort(pending, signal)
  signal.throwIfAborted()
  if (JSON.stringify(result).length > 32_000) throw new Error('memory_proposals_too_large')
  return result
}

/** Captures only observed event ranges, committing notes/evidence and their cursor in one transaction. */
export class MemoryCapture {
  constructor(private readonly host: CaptureHost) {
    host.memory.analyzerAvailable(!!host.analyzer)
    host.effects.handle('memory-capture', (batch, job) => this.run(batch, job), {
      ordered: true, limit: () => host.memory.captureEnabled() && !host.paused() && !host.lifetime.aborted ? 1 : 0,
    })
  }
  enqueue(ticketId: string, assignmentId: string, event: SessionEvent<'turn/end'>): void {
    if (!this.host.memory.captureEnabled()) return
    try {
      const batch = { ticketId, assignmentId, sessionId: `worker-${ticketId}`, endSeq: Number(event.seq), endHash: fingerprint(event) }
      this.host.store.atomic(() => { this.host.effects.enqueue('memory-capture', fingerprint(batch), batch) })
    } catch { this.host.memory.degraded('memory_capture_enqueue_failed') }
  }
  private cursor(batch: CaptureBatch): Cursor {
    const row = this.host.store.db.prepare('SELECT cursor_json FROM memory_capture_checkpoint WHERE ticket_id=? AND session_id=?')
      .get(batch.ticketId, batch.sessionId)
    return row ? Cursor.parse(JSON.parse(String(row.cursor_json))) : { seq: -1, hash: '', partial: false }
  }
  private checkpoint(batch: CaptureBatch, cursor: Cursor): void {
    this.host.store.db.prepare(`INSERT INTO memory_capture_checkpoint VALUES (?,?,?,?,?) ON CONFLICT(ticket_id,session_id) DO UPDATE
      SET snapshot_fingerprint=excluded.snapshot_fingerprint,cursor_json=excluded.cursor_json,updated_at=excluded.updated_at`)
      .run(batch.ticketId, batch.sessionId, batch.endHash, JSON.stringify(cursor), new Date().toISOString())
  }
  private async run(batch: CaptureBatch, job: string): Promise<void> {
    const { host } = this
    try {
      if (batch.sessionId !== `worker-${batch.ticketId}` || !host.store.tickets.get(batch.ticketId)?.assignments.some(item => item.id === batch.assignmentId)) {
        throw new Error('memory_capture_scope_mismatch')
      }
      const previous = this.cursor(batch)
      if (previous.seq >= batch.endSeq) return
      // whenIdle() itself does not flush DSH persistence. The durable effect retries a failed flush/inspection.
      const signal = AbortSignal.any([host.lifetime, AbortSignal.timeout(15_000)])
      await withAbort(host.context.sessionPersistence.flush(), signal)
      const { events } = await withAbort(host.context.sessionController.inspect(batch.sessionId as SessionId, signal), signal)
      signal.throwIfAborted()
      const bySeq = new Map(events.map(event => [Number(event.seq), event]))
      const end = bySeq.get(batch.endSeq), anchor = bySeq.get(previous.seq)
      const retained = events.length === bySeq.size && end && end.type === 'turn/end' && fingerprint(end) === batch.endHash
        && (previous.seq < 0 || anchor && fingerprint(anchor) === previous.hash)
      const range = events.filter(event => Number(event.seq) > previous.seq && Number(event.seq) <= batch.endSeq)
      if (!retained || range.length !== batch.endSeq - previous.seq || range.some((event, index) => Number(event.seq) !== previous.seq + 1 + index)) {
        host.store.atomic(() => { this.checkpoint(batch, { ...previous, partial: true }) })
        host.memory.degraded('partial_capture')
        throw new Error('partial_capture')
      }
      const chunk = range.slice(0, 200)
      let last = chunk[0]!
      let bytes = 0
      const input: MemoryAnalysisInput = { mode: 'capture', events: [], notes: [] }
      const textEvents: { ref: string; type: string; text: string }[] = []
      for (const event of chunk) {
        // Never submit reasoning, credentials, tool-call arguments, system prompts or raw tool result objects.
        const blocks = event.type === 'user/message' ? event.data.content
          : event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.message.content : []
        const text = safeText(blocks.filter(block => block.type === 'text').map(block => block.text).join('\n'), 2000)
        if (bytes + Buffer.byteLength(text) > 100_000) break
        bytes += Buffer.byteLength(text)
        last = event
        if (text.trim()) textEvents.push({ ref: `seq:${event.seq}:${fingerprint(event)}`, type: event.type, text })
      }
      const raw = textEvents.length ? await analyze(host, Object.freeze({ ...input,
        events: Object.freeze(textEvents.map(event => Object.freeze({ ...event }))) })) : []
      const proposals = z.array(CaptureProposal).max(20).parse(raw)
      if (!host.memory.captureEnabled() || host.paused() || host.lifetime.aborted) throw new Later('memory_capture_paused')
      host.store.atomic(() => {
        if (JSON.stringify(this.cursor(batch)) !== JSON.stringify(previous)) throw new Error('memory_capture_cursor_conflict')
        for (const proposal of proposals) {
          const sources = proposal.evidenceRefs.map(ref => textEvents.find(event => event.ref === ref))
          if (sources.some(event => !event)) throw new Error('memory_capture_unknown_evidence')
          const evidence = sources.map(event => ({ ticketId: batch.ticketId, sessionId: batch.sessionId, eventRef: event!.ref,
            kind: 'observation' as const, excerpt: event!.text.slice(0, 500), supportsVerification: false }))
          // Source event refs distinguish identical text at different positions, and remain stable on retries.
          host.memory.publisher().create(proposal.note, evidence, fingerprint([batch.sessionId, proposal.evidenceRefs, proposal.note]), 'candidate', undefined,
            { job, reason: `${safeText(proposal.reason, 220)}; uncertainty: ${safeText(proposal.uncertainty, 220)}` })
        }
        this.checkpoint(batch, { seq: Number(last.seq), hash: fingerprint(last), partial: false })
        if (Number(last.seq) < batch.endSeq) host.effects.enqueue('memory-capture', `${job}:${last.seq}`, batch)
      })
      host.memory.refresh()
    } catch (error) {
      if (error instanceof Later) throw error
      const code = error instanceof Error && error.message === 'partial_capture' ? 'partial_capture' : 'memory_capture_failed'
      host.memory.degraded(code)
      // Effects persists this fixed code, never provider output or transcript secrets.
      throw new Error(code)
    }
  }
}
