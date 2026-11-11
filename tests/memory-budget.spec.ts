import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { analyze } from '../src/app/memory/capture.ts'
import { Effects } from '../src/app/effects.ts'
import { KV } from '../src/kv.ts'
import { MemoryConfigSchema } from '../src/policy.ts'
import { memoryFixture } from './fixtures/memory.ts'

function budgetFixture(settings: { dailyCallBudget: number; consolidationReservedCalls?: number; dreaming?: boolean }) {
  const f = memoryFixture()
  const config = MemoryConfigSchema.parse({ enabled: true, autoCapture: true, dreaming: true, ...settings })
  f.store.saveSettings({ ...f.store.settings(), memory: config }); f.service.configure(config)
  const propose = vi.fn(async () => [])
  const host = { store: f.store, memory: f.service, context: new Context(), effects: new Effects(f.store, f.board),
    lifetime: new AbortController().signal, paused: () => false, analyzer: { propose } }
  return { ...f, config, host, propose }
}
const capture = { mode: 'capture' as const, events: [], notes: [] }, consolidate = { ...capture, mode: 'consolidate' as const }

it('reserves consolidation calls under capture load while enforcing one shared daily ceiling', async () => {
  const f = budgetFixture({ dailyCallBudget: 5, consolidationReservedCalls: 2 }), { host, propose } = f
  for (let i = 0; i < 3; i++) await analyze(host, capture)
  await expect(analyze(host, capture)).rejects.toThrow('memory_budget_reserved')
  expect(propose).toHaveBeenCalledTimes(3)
  expect(f.service.status()).toMatchObject({ usedCalls: 3, remainingCalls: 2, captureRemainingCalls: 0,
    captureCalls: 3, consolidationCalls: 0 })
  await analyze(host, consolidate); await analyze(host, consolidate)
  await expect(analyze(host, consolidate)).rejects.toThrow('memory_budget_exhausted')
  expect(propose).toHaveBeenCalledTimes(5)
  expect(f.service.status()).toMatchObject({ usedCalls: 5, remainingCalls: 0, captureCalls: 3, consolidationCalls: 2 })
  expect(f.store.get(KV.memory.usage)?.calls).toBe(5)
})

it('preserves legacy usage, counts failed consolidation calls and resets category accounting on the next UTC day', async () => {
  const f = budgetFixture({ dailyCallBudget: 10, consolidationReservedCalls: 3 })
  f.store.set(KV.memory.usage, { day: new Date().toISOString().slice(0, 10), calls: 7 })
  expect(f.service.status()).toMatchObject({ usedCalls: 7, unclassifiedCalls: 7, remainingCalls: 3, captureRemainingCalls: 0 })
  await expect(analyze(f.host, capture)).rejects.toThrow('memory_budget_reserved')
  f.propose.mockRejectedValueOnce(new Error('fixture model unavailable'))
  await expect(analyze(f.host, consolidate)).rejects.toThrow('fixture model unavailable')
  expect(f.service.status()).toMatchObject({ usedCalls: 8, unclassifiedCalls: 7, consolidationCalls: 1, captureRemainingCalls: 0 })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 24 * 60 * 60_000 })
  try {
    expect(f.service.status()).toMatchObject({ usedCalls: 0, consolidationCalls: 0, captureRemainingCalls: 7 })
    await analyze(f.host, capture)
    expect(f.service.status()).toMatchObject({ usedCalls: 1, captureCalls: 1, unclassifiedCalls: 0 })
  } finally { vi.useRealTimers() }
})

it('releases the reservation when dreaming is off and makes zero budget disable both modes without clearing usage', async () => {
  const f = budgetFixture({ dailyCallBudget: 2, consolidationReservedCalls: 2, dreaming: false })
  await analyze(f.host, capture); await analyze(f.host, capture)
  expect(f.propose).toHaveBeenCalledTimes(2)
  f.store.saveSettings({ ...f.store.settings(), memory: { ...f.config, dailyCallBudget: 0, dreaming: true } })
  f.service.configure(f.store.settings().memory)
  await expect(analyze(f.host, consolidate)).rejects.toThrow('memory_budget_exhausted')
  expect(f.propose).toHaveBeenCalledTimes(2)
  expect(f.service.status()).toMatchObject({ usedCalls: 2, dailyCallBudget: 0, consolidationReservedCalls: 2 })
  expect(MemoryConfigSchema.parse({})).toMatchObject({ enabled: false, dailyCallBudget: 0, consolidationReservedCalls: 0 })
})

it('keeps reservations and usage isolated between repositories', async () => {
  const a = budgetFixture({ dailyCallBudget: 3, consolidationReservedCalls: 2 })
  const b = budgetFixture({ dailyCallBudget: 3 })
  await analyze(a.host, capture)
  await expect(analyze(a.host, capture)).rejects.toThrow('memory_budget_reserved')
  for (let i = 0; i < 3; i++) await analyze(b.host, capture)
  await analyze(a.host, consolidate); await analyze(a.host, consolidate)
  expect(a.service.status()).toMatchObject({ usedCalls: 3, captureCalls: 1, consolidationCalls: 2 })
  expect(b.service.status()).toMatchObject({ usedCalls: 3, captureCalls: 3, consolidationCalls: 0 })
})

it('lets consolidation exceed its reservation when the shared total still has capacity', async () => {
  const f = budgetFixture({ dailyCallBudget: 5, consolidationReservedCalls: 2 })
  for (let i = 0; i < 3; i++) await analyze(f.host, consolidate)
  expect(f.service.status()).toMatchObject({ consolidationCalls: 3, captureRemainingCalls: 2 })
  await analyze(f.host, capture); await analyze(f.host, capture)
  expect(f.service.status()).toMatchObject({ usedCalls: 5, captureCalls: 2, consolidationCalls: 3 })
})
