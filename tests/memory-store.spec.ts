import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { MemoryConflict, MemoryStore } from '../src/app/memory/store.ts'
import { exampleEvidence, exampleNote, memoryFixture } from './fixtures/memory.ts'

it('migrates an actual v11 database atomically without rewriting its records, and reopens v12', () => {
  const { store, path } = memoryFixture()
  store.db.exec('DROP TABLE memory_note_fts; DROP TABLE memory_revision; DROP TABLE memory_evidence; DROP TABLE memory_capture_checkpoint; DROP TABLE memory_note')
  store.set(KV.store.schema, 11); store.set('preserved', { answer: 42 })
  const upgraded = new Store(path)
  expect(upgraded.get(KV.store.schema)).toBe(12)
  expect(upgraded.get('preserved')).toEqual({ answer: 42 })
  upgraded.close()
  const reopened = new Store(path)
  expect(reopened.db.prepare('SELECT count(*) AS count FROM memory_note').get()?.count).toBe(0)
  reopened.close()
})

it('rolls back failed v12 DDL and can retry after the conflicting table is removed', () => {
  const { store, path } = memoryFixture()
  store.db.exec('DROP TABLE memory_note_fts; DROP TABLE memory_revision; DROP TABLE memory_evidence; DROP TABLE memory_capture_checkpoint; DROP TABLE memory_note; CREATE TABLE memory_evidence (unexpected TEXT)')
  store.set(KV.store.schema, 11)
  expect(() => new Store(path)).toThrow('unchanged at schema 11')
  expect(store.get(KV.store.schema)).toBe(11)
  expect(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_note'").get()).toBeUndefined()
  store.db.exec('DROP TABLE memory_evidence')
  const recovered = new Store(path)
  expect(recovered.get(KV.store.schema)).toBe(12)
  recovered.close()
})

it('requires traceable host evidence and keeps CAS revisions through stale and retract', () => {
  const { memory } = memoryFixture()
  expect(() => memory.create(exampleNote, [], 'empty')).toThrow('evidence_required')
  expect(() => memory.create({ ...exampleNote, title: '\u0000' }, [exampleEvidence], 'invalid-after-redaction')).toThrow()
  expect(() => memory.create(exampleNote, [{ ...exampleEvidence, supportsVerification: false }], 'unproven', 'verified')).toThrow('verification_required')
  const note = memory.create(exampleNote, [exampleEvidence], 'source', 'candidate', 'same-id')
  expect(memory.create(exampleNote, [exampleEvidence], 'source').id).toBe(note.id)
  const evidence = memory.get(note.id)!.evidence.map(item => item.id)
  const verified = memory.update(note.id, 1, { status: 'verified' }, evidence, 'Confirmed test run, limited to its checkout', 'job1')
  expect(verified.revision).toBe(2)
  expect(() => memory.update(note.id, 2, { body: 'A passing test proves all migrations are safe' }, evidence, 'unsupported claim', 'job2')).toThrow('verification_required')
  expect(() => memory.update(note.id, 1, { status: 'stale' }, [], 'old', 'job2')).toThrow(MemoryConflict)
  memory.update(note.id, 2, { status: 'stale' }, [], 'The migration API changed', 'job2')
  memory.update(note.id, 3, { status: 'retracted' }, [], 'Replaced after review', 'job3')
  expect(memory.get(note.id)!.revisions).toHaveLength(4)
  expect(memory.get(note.id)!.evidence).toHaveLength(1)
  expect(memory.search({ query: 'SQLite' })).toEqual([])
  expect(() => memory.update(note.id, 4, { status: 'verified' }, evidence, 'restore', 'job4')).toThrow('retracted')
})

it('binds private memory once and rolls notes and indexes back together', () => {
  const { store, memory } = memoryFixture()
  expect(() => new MemoryStore(store, 'other:github:private/repo')).toThrow('repository_mismatch')
  expect(() => store.atomic(() => { memory.create(exampleNote, [exampleEvidence], 'rollback', 'verified'); throw new Error('rollback') })).toThrow('rollback')
  expect(memory.list()).toEqual([])
  expect(memory.search({ query: 'SQLite' })).toEqual([])
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE VIRTUAL TABLE capability USING fts5(text, tokenize=trigram)')
  db.close()
})
