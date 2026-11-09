/** Capability-limited analysis contract. An analyzer proposes JSON; it has no publisher, tools or Engine. */
import { z } from 'zod'
import { NoteInput, type MemoryDetails } from './types.ts'

export const CaptureProposal = z.object({ action: z.literal('create'), note: NoteInput,
  evidenceRefs: z.array(z.string().regex(/^seq:\d+:[a-f0-9]{64}$/)).min(1).max(20),
  reason: z.string().min(1).max(500), uncertainty: z.string().max(500),
}).strict()
export interface MemoryAnalysisInput {
  mode: 'capture' | 'consolidate'
  events: readonly { ref: string; type: string; text: string }[]
  notes: readonly MemoryDetails[]
}
export interface MemoryAnalyzer {
  propose(input: Readonly<MemoryAnalysisInput>, signal: AbortSignal): Promise<unknown>
}
