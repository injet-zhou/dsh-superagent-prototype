import { afterEach, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { worktreeCommand } from '../src/workspace.ts'
import { checkWorkspace, wecomDiscovery } from '../src/app/onboarding.ts'
import { Store } from '../src/app/store.ts'
import { wecomTrigger } from '../src/sources/wecom.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
const dirs: string[] = []
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'onboarding-')); dirs.push(dir); return dir }
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })
const env = () => gitEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, env: env() })
const subprocess = {
  spawn: ({ argv, cwd }: { argv: string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: env() })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', data => { output.stdout += data })
    child.stderr.on('data', data => { output.stderr += data })
    return { done: new Promise(resolve => child.on('close', exitCode => resolve({ exitCode }))), collected: {
      stdout: { readFrom: () => ({ text: output.stdout }) }, stderr: { readFrom: () => ({ text: output.stderr }) },
    } }
  },
} as unknown as SubprocessRuntime

it('discovers only this repository’s last 50 WeCom messages, including filtered ones', () => {
  const store = new Store(join(directory(), 'db.sqlite'))
  const other = new Store(join(directory(), 'db.sqlite'))
  try {
    for (let i = 0; i < 55; i++) {
      const trigger = wecomTrigger({ msgid: String(i), msgtype: 'text', chattype: 'group', chatid: 'g1',
        from: { userid: `person-${i}` }, text: { content: `Message ${i}` }, create_time: 1_700_000_000 + i })!
      store.triggers.save(trigger)
      store.triggers.saveDisposition(trigger.id, { filtered: { code: 'chat_not_allowed' }, fanout: [], at: trigger.at })
    }
    const messages = wecomDiscovery(store)
    expect(messages).toHaveLength(50)
    expect(messages[0]).toMatchObject({ userId: 'person-54', chatId: 'g1', filtered: true, preview: 'Message 54' })
    expect(wecomDiscovery(other)).toEqual([])
    expect(store.settings().policy.sources.wecom).toBeUndefined()
  } finally { store.close(); other.close() }
})

it('creates a real task worktree using shell literals for paths containing quotes and substitutions', async () => {
  const root = directory(), repo = join(root, "repo ' $(touch injected)"), remote = join(root, 'remote.git'), work = join(root, 'work')
  mkdirSync(repo)
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'hello.txt'), 'hello')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-m', 'Initial')
  await git(root, 'clone', '--bare', repo, remote)
  await exec('sh', ['-c', worktreeCommand(repo, remote)], { cwd: root, env: { ...env(),
    DSH_SUPERAGENT_TICKET: 't1', DSH_SUPERAGENT_NAME: 'test-task', DSH_SUPERAGENT_DIR: work } })
  expect(readFileSync(join(work, 'hello.txt'), 'utf8')).toBe('hello')
  expect(existsSync(join(root, 'injected'))).toBe(false)
  expect((await git(work, 'branch', '--show-current')).stdout.trim()).toBe('agent/test-task')
})

it('checks the local root, remote and credentials without changing repository files', async () => {
  const root = directory(), repo = join(root, 'repo')
  mkdirSync(repo)
  await git(repo, 'init')
  await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  const deployment = testDeployment({ repository: 'acme/widgets' })
  const check = (path = repo) => checkWorkspace(path, join(root, 'tasks'), deployment, subprocess, new AbortController().signal, env())
  const before = readFileSync(join(repo, '.git/config'), 'utf8')
  expect(await check()).toEqual({ ok: true, code: 'ready' })
  expect(readFileSync(join(repo, '.git/config'), 'utf8')).toBe(before)
  expect(existsSync(join(root, 'tasks'))).toBe(false)
  expect(await check('relative')).toMatchObject({ code: 'path', ok: false })
  expect(await check(root)).toMatchObject({ code: 'repository', ok: false })
  await git(repo, 'remote', 'set-url', 'origin', 'https://github.com/other/widgets.git')
  expect(await check()).toMatchObject({ code: 'remote', ok: false })
  await git(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git')
  expect(await check()).toMatchObject({ ok: true })
  await git(repo, 'config', 'credential.helper', '/untrusted-helper')
  expect(await check()).toMatchObject({ code: 'credentials', ok: false })
})
