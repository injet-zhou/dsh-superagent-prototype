/** Deterministic execution receipts. No transcript text or analyzer proposal can certify a test. */
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CaptureHost } from './capture.ts'
import { liveTicket } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import { fingerprint, safeText } from './security.ts'
import type { MemoryExecutionReceipt } from './types.ts'
import type { MemoryEvidence } from './types.ts'
import type { Store } from '../store.ts'
import { MemoryKnowledge } from './knowledge.ts'

export function executionReceipt(store: Store, repository: string, evidence: MemoryEvidence): MemoryExecutionReceipt | undefined {
  const match = /^execution:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(evidence.eventRef)
  const receipt = match ? store.get(KV.memory.execution(match[1]!)) : undefined
  return receipt && receipt.repository === repository && receipt.ticketId === evidence.ticketId && receipt.sessionId === evidence.sessionId
    && fingerprint(receipt) === match![2] ? receipt : undefined
}

let reservation: symbol | undefined
const testCommand = /^(?:node --test|pnpm test|pnpm exec vitest run|npm test)(?: [A-Za-z0-9_./:@=-]+)*$/
const head = (cwd: string, signal: AbortSignal): Promise<string | undefined> => new Promise(resolve => {
  execFile('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], { timeout: 200, maxBuffer: 256, signal,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' } },
  (error, stdout) => { const value = stdout.trim(); resolve(!error && /^[a-f0-9]{40,64}$/.test(value) ? value : undefined) })
})

/** Binds to the existing authorized Worker scope; all observation errors leave the tool outcome unchanged. */
export class MemoryAttestor {
  private readonly pending = new Set<Promise<void>>()
  constructor(private readonly host: Pick<CaptureHost, 'store' | 'memory' | 'lifetime' | 'paused'>) {}
  idle(): Promise<void> { return Promise.allSettled([...this.pending]).then(() => {}) }
  bind(context: Context, sessionId: string): () => void {
    const host = this.host, ticketId = sessionId.startsWith('worker-') ? sessionId.slice(7) : ''
    type Before = { lease: symbol; command: string; cwd: string; directory: string; head: string }
    const calls = new Map<symbol, Before>()
    const release = (lease: symbol) => { if (reservation === lease) reservation = undefined }
    const eligible = () => !host.lifetime.aborted && host.memory.captureEnabled() && !host.paused()
      && !!host.store.tickets.get(ticketId) && liveTicket(host.store.tickets.get(ticketId)!)
    const around = context.on('tools/execute', async (exec, next) => {
      if (!eligible() || exec.name !== 'bash' || reservation || exec.agent && String(exec.agent.session.id) !== sessionId) return next()
      const args = exec.arguments
      if (!args || typeof args !== 'object' || !('command' in args) || typeof args.command !== 'string') return next()
      const command = args.command.trim()
      if (command.length > 300 || !testCommand.test(command) || safeText(command, 300) !== command) return next()
      if (command.split(' ').some(word => /(?:^|=)(?:\/|[A-Za-z]:)/.test(word) || word.split(/[\/=]/).includes('..'))) return next()
      const lease = Symbol('memory-attestation'); reservation = lease
      try {
        const directory = await realpath(host.store.tickets.get(ticketId)!.execution!.directory)
        const workdir = 'workdir' in args && typeof args.workdir === 'string' ? args.workdir : '.'
        const cwd = await realpath(resolve(directory, workdir)), within = relative(directory, cwd)
        if (isAbsolute(within) || within === '..' || within.startsWith('..' + sep)) { release(lease); return next() }
        const before = await head(cwd, AbortSignal.any([host.lifetime, host.memory.analysisSignal()]))
        if (before && eligible()) calls.set(exec.token, { lease, command, cwd, directory, head: before })
        else { release(lease); if (!before && eligible()) host.memory.degraded('memory_attestation_unavailable') }
      } catch { release(lease); if (eligible()) host.memory.degraded('memory_attestation_unavailable') }
      try { return await next() } catch (error) { calls.delete(exec.token); release(lease); throw error }
    })
    const observe = context.on('tools/result', (exec, result) => {
      const before = calls.get(exec.token)
      if (!before) return
      calls.delete(exec.token)
      const value = result.isError ? undefined : result.value
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'foreground' || value.exitCode !== 0
        || value.signal !== null || value.timedOut !== false || value.aborted !== false || value.cwd !== before.cwd || !eligible()) {
        release(before.lease); return
      }
      const task = (async () => {
        try {
          const after = await head(before.cwd, AbortSignal.any([host.lifetime, host.memory.analysisSignal()]))
          if (after !== before.head || !eligible()) return
          const memory = host.memory.publisher(), id = fingerprint([sessionId, exec.callId])
          if (host.store.get(KV.memory.execution(id))) return
          const at = new Date().toISOString(), cwd = relative(before.directory, before.cwd).split(sep).join('/') || '.'
          const receipt: MemoryExecutionReceipt = { id, repository: memory.repository, ticketId, sessionId, callId: String(exec.callId),
            command: before.command, cwd, head: after, at, environment: fingerprint([before.cwd, after, before.command, process.platform, process.arch]),
            resultFingerprint: fingerprint(result.content) }
          const body = `Host observed ${JSON.stringify(receipt.command)} finish with exit code 0 at ${at}. `
            + `Git HEAD before and after was ${after}; relative working directory ${JSON.stringify(cwd)}; environment observation ${receipt.environment}. `
            + 'This certifies one invocation. Uncommitted worktree contents and the general correctness of a fix were not certified.'
          host.store.atomic(() => {
            host.store.set(KV.memory.execution(id), receipt)
            const note = memory.create({ kind: 'fact', title: 'Recorded test invocation', body, scope: { paths: cwd === '.' ? [] : [cwd], version: after } },
              [{ ticketId, sessionId, eventRef: `execution:${id}:${fingerprint(receipt)}`, kind: 'test', supportsVerification: true,
                sourceCommit: after, excerpt: body }], `execution:${id}`, 'verified', undefined, { reason: 'Deterministic Host execution receipt; no model attestation', job: id })
            new MemoryKnowledge(memory).prioritize(note.id, note.revision, 0, 'incidental', 'One historical test invocation; retrieve on demand', id)
          })
        } catch { if (eligible()) host.memory.degraded('memory_attestation_unavailable') }
        finally { release(before.lease) }
      })()
      this.pending.add(task); void task.finally(() => { this.pending.delete(task) })
    })
    return () => { around(); observe(); for (const before of calls.values()) release(before.lease); calls.clear() }
  }
}
