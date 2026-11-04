import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Engine, type Candidate, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { SetupError } from '../src/setup.ts'
import { overview } from '../src/app/views/overview.ts'
import { executorLoad } from '../src/app/views/tickets.ts'
import { resolveDiscordBot } from '../src/deployment.ts'
import { Commands, CliError } from '../src/infra/commands.ts'
import { DiscordApi, DiscordMessage } from '../src/infra/discord.ts'
import { DiscordConfigSchema, discordKind, discordTrigger, discordTriggerId, pollDiscord, readDiscord, runDiscord, sendDiscord, pruneDiscordReceipts } from '../src/sources/discord.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { readResource, type ResourceHost } from '../src/app/resources.ts'
import { TextCache } from '../src/app/cache.ts'
import { Outbox } from '../src/app/outbox.ts'
import { Prompts, defaultPrompts } from '../src/app/prompts.ts'
import { setupChanged } from '../src/app/setup.ts'
import { testDeployment } from './fixtures/deployment.ts'

const BOT = '800000000000000001', USER = '800000000000000002', CHANNEL = '800000000000000003', GUILD = '800000000000000004'
let directory: string, tokenFile: string
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
const signal = () => new AbortController().signal
const response = (data: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(data), { status, headers })
const message = (id: string, extra: Partial<DiscordMessage> = {}): DiscordMessage => ({ id, channel_id: CHANNEL,
  author: { id: USER, username: 'Alice' }, content: `<@${BOT}> fix the bug`, timestamp: new Date().toISOString(), type: 0,
  mentions: [{ id: BOT, username: 'Agent', bot: true }], attachments: [], ...extra })
const deployment = () => testDeployment({ stateDir: directory, discord: { tokenFile, botId: BOT, name: 'Agent' } })
const commands = () => new Commands(deployment, {}, signal())
const channel = (id = CHANNEL) => ({ id, type: 0, guild_id: GUILD, name: 'work', last_message_id: null })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'discord-source-'))
  tokenFile = join(directory, 'bot.json')
  writeFileSync(tokenFile, JSON.stringify({ token: 'test_bot_secret' }), { mode: 0o600 })
  fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }) })

function host() {
  const store = new Store(join(directory, 'state.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { discord: { enabled: true, config: { tokenFile, channels: [{ channelId: CHANNEL, listen: 'mentions' }] } } },
    policy: { sources: { discord: { allowed: [{ id: USER, name: 'Alice' }] } } } }))
  const board = new HealthBoard(), sources = new SourceRegistry(() => store.settings(), board)
  sources.register(discordKind)
  const candidates: Candidate[] = []
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: candidate => { candidates.push(candidate) } }, executor, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const ctx = sourceContextOf({ store, engine, outbox: { send: vi.fn() }, sources, commands: commands(), deployment: deployment(),
    ready: Promise.resolve(), configured: () => true, receive }, discordKind)
  return { store, sources, engine, executor, candidates, receive, ctx, board }
}
const outgoing = (id = 'reply-1'): OutboundMessage => ({ id, kind: 'reply', text: 'Fixed; please review the PR.',
  channel: { source: 'discord', thread: `discord:${CHANNEL}`, address: { channelId: CHANNEL, messageId: '900000000000000001' } } })

describe('Discord bot transport', () => {
  it('resolves only bot identities, authenticates over fixed HTTPS and keeps token values out of settings', async () => {
    fetcher.mockResolvedValue(response({ id: BOT, username: 'Agent', bot: true }))
    expect(await resolveDiscordBot({ tokenFile }, signal())).toEqual({ tokenFile, botId: BOT, name: 'Agent' })
    expect(fetcher).toHaveBeenCalledWith('https://discord.com/api/v10/users/@me', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bot test_bot_secret' }) }))
    fetcher.mockResolvedValue(response({ id: USER, username: 'Alice' }))
    await expect(resolveDiscordBot({ tokenFile }, signal())).rejects.toMatchObject({ code: 'discordBotFailed', place: 'discord' })
    expect(await resolveDiscordBot({}, signal())).toBeUndefined()
    expect(DiscordConfigSchema.parse({ tokenFile })).not.toHaveProperty('token')
    expect(() => DiscordConfigSchema.parse({ token: 'secret' })).toThrow()
  })
  it('rejects malformed token files and unsafe paths without sending credentials or leaking response bodies', async () => {
    await expect(new DiscordApi(tokenFile).request(z.unknown(), 'https://evil.test', signal())).rejects.toThrow('Unsupported Discord API path')
    expect(fetcher).not.toHaveBeenCalled()
    writeFileSync(tokenFile, '{not-json test_bot_secret')
    await expect(resolveDiscordBot({ tokenFile }, signal())).rejects.toThrow('Cannot read Discord bot token file')
    expect(fetcher).not.toHaveBeenCalled()
    writeFileSync(tokenFile, '{"token":"test_bot_secret"}')
    fetcher.mockResolvedValue(response({ message: 'secret content test_bot_secret' }, 401))
    await expect(resolveDiscordBot({ tokenFile }, signal())).rejects.toThrow('HTTP 401')
    await expect(resolveDiscordBot({ tokenFile }, signal())).rejects.not.toThrow('test_bot_secret')
    expect(() => DiscordConfigSchema.parse({ tokenFile: 'relative.json' })).toThrow()
  })
  it('refuses POSIX token files readable by other users before sending any credentials', async () => {
    if (process.platform === 'win32') return
    chmodSync(tokenFile, 0o644)
    await expect(resolveDiscordBot({ tokenFile }, signal())).rejects.toMatchObject({ code: 'discordBotFailed', values: { output: expect.stringContaining('chmod 600') } })
    expect(fetcher).not.toHaveBeenCalled()
    chmodSync(tokenFile, 0o400)
    fetcher.mockResolvedValue(response({ id: BOT, username: 'Agent', bot: true }))
    expect(await resolveDiscordBot({ tokenFile }, signal())).toMatchObject({ botId: BOT })
  })
  it('honors fractional 429 retry_after and shares rate limits across withSignal clones', async () => {
    const api = commands()
    fetcher.mockResolvedValueOnce(response({ retry_after: 0.04 }, 429)).mockResolvedValueOnce(response({ ok: true }))
    const start = Date.now()
    expect(await api.discord(z.unknown(), `channels/${CHANNEL}`)).toEqual({ ok: true })
    expect(Date.now() - start).toBeGreaterThanOrEqual(30)
    fetcher.mockResolvedValueOnce(response({ ok: true }, 200, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.04' }))
      .mockResolvedValueOnce(response({ ok: true }))
    await api.discord(z.unknown(), `channels/${CHANNEL}`)
    const reset = Date.now()
    await api.withSignal(signal()).discord(z.unknown(), `channels/${CHANNEL}`)
    expect(Date.now() - reset).toBeGreaterThanOrEqual(30)
  })
  it('aborts a queued rate-limit wait without issuing another request', async () => {
    const controller = new AbortController(), api = new DiscordApi(tokenFile)
    fetcher.mockResolvedValue(response({}, 200, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '100' }))
    await api.request(z.unknown(), `channels/${CHANNEL}`, signal())
    const pending = api.request(z.unknown(), `channels/${CHANNEL}`, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('Discord Source', () => {
  it('normalizes mentions, replies, attachments and large snowflakes without treating bots/webhooks as humans', () => {
    const input = message('9007199254740993001', { message_reference: { message_id: '9007199254740993000', channel_id: CHANNEL }, attachments: [{ filename: 'details.txt', url: 'https://cdn.discordapp.com/a' }] })
    const trigger = discordTrigger(input, BOT, GUILD)!
    expect(trigger).toMatchObject({ addressed: 'mention', human: true, actor: { source: 'discord', id: USER },
      threads: [{ source: 'discord', id: CHANNEL }], meta: { parentId: '9007199254740993000' } })
    expect(trigger.url).toBe(`https://discord.com/channels/${GUILD}/${CHANNEL}/${input.id}`)
    expect(trigger.text).toContain('[Attachment: details.txt]')
    expect(discordKind.repliesTo!(trigger)).toBe(discordTriggerId('9007199254740993000'))
    expect(discordTrigger(message('2', { author: { id: BOT, username: 'Agent', bot: true } }), BOT)).toBeUndefined()
    expect(discordTrigger(message('2', { webhook_id: '123' }), BOT)?.human).toBe(false)
    expect(discordTrigger(message('2', { author: { id: USER, username: 'Other bot', bot: true } }), BOT)?.human).toBe(false)
    expect(discordTrigger(message('2', { type: 7 }), BOT)).toBeUndefined()
    expect(discordTrigger(message('2', { message_reference: { message_id: '1', channel_id: '999' } }), BOT)?.meta).not.toHaveProperty('parentId')
  })
  it('scopes channels and reply targets independently from user authorization, and requires setup restart for token path changes', () => {
    const config = DiscordConfigSchema.parse({ channels: [{ channelId: CHANNEL, listen: 'mentions' }] })
    expect(discordKind.scope!({ meta: { channelId: CHANNEL } }, config)).toEqual({ listened: true, observed: false, row: CHANNEL })
    expect(discordKind.scope!({ meta: { channelId: '999' } }, config).listened).toBe(false)
    expect(discordKind.channel!.allowed!({ channelId: CHANNEL }, config)).toBe(true)
    expect(discordKind.channel!.allowed!({ channelId: '999' }, config)).toBe(false)
    expect(() => DiscordConfigSchema.parse({ channels: [{ channelId: CHANNEL, listen: 'all' }, { channelId: CHANNEL, listen: 'all' }] })).toThrow('Duplicate')
    expect(setupChanged(SettingsSchema.parse({}), SettingsSchema.parse({ sources: { discord: { enabled: true, config: { tokenFile } } } }))).toBe(true)
    expect(discordKind.find!(`https://discord.com/channels/${GUILD}/${CHANNEL}/123`)).toEqual({ threads: [`discord:${CHANNEL}`], terms: [discordTriggerId('123')] })
  })
  it('polls next-page windows in snowflake order and resumes after restart without replaying old history', async () => {
    const h = host()
    try {
      const beginning = ((BigInt(Date.now() + 60000 - 1420070400000) << 22n))
      const first = message(String(beginning)), second = message(String(beginning + 1n))
      fetcher.mockResolvedValueOnce(response(channel())).mockResolvedValueOnce(response([second, first]))
      await pollDiscord(h.ctx, signal())
      expect(h.receive.mock.calls.map(([trigger]) => trigger.id)).toEqual([discordTriggerId(first.id), discordTriggerId(second.id)])
      expect(String(fetcher.mock.calls[1]![0])).toMatch(/limit=100&after=[0-9]+$/)
      expect(h.store.get(`discord-cursor:${BOT}:${CHANNEL}`)).toBe(second.id)
      // A new Commands instance models a restart; only the durable cursor determines the next window.
      fetcher.mockResolvedValueOnce(response(channel())).mockResolvedValueOnce(response([]))
      await pollDiscord({ ...h.ctx, commands: commands() }, signal())
      expect(String(fetcher.mock.calls[3]![0])).toContain(`after=${second.id}`)
      expect(h.receive).toHaveBeenCalledTimes(2)
    } finally { h.store.close() }
  })
  it('catches up more than one API page without skipping messages and retains the last acknowledged cursor on receive failure', async () => {
    const h = host()
    try {
      const base = BigInt('9007199254740993000')
      h.store.set(`discord-cursor:${BOT}:${CHANNEL}`, String(base))
      const all = Array.from({ length: 205 }, (_, i) => message(String(base + BigInt(i + 1))))
      fetcher.mockImplementation(async url => {
        const parsed = new URL(String(url))
        if (!parsed.pathname.endsWith('/messages')) return response(channel())
        const after = BigInt(parsed.searchParams.get('after')!)
        return response(all.filter(item => BigInt(item.id) > after).slice(0, 100).reverse())
      })
      await pollDiscord(h.ctx, signal()); await pollDiscord(h.ctx, signal()); await pollDiscord(h.ctx, signal())
      expect(h.receive).toHaveBeenCalledTimes(205)
      expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(all.map(item => item.id))
      expect(h.store.get(`discord-cursor:${BOT}:${CHANNEL}`)).toBe(all.at(-1)!.id)
      const failed = message(String(base + 206n))
      fetcher.mockResolvedValueOnce(response(channel())).mockResolvedValueOnce(response([failed]))
      await pollDiscord({ ...h.ctx, receive: async () => { throw new Error('database unavailable') } }, signal())
      expect(h.store.get(`discord-cursor:${BOT}:${CHANNEL}`)).toBe(all.at(-1)!.id)
      expect(h.board.all.discord).toMatchObject({ state: 'error', detail: expect.stringContaining('database unavailable') })
    } finally { h.store.close() }
  })
  it('keeps unmentioned chatter out of active and ended Tickets in mentions mode, while all mode receives it', async () => {
    const h = host()
    try {
      const base = 9007199254740993000n
      const trigger = discordTrigger(message(String(base)), BOT, GUILD)!
      h.receive(trigger)
      h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'asked' })
      const ticket = h.store.tickets.open()[0]!
      h.engine.assignmentStarted(ticket.id, ticket.assignments.at(-1)!.id)
      h.store.set(`discord-cursor:${BOT}:${CHANNEL}`, String(base))
      const chatter = (id: bigint, unlisted = false) => message(String(id), { content: 'Nice weather', mentions: [],
        author: { id: unlisted ? '999' : USER, username: 'A person' } })
      h.receive.mockClear()
      fetcher.mockResolvedValueOnce(response(channel())).mockResolvedValueOnce(response([chatter(base + 2n, true), chatter(base + 1n)]))
      await pollDiscord(h.ctx, signal())
      expect(h.receive).not.toHaveBeenCalled()
      expect(h.store.triggers.get(discordTriggerId(String(base + 1n)))).toBeUndefined()
      expect(h.store.tickets.get(ticket.id)?.inputs).toEqual(ticket.inputs)
      h.engine.report(ticket.id, { state: 'dropped', summary: 'Done' })
      expect(h.store.tickets.get(ticket.id)?.ended).toBeDefined()
      fetcher.mockResolvedValueOnce(response(channel())).mockResolvedValueOnce(response([chatter(base + 3n)]))
      await pollDiscord(h.ctx, signal())
      expect(h.receive).not.toHaveBeenCalled()
      expect(h.store.tickets.get(ticket.id)?.ended).toBeDefined()
      expect(h.store.get(`discord-cursor:${BOT}:${CHANNEL}`)).toBe(String(base + 3n))
      const settings = h.store.settings()
      h.store.saveSettings({ ...settings, sources: { ...settings.sources, discord: { enabled: true,
        config: DiscordConfigSchema.parse({ tokenFile, channels: [{ channelId: CHANNEL, listen: 'all' }] }) } } })
      fetcher.mockResolvedValueOnce(response(channel())).mockResolvedValueOnce(response([chatter(base + 4n)]))
      await pollDiscord(h.ctx, signal())
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(h.store.triggers.get(discordTriggerId(String(base + 4n)))).toBeDefined()
      expect(h.store.tickets.get(ticket.id)?.ended).toBeUndefined()
    } finally { h.store.close() }
  })
  it('pauses an unset or failed bot without producing a second Overview source-error', async () => {
    for (const problem of [undefined, new SetupError('discordBotFailed').problem]) {
      const h = host(), controller = new AbortController()
      try {
        const report = h.ctx.report
        await runDiscord({ ...h.ctx, deployment: testDeployment({ discord: undefined }), problem,
          report: (name, value) => { report(name, value); controller.abort() } }, controller.signal)
        expect(h.board.all.discord?.state).toBe('paused')
        if (!problem) expect(h.board.all.discord?.code).toBe('discordTokenUnset')
        const view = overview({ store: h.store, sources: h.sources, links: () => ({ url: '', label: { zh: '', en: '' } }) },
          h.board.all, 'test-policy', executorLoad(h.store, 0), problem)
        expect(view.problems.filter(item => item.kind === 'source-error')).toEqual([])
        expect(view.problems.filter(item => item.kind === 'setup')).toHaveLength(problem ? 1 : 0)
        expect(fetcher).not.toHaveBeenCalled()
      } finally { controller.abort(); h.store.close() }
    }
  })
  it('skips an identifiable malformed message and advances beyond it without losing valid neighbors', async () => {
    const h = host(), base = 9007199254740993000n
    try {
      h.store.set(`discord-cursor:${BOT}:${CHANNEL}`, String(base))
      fetcher.mockResolvedValueOnce(response(channel())).mockResolvedValueOnce(response([
        { id: String(base + 2n), channel_id: CHANNEL, author: null }, message(String(base + 1n)),
      ]))
      await pollDiscord(h.ctx, signal())
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(h.store.get(`discord-cursor:${BOT}:${CHANNEL}`)).toBe(String(base + 2n))
      expect(h.board.all.discord?.detail).toContain('skipped malformed message')
      fetcher.mockResolvedValueOnce(response(channel())).mockResolvedValueOnce(response([message(String(base + 3n))]))
      await pollDiscord(h.ctx, signal())
      expect(h.receive).toHaveBeenCalledTimes(2)
      expect(h.board.all.discord?.state).toBe('ready')
    } finally { h.store.close() }
  })
  it('treats a spent round budget as progress and starts the next round at the next channel', async () => {
    const h = host(), second = '800000000000000099', budget = new AbortController()
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 45000 ? budget.signal : originalTimeout(ms))
    try {
      const settings = h.store.settings()
      h.store.saveSettings({ ...settings, sources: { ...settings.sources, discord: { enabled: true,
        config: DiscordConfigSchema.parse({ tokenFile, channels: [{ channelId: CHANNEL, listen: 'mentions' }, { channelId: second, listen: 'mentions' }] }) } } })
      fetcher.mockImplementationOnce(async () => { budget.abort(new DOMException('Timeout', 'TimeoutError')); throw new Error('aborted') })
      await pollDiscord(h.ctx, signal())
      expect(h.board.all.discord).toMatchObject({ state: 'ready', detail: expect.stringContaining('budget reached') })
      expect(h.store.get(`discord-cursor:${BOT}:${CHANNEL}`)).toBeUndefined()
      timeout.mockRestore()
      fetcher.mockClear().mockResolvedValueOnce(response(channel(second))).mockResolvedValueOnce(response([]))
        .mockResolvedValueOnce(response(channel())).mockResolvedValueOnce(response([]))
      await pollDiscord(h.ctx, signal())
      expect(String(fetcher.mock.calls[0]![0])).toContain(`channels/${second}`)
    } finally { timeout.mockRestore(); h.store.close() }
  })
  it('uses the server boundary even with a fast local clock, and snapshots latest when metadata omits it', async () => {
    const h = host(), base = 9007199254740993000n
    try {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
      fetcher.mockResolvedValueOnce(response({ ...channel(), last_message_id: String(base) }))
        .mockResolvedValueOnce(response([message(String(base + 1n))]))
      await pollDiscord(h.ctx, signal())
      expect(String(fetcher.mock.calls[1]![0])).toContain(`after=${base}`)
      expect(h.receive).toHaveBeenCalledTimes(1)
      h.store.delete(`discord-cursor:${BOT}:${CHANNEL}`)
      fetcher.mockClear().mockResolvedValueOnce(response({ ...channel(), last_message_id: undefined }))
        .mockResolvedValueOnce(response([{ id: String(base + 2n) }])).mockResolvedValueOnce(response([message(String(base + 3n))]))
      await pollDiscord(h.ctx, signal())
      expect(String(fetcher.mock.calls[1]![0])).toContain('messages?limit=1')
      expect(String(fetcher.mock.calls[2]![0])).toContain(`after=${base + 2n}`)
      expect(h.receive).toHaveBeenCalledTimes(2)
    } finally { h.store.close() }
  })
  it('routes an authorized mention through the Engine into a DSH executor assignment and filters unlisted channels', () => {
    const h = host()
    try {
      const trigger = discordTrigger(message('900000000000000001'), BOT, GUILD)!
      h.receive(trigger)
      const candidate = h.candidates[0]!
      expect(candidate).toBeDefined()
      h.engine.decide(trigger.id, { evalId: candidate.evalId, kind: 'accept', title: 'Fix', scope: 'small bug', reason: 'requested', acknowledgement: 'On it' })
      expect(h.executor.start).toHaveBeenCalledTimes(1)
      expect(h.store.tickets.open()[0]).toMatchObject({ mandate: { strength: 'explicit', actor: { source: 'discord', id: USER } } })
      expect(h.engine.receive({ ...trigger, id: 'outside', meta: { channelId: '999' } })).toBe('filtered')
      const botTrigger = discordTrigger(message('900000000000000002', { author: { id: USER, username: 'Fake', bot: true } }), BOT)!
      expect(settingsPolicy(h.store.settings(), h.sources).gate(botTrigger, h.store.threads.get(`discord:${CHANNEL}`)!, h.store.tickets.open())).not.toMatchObject({ strength: 'explicit' })
    } finally { h.store.close() }
  })
  it('does not poll when disabled and stops requests after bot authentication is rejected', async () => {
    const h = host(), controller = new AbortController()
    try {
      const settings = h.store.settings()
      h.store.saveSettings({ ...settings, sources: { ...settings.sources, discord: { enabled: false, config: DiscordConfigSchema.parse({ tokenFile }) } } })
      await pollDiscord(h.ctx, signal())
      expect(fetcher).not.toHaveBeenCalled()
      h.store.saveSettings(settings)
      fetcher.mockResolvedValue(response({}, 401))
      await runDiscord(h.ctx, controller.signal)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(h.board.all.discord).toMatchObject({ state: 'error', detail: expect.stringContaining('HTTP 401') })
    } finally { controller.abort(); h.store.close() }
  })
  it('reads the triggering message, same-channel parent and bounded history pages without following cross-channel references', async () => {
    const trigger = discordTrigger(message('903', { message_reference: { message_id: '901', channel_id: CHANNEL } }), BOT)!
    fetcher.mockResolvedValueOnce(response(message('903'))).mockResolvedValueOnce(response(message('901')))
      .mockResolvedValueOnce(response([message('903'), message('902')]))
    expect(await readDiscord(commands(), trigger, 'root')).toMatchObject({ messages: [{ id: '903' }] })
    expect(await readDiscord(commands(), trigger, 'parent')).toMatchObject({ messages: [{ id: '901' }] })
    expect(await readDiscord(commands(), trigger, 'thread', undefined, 2)).toMatchObject({ messages: [{ id: '903' }, { id: '902' }], next: '902' })
    expect(String(fetcher.mock.calls[2]![0])).toContain('limit=2&before=904')
    fetcher.mockResolvedValueOnce(response([message('901')]))
    expect(await readDiscord(commands(), trigger, 'thread', '902', 2)).not.toHaveProperty('next')
    expect(String(fetcher.mock.calls[3]![0])).toContain('before=902')
    fetcher.mockResolvedValue(response({}, 404))
    expect(await readDiscord(commands(), trigger, 'root')).toMatchObject({ status: 'deleted', messages: [] })
    const cross = discordTrigger(message('904', { message_reference: { message_id: '901', channel_id: '999' } }), BOT)!
    expect(await readDiscord(commands(), cross, 'parent')).toMatchObject({ messages: [] })
  })
  it('keeps history pagination moving when a context-only message is malformed', async () => {
    const trigger = discordTrigger(message('903'), BOT)!
    fetcher.mockResolvedValueOnce(response([message('903'), { id: '902', channel_id: CHANNEL, author: null }]))
    expect(await readDiscord(commands(), trigger, 'thread', undefined, 2)).toMatchObject({
      messages: [{ id: '903' }], next: '902', body: { skipped: 1 },
    })
    fetcher.mockResolvedValueOnce(response([message('901')]))
    expect(await readDiscord(commands(), trigger, 'thread', '902', 2)).toMatchObject({ messages: [{ id: '901' }] })
  })
  it('serves Discord originals through orchestrator_read only for a ticket that reached the trigger', async () => {
    const h = host()
    try {
      const original = message('900000000000000001')
      const trigger = discordTrigger(original, BOT, GUILD)!
      h.receive(trigger)
      h.engine.decide(trigger.id, { evalId: h.candidates[0]!.evalId, kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'On it' })
      const ticket = h.store.tickets.open()[0]!
      const resources = { store: h.store, commands: commands(), masterId: 'main', pages: new TextCache(100000) } as unknown as ResourceHost
      fetcher.mockResolvedValue(response(original))
      const result = await readResource(resources, `discord/${trigger.id}/root`, 0, 4000, ticket.id) as { text: string }
      expect(JSON.parse(result.text)).toMatchObject({ messages: [{ id: original.id, text: original.content }] })
      await expect(readResource(resources, `discord/${trigger.id}/root`, 0, 4000, 'other-ticket')).rejects.toMatchObject({ code: 'notReached' })
      await expect(readResource(resources, `discord/${trigger.id}/root/123`, 0, 4000, ticket.id)).rejects.toThrow('Unknown Discord context resource')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally { h.store.close() }
  })
  it('continues past one forbidden channel and polls an explicitly configured native thread independently', async () => {
    const h = host(), thread = '800000000000000099'
    try {
      const settings = h.store.settings()
      h.store.saveSettings({ ...settings, sources: { ...settings.sources, discord: { enabled: true, config: DiscordConfigSchema.parse({ tokenFile,
        channels: [{ channelId: CHANNEL, listen: 'mentions' }, { channelId: thread, listen: 'all' }] }) } } })
      h.store.set(`discord-cursor:${BOT}:${thread}`, '9007199254740993000')
      fetcher.mockResolvedValueOnce(response({}, 403)).mockResolvedValueOnce(response({ ...channel(thread), type: 11 }))
        .mockResolvedValueOnce(response([message('9007199254740993001', { channel_id: thread })]))
      await pollDiscord(h.ctx, signal())
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(h.receive.mock.calls[0]![0]).toMatchObject({ threads: [{ source: 'discord', id: thread }] })
      expect(h.board.all.discord).toMatchObject({ state: 'error', detail: expect.stringContaining('HTTP 403') })
      expect(h.store.get(`discord-cursor:${BOT}:${CHANNEL}`)).toBeUndefined()
      expect(h.store.get(`discord-cursor:${BOT}:${thread}`)).toBe('9007199254740993001')
    } finally { h.store.close() }
  })
  it('registers the Discord operational skill only with a configured bot', () => {
    const store = new Store(join(directory, 'prompts.sqlite'))
    try {
      const active = new Prompts(store, () => 100000, () => [], () => false, () => true)
      const inactive = new Prompts(store, () => 100000, () => [], () => false)
      expect(active.skills(defaultPrompts()).find(([name]) => name === 'discord')?.[1]).toContain('orchestrator_reply')
      expect(inactive.skills(defaultPrompts()).map(([name]) => name)).not.toContain('discord')
    } finally { store.close() }
  })
})

describe('Discord replies', () => {
  it('uses stable nonce enforcement and persistent receipts, disables mentions and tolerates a deleted reply target', async () => {
    fetcher.mockResolvedValue(response({ id: '999' }))
    const value = outgoing()
    expect(await sendDiscord({ commands: commands() }, value)).toBe('sent')
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body).toMatchObject({ allowed_mentions: { parse: [], replied_user: false }, enforce_nonce: true, message_reference: { fail_if_not_exists: false } })
    expect(body.nonce).toHaveLength(25)
    expect(await sendDiscord({ commands: commands() }, value)).toBe('sent')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(readFileSync(tokenFile, 'utf8')).toContain('test_bot_secret')
  })
  it('rejects oversized Discord messages before persisting an outbox effect', () => {
    const store = new Store(join(directory, 'outbox.sqlite'))
    const enqueue = vi.fn()
    try {
      const outbox = new Outbox({ store, effects: { handle: vi.fn(), enqueue, cancel: vi.fn(), idle: async () => {} },
        sources: { instance: vi.fn(), channelAllowed: vi.fn(), send: vi.fn() }, commands: commands(), paused: () => false })
      expect(() => outbox.send({ ...outgoing(), text: 'x'.repeat(2001) })).toThrow('2000')
      expect(enqueue).not.toHaveBeenCalled()
      expect(store.receipts.get('reply-1')).toBeUndefined()
    } finally { store.close() }
  })
  it('prunes only old or excess receipts confirmed sent by the canonical Outbox', async () => {
    const receipts = join(directory, 'discord-outbox')
    mkdirSync(receipts)
    const file = (n: number) => join(receipts, `${String(n).padStart(64, '0')}.json`)
    const old = new Date(Date.now() - 40 * 86400_000)
    for (let n = 0; n < 1004; n++) {
      writeFileSync(file(n), JSON.stringify({ id: '999', outgoingId: `outgoing-${n}` }))
      utimesSync(file(n), new Date(old.getTime() + n * 1000), new Date(old.getTime() + n * 1000))
    }
    // Newest file remains under count+age retention; pending and unknown statuses are protected regardless of age.
    utimesSync(file(1003), new Date(), new Date())
    await pruneDiscordReceipts(receipts, id => id === 'outgoing-0' ? 'pending' : id === 'outgoing-1' ? undefined : 'sent')
    expect(existsSync(file(0))).toBe(true)
    expect(existsSync(file(1))).toBe(true)
    expect(existsSync(file(2))).toBe(false)
    expect(existsSync(file(1003))).toBe(true)
  })
  it('marks missing channels gone, retains retryable permission/network failures, and rejects oversized replies', async () => {
    fetcher.mockResolvedValueOnce(response({}, 404))
    expect(await sendDiscord({ commands: commands() }, outgoing())).toBe('gone')
    fetcher.mockResolvedValueOnce(response({}, 403))
    await expect(sendDiscord({ commands: commands() }, outgoing())).rejects.toMatchObject({ code: 403 })
    fetcher.mockRejectedValueOnce(new Error('transport secret'))
    await expect(sendDiscord({ commands: commands() }, outgoing())).rejects.toThrow('Discord API connection failed')
    await expect(sendDiscord({ commands: commands() }, { ...outgoing(), text: 'x'.repeat(2001) })).rejects.toThrow('2000')
  })
})
