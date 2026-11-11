/** Capability-limited analysis contract. An analyzer proposes JSON; it has no publisher, tools or Engine. */
import { z } from 'zod'
import { MemoryId, MemoryImportance, MemoryTopicInput, NoteInput, type MemoryDetails, type MemoryTopic, type MemorySourceCheck } from './types.ts'
import { redact } from './security.ts'

export const MEMORY_INPUT_BYTES = 100_000
/** Shared wire representation: batching and budget preflight measure exactly what the adapter sends. */
export const serializeAnalysisInput = (input: Readonly<MemoryAnalysisInput>): string => redact(JSON.stringify(input))

export const CaptureProposal = z.object({ action: z.literal('create'), note: NoteInput,
  evidenceRefs: z.array(z.string().regex(/^seq:\d+:[a-f0-9]{64}$/)).min(1).max(20),
  reason: z.string().min(1).max(500), uncertainty: z.string().max(500),
}).strict()
const audit = { reason: z.string().min(1).max(500), uncertainty: z.string().max(500) }
const evidenceIds = z.array(MemoryId).min(1).max(20)
export const MemoryProposal = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prioritize'), id: MemoryId, expectedRevision: z.number().int().positive(), expectedImportanceRevision: z.number().int().min(0),
    level: MemoryImportance, ...audit }).strict(),
  z.object({ action: z.literal('topic'), expectedRevision: z.number().int().min(0), topic: MemoryTopicInput, ...audit }).strict(),
  z.object({ action: z.literal('create'), note: NoteInput, evidenceIds, ...audit }).strict(),
  z.object({ action: z.literal('update'), id: MemoryId, expectedRevision: z.number().int().positive(),
    note: NoteInput, status: z.enum(['candidate', 'verified', 'stale']), evidenceIds, ...audit }).strict(),
  z.object({ action: z.literal('merge'), sourceId: MemoryId, sourceRevision: z.number().int().positive(),
    targetId: MemoryId, targetRevision: z.number().int().positive(), ...audit }).strict(),
  z.object({ action: z.enum(['stale', 'retract']), id: MemoryId, expectedRevision: z.number().int().positive(), evidenceIds, ...audit }).strict(),
])
export interface MemoryAnalysisInput {
  mode: 'capture' | 'consolidate'
  events: readonly { ref: string; type: string; text: string; sessionId?: string; evidenceId?: string }[]
  notes: readonly MemoryDetails[]
  relatedNotes?: readonly MemoryDetails[]
  sourceChecks?: readonly MemorySourceCheck[]
  topics?: readonly MemoryTopic[]
}
export interface MemoryAnalyzer {
  propose(input: Readonly<MemoryAnalysisInput>, signal: AbortSignal): Promise<unknown>
}
