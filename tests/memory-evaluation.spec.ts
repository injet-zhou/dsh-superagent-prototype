/** Fixed offline A/B retrieval evaluation. It makes no claim about live agent completion, tokens or cost. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { MemoryConfigSchema } from '../src/policy.ts'
import { exampleEvidence, memoryFixture } from './fixtures/memory.ts'
import { fingerprint } from '../src/app/memory/security.ts'

const dataset = z.object({ baselineCommit: z.string(), model: z.literal('offline-fixture-no-llm'), temperature: z.literal(0), modelCallBudget: z.literal(0),
  cases: z.array(z.object({ id: z.string(), category: z.string(), query: z.string(), body: z.string(), scope: z.string(), path: z.string(),
    status: z.enum(['verified', 'candidate', 'stale', 'retracted']), expected: z.boolean() })).length(20),
}).parse(JSON.parse(readFileSync(new URL('./fixtures/memory-evaluation.json', import.meta.url), 'utf8')))

it('compares disabled/enabled retrieval over 20 fixed positive, distractor, outdated, changed and security cases', async () => {
  const { service, memory, store } = memoryFixture()
  for (const item of dataset.cases) {
    const note = memory.create({ kind: 'fact', title: item.id, body: item.body, scope: { paths: [item.scope] } },
      [{ ...exampleEvidence, eventRef: `seq:1:${fingerprint(item.id)}` }], item.id, item.status === 'candidate' ? 'candidate' : 'verified', item.id)
    if (item.status === 'stale' || item.status === 'retracted') memory.update(note.id, 1, { status: item.status }, [], 'Fixed evaluation invalidation', 'fixture')
  }
  for (const item of dataset.cases) expect((await service.search({ query: item.query, path: item.path })).items).toEqual([])
  service.configure(MemoryConfigSchema.parse({ enabled: true }))
  let truePositive = 0, falsePositive = 0, falseNegative = 0
  for (const item of dataset.cases) {
    const hits = (await service.search({ query: item.query, path: item.path })).items
    expect(hits.map(hit => hit.id), item.id).toEqual(item.expected ? [item.id] : [])
    if (item.expected && hits.length) truePositive++
    if (!item.expected && hits.length) falsePositive++
    if (item.expected && !hits.length) falseNegative++
  }
  expect({ precision: truePositive / (truePositive + falsePositive), recall: truePositive / (truePositive + falseNegative) }).toEqual({ precision: 1, recall: 1 })
  expect(store.get('memory-usage')).toBeUndefined()
  expect(JSON.stringify(memory.list('candidate'))).not.toContain('private-value')
})
