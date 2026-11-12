import { afterEach, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Commands, commandError } from '../src/infra/commands.ts'
import { runAsWorker } from '../src/infra/environment.ts'
import { resolveDeployment, resolveFeishuBot } from '../src/deployment.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

const secret = 'fixture-private-credential'
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it.each(['gitea', 'gitlab'])('enforces private %s credentials before reading their contents', provider => {
  const directory = mkdtempSync(join(tmpdir(), 'credential-security-'))
  directories.push(directory)
  const file = join(directory, 'account.json')
  const run = () => spawnSync('python3', [resolve(`scripts/dsh-${provider}`), '--config', file, 'config'], { encoding: 'utf8' })
  writeFileSync(file, JSON.stringify({ baseUrl: 'https://git.example.test', token: secret }), { mode: 0o600 })
  for (const mode of [0o400, 0o600]) {
    chmodSync(file, mode)
    const result = run()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ baseUrl: 'https://git.example.test' })
    expect(result.stdout + result.stderr).not.toContain(secret)
  }
  if (process.platform !== 'win32') for (const mode of [0o640, 0o644, 0o660]) {
    chmodSync(file, mode)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('chmod 600')
    expect(result.stdout + result.stderr).not.toContain(secret)
  }
  chmodSync(file, 0o600)
  writeFileSync(file, JSON.stringify({ baseUrl: 'https://git.example.test', token: secret.repeat(400) }))
  expect(run().stderr).toContain('no larger than 8 KiB')
  writeFileSync(file, `{"token":"${secret}`)
  const malformed = run()
  expect(malformed.status).toBe(1)
  expect(malformed.stdout + malformed.stderr).not.toContain(secret)
})

it.each([
  secret,
  `error: invalid credential ${secret}`,
  `Request failed (HTTP 401): ${secret}`,
  JSON.stringify({ error: { code: 99991400, message: secret } }),
  JSON.stringify({ error: { code: secret, message: secret } }),
])('discards arbitrary subprocess diagnostics: %s', stderr => {
  const error = commandError({ stderr, code: 1, message: secret }, 'bot-cli')
  expect(error.message).not.toContain(secret)
  expect(JSON.stringify(error)).not.toContain(secret)
})

it('sanitizes Feishu error responses and malformed CLI JSON', async () => {
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const run = vi.spyOn(commands, 'run')
  run.mockResolvedValueOnce(JSON.stringify({ ok: false, error: { code: 99991400, message: secret } }))
  await expect(commands.lark(['im', '+chat-list'])).rejects.toMatchObject({ message: 'Command failed (error code 99991400); rate limited', code: 99991400 })
  run.mockResolvedValueOnce(`{"ok":${secret}`)
  await expect(commands.lark(['im', '+chat-list'])).rejects.toThrow('Feishu CLI returned invalid JSON')
  run.mockResolvedValueOnce(`{"login":${secret}`)
  await expect(commands.gh(['api', 'user'])).rejects.toThrow('Repository CLI returned invalid JSON')
})

it('keeps subprocess stderr and argv out of failed setup probes', async () => {
  const runtime = (stderr: string) => ({ spawn: () => ({ done: Promise.resolve({ exitCode: 1 }),
    collected: { stderr: { readFrom: () => ({ text: stderr }) } } }) })
  for (const stderr of ['', secret]) {
    const result = runAsWorker(runtime(stderr) as never, ['bot-cli', secret], '/tmp', new AbortController().signal)
    await expect(result).rejects.toMatchObject({ message: 'bot-cli exited with code 1', exitCode: 1 })
  }
})

it('keeps account probe failures safe even when the supplied probe returns an unsanitized error', async () => {
  const probe = async (): Promise<string> => { throw { stderr: secret, message: secret, code: 1 } }
  await expect(resolveDeployment(testMachine(), { repository: 'acme/widgets', cli: '/bin/sh' }, probe))
    .rejects.toMatchObject({ code: 'agentCliSignedOut', values: { output: 'sh exited with code 1' } })
  await expect(resolveFeishuBot(testMachine(), { cli: '/bin/sh' }, probe))
    .rejects.toMatchObject({ code: 'feishuCliFailed', values: { output: 'sh exited with code 1' } })
})
