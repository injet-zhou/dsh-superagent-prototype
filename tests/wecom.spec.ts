import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import type { ChannelHost } from '../src/sources/kind.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SetupError } from '../src/setup.ts'
import { resetWecomTransports, wecomTransport, type WecomConnection } from '../src/infra/wecom.ts'
import { resolveWecomBot } from '../src/deployment.ts'
import { receiveWecom, runWecom, sendWecom, wecomKind, wecomScope, wecomText, wecomTime, wecomTrigger, WecomConfigSchema, WecomMessageSchema }
  from '../src/sources/wecom.ts'

const dirs: string[] = []
const directory = (): string => { const dir = mkdtempSync(join(tmpdir(), 'wecom-')); dirs.push(dir); return dir }
afterEach(() => {
  resetWecomTransports()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CONFIG = WecomConfigSchema.parse({ chats: [{ chatId: 'group1', name: 'Team' }], otherChats: 'mentions', directMessages: true })
const body = (fields: Record<string, unknown> = {}) => WecomMessageSchema.parse({ msgid: 'm1', msgtype: 'text', chattype: 'group', chatid: 'group1',
  from: { userid: 'alice' }, create_time: 1_760_000_000, text: { content: 'fix the login page' }, ...fields })

function fixture(overrides: { configured?: boolean; deployment?: ReturnType<typeof testDeployment>; problem?: boolean } = {}) {
  const stateDir = directory()
  const store = new Store(join(stateDir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    sources: { wecom: { enabled: true, config: { ...CONFIG, otherChats: 'none', secretFile: '/srv/agent/wecom.json' } } },
    policy: { sources: { wecom: { allowed: [{ id: 'alice', name: 'Alice' }] } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(wecomKind)
  const deployment = overrides.deployment ?? testDeployment({ stateDir, wecom: { secretFile: '/srv/agent/wecom.json', botId: 'bot1' } })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const received: Trigger[] = []
  const parts: SourceContextDeps = { store, outbox: { send: () => {} }, engine,
    commands, sources, deployment, ready: Promise.resolve(),
    configured: () => overrides.configured ?? true,
    ...overrides.problem ? { wecomProblem: new SetupError('wecomBotFailed').problem } : {},
    receive: trigger => { received.push(trigger); const result = engine.receive(trigger); engine.evaluateDue(); return result } }
  const ctx = sourceContextOf(parts, wecomKind)
  return { store, board, sources, deployment, commands, engine, ctx, received }
}

function connection() {
  const messages = new Set<(body: unknown) => void>()
  const states = new Set<(state: { state: 'ready' | 'paused' | 'error'; detail: string; retry?: boolean }) => void>()
  const sent: string[] = []
  const value = {
    connected: true,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    send: vi.fn(async (_conversation: string, text: string): Promise<'sent' | 'gone'> => { sent.push(text); return 'sent' }),
    onMessage: (listener: (body: unknown) => void) => { messages.add(listener); return () => { messages.delete(listener) } },
    onState: (listener: (state: { state: 'ready' | 'paused' | 'error'; detail: string; retry?: boolean }) => void) => {
      states.add(listener); return () => { states.delete(listener) }
    },
  }
  return { value: value as WecomConnection, messages, states, sent }
}

describe('wecom deployment', () => {
  const secret = (body: unknown, mode = 0o600): string => {
    const file = join(directory(), 'wecom.json')
    writeFileSync(file, JSON.stringify(body), { mode })
    chmodSync(file, mode)
    return file
  }
  it('reads the robot ID from a private secret file and keeps the secret out of the deployment', async () => {
    const secretFile = secret({ botId: 'bot1', secret: 'do-not-export' })
    await expect(resolveWecomBot({ secretFile })).resolves.toEqual({ secretFile, botId: 'bot1' })
    expect(await resolveWecomBot({})).toBeUndefined()
    await expect(resolveWecomBot({ secretFile, wsUrl: 'wss://openws.example.test/path' })).resolves.toEqual({
      secretFile, botId: 'bot1', wsUrl: 'wss://openws.example.test/path' })
  })
  it('refuses a readable-to-others secret file, malformed JSON, a missing field and a non-wss address', async () => {
    const insecure = secret({ botId: 'bot1', secret: 'x' }, 0o644)
    await expect(resolveWecomBot({ secretFile: insecure })).rejects.toMatchObject({ code: 'wecomBotFailed', place: 'wecom',
      values: { output: expect.stringContaining('chmod 600') } })
    const malformed = join(directory(), 'wecom.json')
    writeFileSync(malformed, '{"botId":', { mode: 0o600 })
    await expect(resolveWecomBot({ secretFile: malformed })).rejects.toThrow('not valid JSON')
    await expect(resolveWecomBot({ secretFile: secret({ botId: 'bot1' }) })).rejects.toThrow('botId and secret strings')
    await expect(resolveWecomBot({ secretFile: secret({ botId: 'bot1', secret: 'x' }), wsUrl: 'ws://plain.example.test' }))
      .rejects.toThrow('Expected a wss:// URL')
  })
})

describe('wecom trigger', () => {
  it('maps a group mention into a stable Trigger on the group Thread', () => {
    const trigger = wecomTrigger(body())!
    expect(trigger).toMatchObject({ id: key('wecom', 'm1'), source: 'wecom', threads: [{ source: 'wecom', id: 'group:group1' }],
      actor: { source: 'wecom', id: 'alice' }, human: true, addressed: 'mention', at: '2025-10-09T08:53:20.000Z',
      channel: { source: 'wecom', thread: 'wecom:group:group1', address: { conversation: 'group1', messageId: 'm1', direct: 'false', userId: 'alice' } },
      meta: { chattype: 'group', chatId: 'group1', userId: 'alice', messageId: 'm1', direct: false, msgtype: 'text' } })
  })
  it('maps a direct message and keeps quoted text as context', () => {
    const trigger = wecomTrigger(body({ chattype: 'single', chatid: undefined, msgid: 'm2',
      quote: { msgtype: 'text', text: { content: 'the login page' } } }))!
    expect(trigger.threads).toEqual([{ source: 'wecom', id: 'direct:alice' }])
    expect(trigger.addressed).toBe('direct')
    expect(trigger.text).toBe('> the login page\n\nfix the login page')
  })
  it('names unsupported content instead of dropping it, and cannot map a group without its ID', () => {
    expect(wecomText(body({ msgtype: 'voice', text: undefined, voice: { content: 'hello' } }))).toBe('[Voice] hello')
    expect(wecomText(body({ msgtype: 'mixed', text: undefined,
      mixed: { msg_item: [{ msgtype: 'text', text: { content: 'look' } }, { msgtype: 'image', image: { url: 'https://x' } }] } }))).toBe('look\n[Image]')
    expect(wecomTrigger(body({ chatid: undefined }))).toBeUndefined()
    expect(wecomTrigger(body({ msgtype: 'event' }))).toBeUndefined()
    expect(wecomTime(1_760_000_000_000)).toBe('2025-10-09T08:53:20.000Z')
  })
})

describe('wecom source scope and policy', () => {
  it('receives listed groups, other groups only when configured, and direct messages per the switch', () => {
    expect(wecomScope({ chatId: 'group1', direct: false }, CONFIG)).toEqual({ listened: true, observed: false, row: 'group1' })
    expect(wecomScope({ chatId: 'group2', direct: false }, CONFIG)).toEqual({ listened: true, observed: false, row: 'other' })
    expect(wecomScope({ chatId: 'group2', direct: false }, { ...CONFIG, otherChats: 'none' })).toEqual({ listened: false, reason: 'chat_not_allowed' })
    expect(wecomScope({ direct: true }, CONFIG)).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(wecomScope({ direct: true }, { ...CONFIG, directMessages: false })).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    expect(wecomKind.channel!.allowed!({ direct: 'true', conversation: 'alice' }, CONFIG)).toBe(true)
    expect(wecomKind.channel!.allowed!({ direct: 'false', conversation: 'group2' }, { ...CONFIG, otherChats: 'none' })).toBe(false)
  })
  it('gives every receiving scope an admission row and never offers an unaddressed cell', () => {
    expect(wecomKind.policy!.rows!({ ...CONFIG, directMessages: true })).toEqual([
      { id: 'group1', label: 'Team', note: { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'other', label: { zh: '其他群', en: 'Other groups' }, note: { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'direct', label: { zh: '单聊', en: 'Direct messages' }, note: { zh: '接收', en: 'Received' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
    ])
  })
  it('names the robot and the originating conversation in the Executor environment', () => {
    const deployment = testDeployment({ wecom: { secretFile: '/srv/agent/wecom.json', botId: 'bot1' } })
    const trigger = wecomTrigger(body())!
    expect(wecomKind.environment!.values({ deployment, config: CONFIG, trigger })).toEqual({
      DSH_SUPERAGENT_WECOM_BOT: 'bot1', DSH_SUPERAGENT_WECOM_CHAT: 'group1' })
    expect(wecomKind.environment!.values({ deployment, config: CONFIG })).toEqual({ DSH_SUPERAGENT_WECOM_BOT: 'bot1', DSH_SUPERAGENT_WECOM_CHAT: '' })
  })
})

describe('wecom receive', () => {
  it('stores a listed sender\'s message once and evaluates it as an explicit request', async () => {
    const h = fixture()
    expect(await receiveWecom(h.ctx, body())).toBe('stored')
    expect(await receiveWecom(h.ctx, body())).toBe('duplicate')
    expect(h.received[0]!.id).toBe(key('wecom', 'm1'))
    expect(h.engine.candidate(key('wecom', 'm1'))?.strength).toBe('explicit')
    expect(h.store.threads.get('wecom:group:group1')?.meta.label).toBe('Team')
  })
  it('filters a group the Source does not receive and leaves a direct message to its switch', async () => {
    const h = fixture()
    expect(await receiveWecom(h.ctx, body({ chatid: 'elsewhere', msgid: 'm3' }))).toBe('filtered')
    expect(h.store.triggers.disposition(key('wecom', 'm3'))?.filtered).toMatchObject({ code: 'chat_not_allowed' })
    h.store.saveSettings(SettingsSchema.parse({ ...h.store.settings(), sources: { wecom: { enabled: true, config: { ...CONFIG, otherChats: 'none', directMessages: false } } } }))
    expect(await receiveWecom(h.ctx, body({ chattype: 'single', chatid: undefined, msgid: 'm4' }))).toBe('filtered')
    expect(h.store.triggers.disposition(key('wecom', 'm4'))?.filtered).toMatchObject({ code: 'direct_messages_not_allowed' })
  })
  it('ignores a body this Source cannot map', async () => {
    const h = fixture()
    expect(await receiveWecom(h.ctx, { msgid: 'm5', msgtype: 'text' })).toBe('ignored')
    expect(await receiveWecom(h.ctx, body({ msgtype: 'event' }))).toBe('ignored')
  })
})

describe('wecom reply', () => {
  const message = (fields: Partial<OutboundMessage> = {}): OutboundMessage => ({ id: 'out1', kind: 'reply', text: 'Done; see the pull request.',
    channel: { source: 'wecom', thread: 'wecom:group:group1', address: { conversation: 'group1' } }, ...fields })
  it('sends once per outgoing message ID and records the transport receipt', async () => {
    const h = fixture()
    const transport = connection()
    const host: ChannelHost = { commands: h.commands }
    expect(await sendWecom(host, message(), transport.value)).toBe('sent')
    expect(await sendWecom(host, message(), transport.value)).toBe('sent')
    expect(transport.value.send).toHaveBeenCalledTimes(1)
    expect(transport.sent).toEqual(['Done; see the pull request.'])
  })
  it('returns gone only for a permanently unreachable conversation, and throws for a retryable failure', async () => {
    const h = fixture()
    const gone = connection()
    ;(gone.value.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce('gone')
    await expect(sendWecom({ commands: h.commands }, message({ id: 'out2' }), gone.value)).resolves.toBe('gone')
    const failed = connection()
    ;(failed.value.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('WeCom is offline'))
    await expect(sendWecom({ commands: h.commands }, message({ id: 'out3' }), failed.value)).rejects.toThrow('WeCom is offline')
  })
  it('rejects an over-long IM reply before queuing it', async () => {
    const h = fixture()
    await expect(sendWecom({ commands: h.commands }, message({ text: Array.from({ length: 101 }, (_, i) => `word${i}`).join(' ') }),
      connection().value)).rejects.toThrow(/maximum is 100/)
  })
})

describe('wecom loop', () => {
  it('connects, takes in callbacks in order, and reports a paused Source while setup waits', async () => {
    const h = fixture()
    const transport = connection()
    const controller = new AbortController()
    const running = runWecom(h.ctx, controller.signal, () => transport.value)
    await vi.waitFor(() => expect(transport.value.connect).toHaveBeenCalled())
    for (const listener of transport.messages) listener(body({ msgid: 'm6' }))
    await vi.waitFor(() => expect(h.received.some(trigger => trigger.id === key('wecom', 'm6'))).toBe(true))
    expect(h.board.all.wecom?.state).toBe('ready')
    controller.abort()
    await running
    expect(transport.value.disconnect).toHaveBeenCalled()

    const pending = fixture({ configured: false })
    const waiting = new AbortController()
    const waitingRun = runWecom(pending.ctx, waiting.signal, () => connection().value)
    await vi.waitFor(() => expect(pending.board.all.wecom?.code).toBe('setupPending'))
    waiting.abort()
    await waitingRun
  })
  it('explains a missing secret file and a failed robot check', async () => {
    const absent = fixture({ deployment: testDeployment({ wecom: undefined }) })
    const controller = new AbortController()
    const running = runWecom(absent.ctx, controller.signal, () => connection().value)
    await vi.waitFor(() => expect(absent.board.all.wecom?.code).toBe('wecomSecretUnset'))
    controller.abort(); await running

    const refused = fixture({ problem: true, deployment: testDeployment({ wecom: undefined }) })
    const stop = new AbortController()
    const refusedRun = runWecom(refused.ctx, stop.signal, () => connection().value)
    await vi.waitFor(() => expect(refused.board.all.wecom?.state).toBe('paused'))
    expect(refused.board.all.wecom?.detail).toMatch(/WeCom robot check failed/)
    stop.abort(); await refusedRun
  })
})

describe('wecom transport', () => {
  it('authenticates, receives a callback and sends a Markdown reply over a WebSocket', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => server.once('listening', resolve))
    const port = (server.address() as { port: number }).port
    const frames: { cmd?: string; headers: { req_id: string }; body?: Record<string, unknown> }[] = []
    let socket: WebSocket | undefined
    server.on('connection', connected => {
      socket = connected
      connected.on('message', raw => {
        const frame = JSON.parse(String(raw)) as { cmd?: string; headers: { req_id: string }; body?: Record<string, unknown> }
        frames.push(frame)
        if (frame.cmd === 'aibot_subscribe') connected.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }))
        else if (frame.cmd === 'aibot_send_msg') connected.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }))
      })
    })
    const secretFile = join(directory(), 'wecom.json')
    writeFileSync(secretFile, JSON.stringify({ botId: 'bot1', secret: 's3cret' }), { mode: 0o600 })
    const transport = wecomTransport({ botId: 'bot1', secretFile, wsUrl: `ws://127.0.0.1:${port}` })
    const bodies: unknown[] = []
    transport.onMessage(body => bodies.push(body))
    await transport.connect()
    expect(frames.find(frame => frame.cmd === 'aibot_subscribe')?.body).toMatchObject({ bot_id: 'bot1' })
    await vi.waitFor(() => expect(socket).toBeDefined())
    socket!.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'cb1' }, body: body({ msgid: 'm7' }) }))
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ msgid: 'm7', text: { content: 'fix the login page' } })
    await expect(transport.send('alice', 'hello')).resolves.toBe('sent')
    expect(frames.find(frame => frame.cmd === 'aibot_send_msg')?.body).toEqual({ chatid: 'alice', msgtype: 'markdown', markdown: { content: 'hello' } })
    transport.disconnect()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
