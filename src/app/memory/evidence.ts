/** Host-controlled source replay. The model cannot choose a Session, path or command to execute. */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { CaptureHost } from './capture.ts'
import { withAbort } from './capture.ts'
import type { MemoryAnalysisInput } from './analyzer.ts'
import { serializeAnalysisInput } from './analyzer.ts'
import { fingerprint, redact, safeText } from './security.ts'
import { sessionHistory } from '../session-history.ts'
import { executionReceipt } from './attestation.ts'

const bounded = (text: string, limit: number) => { const clean = redact(text); return { text: clean.slice(0, limit), truncated: clean.length > limit } }
function textOf(event: SessionEvent) {
  if (event.type === 'tool/call') {
    let command = ''
    if (event.data.name === 'bash' || event.data.name === 'pwsh') {
      try { const args: unknown = JSON.parse(event.data.arguments); if (args && typeof args === 'object' && 'command' in args && typeof args.command === 'string') command = args.command } catch {}
    }
    return bounded(`Tool: ${event.data.name}${command ? `; command: ${command}` : ''}`, 2000)
  }
  const blocks = event.type === 'user/message' ? event.data.content
    : event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.message.content : []
  return bounded(blocks.filter(block => block.type === 'text').map(block => block.text).join('\n'), 8000)
}

/** Only existing same-repository evidence is resolvable; missing/changed history stays explicit, never verified. */
export async function resolveEvidence(host: Pick<CaptureHost, 'store' | 'context'>, input: MemoryAnalysisInput, signal: AbortSignal): Promise<MemoryAnalysisInput> {
  const events: MemoryAnalysisInput['events'][number][] = [], sourceChecks: NonNullable<MemoryAnalysisInput['sourceChecks']>[number][] = []
  const sessions = new Map<string, Promise<readonly SessionEvent[]>>()
  const seen = new Set<string>()
  for (const details of [...input.notes, ...input.relatedNotes ?? []]) for (const evidence of details.evidence) {
    if (sourceChecks.length >= 20 || seen.has(evidence.id)) continue
    seen.add(evidence.id)
    const check: typeof sourceChecks[number] = { evidenceId: evidence.id, status: 'unavailable' }
    sourceChecks.push(check)
    if (evidence.kind === 'human' && evidence.eventRef.startsWith('review:')) { check.status = 'host-attested'; continue }
    const receipt = executionReceipt(host.store, details.note.repository, evidence)
    if (receipt) {
      const entry = { ref: evidence.eventRef, type: 'host/execution', text: safeText(JSON.stringify(receipt), 2000), sessionId: receipt.sessionId, evidenceId: evidence.id }
      if (Buffer.byteLength(serializeAnalysisInput({ ...input, events: [...events, entry], sourceChecks })) <= 90_000) {
        events.push(entry); check.status = 'host-attested'
      } else check.status = 'truncated'
      continue
    }
    const anchor = /^seq:(\d+):([a-f0-9]{64})$/.exec(evidence.eventRef)
    const ticket = host.store.tickets.get(evidence.ticketId), directory = ticket?.execution?.directory
    if (!anchor || !directory || evidence.sessionId !== `worker-${ticket.id}`) continue
    try {
      let history = sessions.get(evidence.sessionId)
      if (!history) {
        history = sessionHistory(host.context, evidence.sessionId as SessionId, signal, directory)
        sessions.set(evidence.sessionId, history)
      }
      const raw = await withAbort(history, signal)
      const index = raw.findIndex(event => Number(event.seq) === Number(anchor[1]))
      if (index < 0) { check.status = 'missing'; continue }
      if (fingerprint(raw[index]) !== anchor[2]) { check.status = 'changed'; continue }
      let start = index, end = index
      while (start > 0 && raw[start]!.type !== 'turn/start') start--
      if (raw[start]?.type !== 'turn/start') { start = Math.max(0, index - 3); end = Math.min(raw.length - 1, index + 3) }
      else while (end + 1 < raw.length && raw[end]!.type !== 'turn/end' && raw[end + 1]!.type !== 'turn/start') end++
      const window = raw.slice(start, end + 1)
      if (window.some((event, index) => index > 0 && Number(event.seq) !== Number(window[index - 1]!.seq) + 1)) { check.status = 'missing'; continue }
      check.status = window.length > 100 ? 'truncated' : 'available'
      const selected = window.length <= 100 ? window : [...new Set([...window.slice(0, 40), raw[index]!, ...window.slice(-59)])].sort((a, b) => Number(a.seq) - Number(b.seq))
      for (const event of selected) {
        const { text, truncated } = textOf(event)
        if (!text) continue
        if (truncated) check.status = 'truncated'
        const entry = { ref: `seq:${event.seq}:${fingerprint(event)}`, type: event.type, text, sessionId: evidence.sessionId, evidenceId: evidence.id }
        if (Buffer.byteLength(serializeAnalysisInput({ ...input, events: [...events, entry], sourceChecks })) > 90_000) { check.status = 'truncated'; break }
        events.push(entry)
      }
    } catch { signal.throwIfAborted(); check.status = 'unavailable' }
  }
  return { ...input, events, sourceChecks }
}
