/** Host-controlled source replay. The model cannot choose a Session, path or command to execute. */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { CaptureHost } from './capture.ts'
import { withAbort } from './capture.ts'
import type { MemoryAnalysisInput } from './analyzer.ts'
import { serializeAnalysisInput } from './analyzer.ts'
import { fingerprint, safeText } from './security.ts'
import { sessionHistory } from '../session-history.ts'

function textOf(event: SessionEvent): string {
  if (event.type === 'tool/call') {
    let command = ''
    if (event.data.name === 'bash' || event.data.name === 'pwsh') {
      try { const args: unknown = JSON.parse(event.data.arguments); if (args && typeof args === 'object' && 'command' in args && typeof args.command === 'string') command = args.command } catch {}
    }
    return safeText(`Tool: ${event.data.name}${command ? `; command: ${command}` : ''}`, 2000)
  }
  const blocks = event.type === 'user/message' ? event.data.content
    : event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.message.content : []
  return safeText(blocks.filter(block => block.type === 'text').map(block => block.text).join('\n'), 8000)
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
      const window = raw.slice(Math.max(0, index - 3), index + 4)
      if (window.some((event, index) => index > 0 && Number(event.seq) !== Number(window[index - 1]!.seq) + 1)) { check.status = 'missing'; continue }
      check.status = 'available'
      for (const event of window) {
        const text = textOf(event)
        if (!text) continue
        const entry = { ref: `seq:${event.seq}:${fingerprint(event)}`, type: event.type, text, sessionId: evidence.sessionId, evidenceId: evidence.id }
        if (Buffer.byteLength(serializeAnalysisInput({ ...input, events: [...events, entry], sourceChecks })) > 90_000) { check.status = 'truncated'; break }
        events.push(entry)
      }
    } catch { signal.throwIfAborted(); check.status = 'unavailable' }
  }
  return { ...input, events, sourceChecks }
}
