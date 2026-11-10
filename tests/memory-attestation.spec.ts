import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { MemoryAttestor } from '../src/app/memory/attestation.ts'
import { MemoryConfigSchema } from '../src/policy.ts'
import { memoryFixture } from './fixtures/memory.ts'
import { KV } from '../src/kv.ts'

function fixture() {
  const f = memoryFixture(), context = new Context(), lifetime = new AbortController()
  context.reflect.provide('systemPrompt', { tools: () => () => {} })
  const tools = new ToolRuntime(context)
  execFileSync('git', ['init', '--quiet', f.directory])
  writeFileSync(join(f.directory, 'check.test.cjs'), "require('node:test')('fixture check',()=>require('node:assert/strict').equal(2+2,4))\n")
  execFileSync('git', ['-C', f.directory, 'add', 'check.test.cjs'])
  execFileSync('git', ['-C', f.directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
  f.store.saveSettings({ ...f.store.settings(), memory: MemoryConfigSchema.parse({ enabled: true, autoCapture: true }) }); f.service.configure(f.store.settings().memory)
  f.store.tickets.save({ id: 'ticketA', title: 'A', decisionId: 'd', mandate: { scope: 'fixture', strength: 'explicit', policyVersion: 'v',
    actor: { source: 'github', id: 'alice' }, basis: { via: 'listed' } }, assignments: [], origin: { triggerId: 't', triggerIds: ['t'] },
    channels: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution: { name: 'fixture', directory: f.directory, assignment: 'a' } })
  let code = 0
  tools.register({ name: 'bash', description: 'Actual controlled fixture test', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'Test passed. API_KEY=must-not-be-attested-from-text' }] },
    execute: async () => {
      execFileSync(process.execPath, ['--test', 'check.test.cjs'], { cwd: f.directory })
      return { kind: 'foreground', cwd: f.directory, exitCode: code, signal: null, timedOut: false, aborted: false }
    } })
  const attestor = new MemoryAttestor({ store: f.store, memory: f.service, lifetime: lifetime.signal, paused: () => false })
  const release = attestor.bind(context, 'worker-ticketA')
  onTestFinished(async () => { lifetime.abort(); release(); await attestor.idle() })
  const run = (id = 'test-call', command = 'node --test check.test.cjs') => tools.execute({ name: 'bash', callId: ToolCallId(id), arguments: { command }, signal: lifetime.signal })
  return { ...f, attestor, run, setCode: (next: number) => { code = next } }
}

it('automatically publishes only the bounded Host-observed execution fact and reuses it without a model or human review', async () => {
  const f = fixture()
  expect((await f.run()).isError).toBe(false); await f.attestor.idle()
  const notes = f.memory.list('verified')
  expect(notes).toHaveLength(1)
  expect(notes[0]!.body).toContain('node --test check.test.cjs')
  expect(notes[0]!.body).toContain('exit code 0')
  expect(notes[0]!.scope.version).toMatch(/^[a-f0-9]{40,64}$/)
  expect(notes[0]!.body).toContain('worktree contents')
  expect(JSON.stringify(f.memory.get(notes[0]!.id))).not.toContain('must-not-be-attested-from-text')
  expect((await f.service.search({ query: 'node --test' })).items.map(item => item.id)).toEqual([notes[0]!.id])
  await f.run(); await f.attestor.idle()
  expect(f.memory.list('verified')).toHaveLength(1)
  expect(f.service.status().usedCalls).toBe(0)
})

it('does not certify printed success, failed outcomes, arbitrary shell, or disabled capture', async () => {
  const f = fixture()
  f.setCode(1); await f.run('failed'); await f.attestor.idle()
  expect(f.memory.list('verified')).toEqual([])
  f.setCode(0); await f.run('arbitrary', 'echo all tests passed'); await f.attestor.idle()
  expect(f.memory.list('verified')).toEqual([])
  await f.run('foreign', 'node --test ../other-repository/check.test.cjs'); await f.attestor.idle()
  expect(f.memory.list('verified')).toEqual([])
  f.service.configure(MemoryConfigSchema.parse({ enabled: false }))
  await f.run('disabled'); await f.attestor.idle()
  expect(f.memory.list('verified')).toEqual([])
})

it('rolls back a failed receipt publication without failing the original tool and retries idempotently', async () => {
  const f = fixture()
  f.store.db.exec("CREATE TRIGGER reject_attestation BEFORE INSERT ON kv WHEN NEW.key LIKE 'memory-execution:%' BEGIN SELECT RAISE(ABORT,'secret=private-error'); END")
  expect((await f.run()).isError).toBe(false); await f.attestor.idle()
  expect(f.memory.list('verified')).toEqual([])
  expect(f.store.keys(KV.memory.execution)).toEqual([])
  expect(f.service.status().problem).toBe('memory_attestation_unavailable')
  f.store.db.exec('DROP TRIGGER reject_attestation')
  await f.run(); await f.attestor.idle()
  expect(f.memory.list('verified')).toHaveLength(1)
  expect(f.store.keys(KV.memory.execution)).toHaveLength(1)
})
