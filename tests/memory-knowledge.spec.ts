import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryConfigSchema } from '../src/policy.ts'
import { MemoryKnowledge } from '../src/app/memory/knowledge.ts'
import { publish } from '../src/app/memory/dreaming.ts'
import { MemoryProjection } from '../src/app/memory/projection.ts'
import { exampleEvidence, exampleNote, memoryFixture } from './fixtures/memory.ts'

const audit = { reason: 'Organized source-backed repository knowledge', uncertainty: 'Limited to cited revisions' }

it('injects old core knowledge ahead of recent incidental notes and audits classification with independent CAS', () => {
  const f = memoryFixture(), knowledge = new MemoryKnowledge(f.memory)
  const core = f.memory.create({ ...exampleNote, title: 'Architecture invariant' }, [exampleEvidence], 'core', 'verified', 'core')
  for (let i = 0; i < 40; i++) f.memory.create({ ...exampleNote, kind: 'incident', title: `Recent incident ${i}` }, [exampleEvidence], `recent-${i}`, 'verified')
  const offered = [f.memory.get(core.id)!]
  publish(f.memory, 'classify', [{ action: 'prioritize', id: core.id, expectedRevision: 1, expectedImportanceRevision: 0, level: 'core', ...audit }], offered)
  f.service.configure(MemoryConfigSchema.parse({ enabled: true }))
  expect(f.service.index()).toContain('Architecture invariant')
  expect(f.service.index()).not.toContain('Recent incident')
  expect(Buffer.byteLength(f.service.index())).toBeLessThanOrEqual(600)
  expect(f.memory.get(core.id)!.note.updatedAt).toBe(core.updatedAt)
  expect(knowledge.importanceHistory(core.id)).toMatchObject([{ revision: 1, level: 'core' }])
  expect(() => knowledge.prioritize(core.id, 1, 0, 'incidental', 'stale CAS', 'stale')).toThrow('conflict')
})

it('publishes synthesized topics across Tickets, links source claims, and rebuilds or withdraws derived articles', async () => {
  const f = memoryFixture(), knowledge = new MemoryKnowledge(f.memory)
  f.service.configure(MemoryConfigSchema.parse({ enabled: true }))
  const a = f.memory.create({ ...exampleNote, kind: 'fact', title: 'Transactional journal', body: 'The journal and work queue commit together.' }, [exampleEvidence], 'a', 'verified', 'a')
  const b = f.memory.create({ ...exampleNote, title: 'Migration procedure' }, [{ ...exampleEvidence, ticketId: 'ticketB', sessionId: 'worker-ticketB' }], 'b', 'verified', 'b')
  const offered = [f.memory.get(a.id)!, f.memory.get(b.id)!]
  const sources = offered.map(item => ({ noteId: item.note.id, revision: item.note.revision, evidenceIds: item.evidence.map(evidence => evidence.id) }))
  const topic = { id: 'topic-migrations', title: 'Transactional architecture and migration guide', sections: [
    { heading: 'Architecture and procedure', kind: 'guide', text: 'Keep journal publication atomic with the work queue. Check migration regressions when this boundary changes.', sources },
  ], relations: [{ from: 'b', to: 'a', kind: 'depends-on', explanation: 'The procedure checks the journal transaction boundary.' }], relatedTopics: [] }
  publish(f.memory, 'topic', [{ action: 'topic', expectedRevision: 0, topic, ...audit }], offered)
  expect(knowledge.topic(topic.id)).toMatchObject({ revision: 1, sections: [{ text: topic.sections[0]!.text }] })
  const projection = new MemoryProjection(f.service, f.directory, new AbortController().signal)
  await projection.rebuild()
  const path = join(f.directory, 'memory/topics/topic-migrations.md')
  expect(await readFile(path, 'utf8')).toContain('Architecture and procedure')
  expect(await readFile(path, 'utf8')).toContain('../wiki/a.md')
  expect(await readFile(path, 'utf8')).toContain('../wiki/b.md')
  expect(await readFile(join(f.directory, 'memory/index.md'), 'utf8')).toContain('topics/topic-migrations.md')
  expect(JSON.parse(f.service.read('topic/topic-migrations'))).toMatchObject({ topic: { id: topic.id }, boundary: expect.any(String) })
  f.memory.update(a.id, 1, { status: 'stale' }, [], 'Architecture changed', 'change')
  await projection.idle(); await projection.rebuild()
  expect(await readFile(path, 'utf8')).not.toContain(topic.sections[0]!.text)
  expect(knowledge.view(topic.id)).toMatchObject({ stale: true, sections: [] })
  expect(() => publish(f.memory, 'old-topic-cas', [{ action: 'topic', expectedRevision: 0, topic, ...audit }], offered)).toThrow()
})

it('rejects forged topic sources and atomically rolls classification back; validates article and link CAS', () => {
  const f = memoryFixture(), knowledge = new MemoryKnowledge(f.memory)
  const note = f.memory.create(exampleNote, [exampleEvidence], 'source', 'verified', 'source')
  const offered = [f.memory.get(note.id)!]
  const topic = { id: 'topic-invalid', title: 'Unsupported synthesis', sections: [{ heading: 'Guide', kind: 'guide', text: 'An unsupported claim',
    sources: [{ noteId: note.id, revision: 1, evidenceIds: ['forged-evidence'] }] }], relations: [], relatedTopics: [] }
  const priority = { action: 'prioritize', id: note.id, expectedRevision: 1, expectedImportanceRevision: 0, level: 'core', ...audit }
  expect(() => publish(f.memory, 'invalid-sources', [priority, { action: 'topic', expectedRevision: 0, topic, ...audit }], offered)).toThrow()
  expect(knowledge.importanceHistory(note.id)).toEqual([])
  expect(knowledge.topic(topic.id)).toBeUndefined()
  expect(() => publish(f.memory, 'traversal', [{ action: 'topic', expectedRevision: 0, topic: { ...topic, id: '../../outside' }, ...audit }], offered)).toThrow()
  const valid = { ...topic, sections: [{ ...topic.sections[0], sources: [{ noteId: note.id, revision: 1, evidenceIds: offered[0]!.evidence.map(item => item.id) }] }] }
  const foreign = memoryFixture('other-repository')
  foreign.memory.create(exampleNote, [exampleEvidence], 'source', 'verified', 'source')
  expect(() => publish(f.memory, 'foreign-source', [{ action: 'topic', expectedRevision: 0, topic: valid, ...audit }], [foreign.memory.get('source')!])).toThrow('revision_conflict')
  expect(() => publish(f.memory, 'missing-link', [{ action: 'topic', expectedRevision: 0, topic: { ...valid, relatedTopics: ['topic-missing'] }, ...audit }], offered)).toThrow('unknown_link')
  publish(f.memory, 'valid', [{ action: 'topic', expectedRevision: 0, topic: valid, ...audit }], offered)
  expect(() => publish(f.memory, 'cas', [{ action: 'topic', expectedRevision: 0, topic: valid, ...audit }], offered)).toThrow('topic_conflict')
  expect(knowledge.topic(topic.id)!.revision).toBe(1)
})
