/** Passive raw-history reads across the locally verified DSH 0.2.1 and 0.2.2 APIs. Never resumes an Agent. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

export async function sessionHistory(context: Context, id: SessionId, signal?: AbortSignal): Promise<readonly SessionEvent[]> {
  if (typeof context.sessionController.inspect === 'function') return (await context.sessionController.inspect(id, signal)).events
  // 0.2.2 removed inspect(). Its documented query API returns a disposable immutable raw-log cut.
  const query: unknown = context.get('sessionQuery')
  if (!query || typeof query !== 'object' || !('observeSession' in query) || typeof query.observeSession !== 'function') {
    throw new Error('session_history_unavailable')
  }
  const observation: unknown = await query.observeSession(id, { signal, projectionMode: 'none' })
  if (!observation || typeof observation !== 'object' || !(Symbol.dispose in observation)) {
    throw new Error('session_history_unavailable')
  }
  const dispose = observation[Symbol.dispose]
  if (typeof dispose !== 'function') throw new Error('session_history_unavailable')
  try {
    signal?.throwIfAborted()
    if (!('header' in observation) || !observation.header || typeof observation.header !== 'object' || !('id' in observation.header)
      || observation.header.id !== id || !('events' in observation) || !Array.isArray(observation.events)) throw new Error('session_history_mismatch')
    // Events come from the trusted DSH service; Capture separately validates seq continuity and event fingerprints.
    return observation.events as SessionEvent[]
  } finally { dispose.call(observation) }
}
