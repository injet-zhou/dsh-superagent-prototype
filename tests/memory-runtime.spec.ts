import { expect, it, onTestFinished } from 'vitest'
import { startRuntime, feishu } from './fixtures/host.ts'
import { exampleEvidence, exampleNote } from './fixtures/memory.ts'
import { policyVersion } from '../src/policy.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Runtime } from '../src/app/runtime.ts'
import { Store } from '../src/app/store.ts'
import { testMachine } from './fixtures/deployment.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { vi } from 'vitest'
import { KV } from '../src/kv.ts'

it('leaves default Workers and Router unchanged, then enables repository memory through a revisioned setting', async () => {
  const h = await startRuntime(store => {
    store.db.exec('DROP TABLE memory_note_fts; DROP TABLE memory_revision; DROP TABLE memory_evidence; DROP TABLE memory_capture_checkpoint; DROP TABLE memory_note')
    store.set(KV.store.schema, 11)
  })
  onTestFinished(() => h.stop())
  const a = await h.acceptedTicket(feishu('1', '修复迁移'))
  expect(h.runtime.store.get(KV.store.schema)).toBe(12)
  expect(h.tools.get(a.sessionId)?.has('orchestrator_memory_search')).toBe(false)
  const oldVersion = policyVersion(h.runtime.store.settings())
  const saved = await h.api('PUT', 'settings/memory', { revision: 0, value: { enabled: true } })
  expect(saved.status).toBe(200)
  expect(h.runtime.store.settingsHistory()[0]!.policyVersion).toBe(oldVersion)
  expect((await h.api('PUT', 'settings/memory', { revision: 0, value: { enabled: false } })).status).toBe(409)
  h.runtime.memory.publisher().create(exampleNote, [{ ...exampleEvidence, ticketId: a.ticket.id, sessionId: a.sessionId }], 'ticket-a', 'verified', 'shared')
  h.runtime.memory.refresh()
  const b = await h.acceptedTicket(feishu('2', '修复其他迁移'))
  expect((await h.runTool(b.sessionId, 'orchestrator_memory_search', { query: 'SQLite' })).items).toHaveLength(1)
  const search = vi.spyOn(h.runtime.memory.publisher(), 'search').mockImplementationOnce(() => { throw new Error('secret=private-error') })
  expect(await h.runTool(b.sessionId, 'orchestrator_memory_search', { query: 'SQLite' })).toMatchObject({ items: [], degraded: 'memory_retrieval_unavailable' })
  expect(h.runtime.store.tickets.get(b.ticket.id)?.ended).toBeUndefined()
  expect(h.runtime.health.runtime?.state).toBe('ready')
  search.mockRestore()
  expect(h.tools.get(h.runtime.masterId)?.has('orchestrator_memory_search')).toBe(false)
  await expect(h.runTool(a.sessionId, 'orchestrator_memory_search', { query: 'SQLite', repositoryId: 'other' })).rejects.toThrow()
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'memory/shared' })).rejects.toThrow('authorized current worker')
  for (const resource of ['memory/../shared', 'memory/other/shared', 'memory//etc/passwd']) {
    await expect(h.runTool(b.sessionId, 'orchestrator_read', { resource })).rejects.toThrow('Invalid memory resource')
  }
  h.runtime.engine.stopTicket(b.ticket.id)
  await expect(h.runTool(b.sessionId, 'orchestrator_memory_search', { query: 'SQLite' })).rejects.toThrow('authorized current worker')
  expect((await h.api('PUT', 'settings/memory', { revision: 1, value: { enabled: false } })).status).toBe(200)
  expect(h.runtime.memory.publisher().get('shared')).toBeDefined()
  expect(h.runtime.memory.index()).toBe('')
})

it('keeps default, backend and frontend memory, scoped settings and health isolated even with the same note ID', async () => {
  const entries: { id: string; name: string; runtime: Runtime }[] = []
  const h = await startRuntime(undefined, { scopedEnvironment: true }, { repositories: () => entries })
  entries.push({ id: 'default', name: 'Default', runtime: h.runtime })
  onTestFinished(async () => { for (const { runtime } of entries.slice(1).reverse()) await runtime.stop(); await h.stop() })
  for (const id of ['backend', 'frontend']) {
    const stateDir = join(h.directory, 'repositories', id), cli = join(h.directory, `${id}-gh`)
    mkdirSync(stateDir, { recursive: true }); writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
    h.answers[`${cli} api user`] = `{"login":"${id}-bot","id":8}`
    h.answers[`${cli} api repos/acme/${id} --jq {name: .full_name, push: .permissions.push}`] = `{"name":"acme/${id}","push":true}`
    h.answers['git config -z --show-origin --get-all credential.https://github.com.helper'] = `file:${workerGitConfig(stateDir)}\0${credentialHelper(cli)}\0`
    const seed = new Store(join(stateDir, 'orchestrator.sqlite'))
    seed.saveSettings({ ...h.runtime.store.settings(), sources: { github: { enabled: true, config: { repository: `acme/${id}`, cli } } } })
    seed.db.exec('DROP TABLE memory_note_fts; DROP TABLE memory_revision; DROP TABLE memory_evidence; DROP TABLE memory_capture_checkpoint; DROP TABLE memory_note')
    seed.set(KV.store.schema, 11); seed.close()
    const runtime = new Runtime(h.ctx.isolate('orchestrator'), testMachine({ stateDir, repositoryId: id, scopedEnvironment: true }), vi.fn(), { http: false })
    entries.push({ id, name: id, runtime }); await runtime.ready
    expect(runtime.configured()).toBe(true)
    expect(runtime.store.get(KV.store.schema)).toBe(12)
  }
  for (const { id, runtime } of entries) {
    const path = id === 'default' ? 'settings/memory' : `/orchestrator/repositories/${id}/api/settings/memory`
    expect((await h.api('PUT', path, { revision: 0, value: { enabled: true } })).status).toBe(200)
    runtime.memory.publisher().create({ ...exampleNote, body: `Private experience for ${id}` }, [exampleEvidence], 'same-event', 'verified', 'same-id')
    runtime.memory.refresh()
    expect(runtime.memory.read('same-id')).toContain(`Private experience for ${id}`)
    for (const other of entries.filter(entry => entry.id !== id)) expect(runtime.memory.read('same-id')).not.toContain(`Private experience for ${other.id}`)
  }
  entries[1]!.runtime.memory.degraded('partial_capture')
  expect(h.runtime.health.memory?.state).toBe('ready')
  expect(entries[2]!.runtime.health.memory?.state).toBe('ready')
  const selected = await h.api('GET', '/orchestrator/repositories/backend/api/state')
  expect(selected.body.health).toMatchObject({ memory: { detail: 'partial_capture' } })
  expect((await h.api('GET', '/orchestrator/repositories/missing/api/state')).status).toBe(404)
})
