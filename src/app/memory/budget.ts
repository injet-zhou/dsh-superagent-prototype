/** One finite daily ceiling; unused consolidation reservations cannot be spent by capture. */
import type { MemoryConfig } from '../../policy.ts'
import type { MemoryUsage } from './types.ts'

export function memoryAllowance(config: MemoryConfig, usage?: MemoryUsage) {
  const day = new Date().toISOString().slice(0, 10)
  const current = usage?.day === day ? usage : undefined
  const usedCalls = current?.calls ?? 0, captureCalls = current?.captureCalls ?? 0, consolidationCalls = current?.consolidationCalls ?? 0
  const remainingCalls = Math.max(0, config.dailyCallBudget - usedCalls)
  const reserved = config.dreaming ? Math.max(0, config.consolidationReservedCalls - consolidationCalls) : 0
  return { day, usedCalls, captureCalls, consolidationCalls, remainingCalls,
    unclassifiedCalls: Math.max(0, usedCalls - captureCalls - consolidationCalls),
    consolidationReservedCalls: config.consolidationReservedCalls, captureRemainingCalls: Math.max(0, remainingCalls - reserved) }
}
