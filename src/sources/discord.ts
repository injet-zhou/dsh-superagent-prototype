/** Optional Discord Source: explicit channels/threads, REST polling, policy admission and bot replies. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { DiscordBotSchema } from '../deployment.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { DiscordChannel, DiscordMessage, Snowflake } from '../infra/discord.ts'
import { checkedDiscordText } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ChannelHost, ContextMessage, ContextPart, ContextPartName, Localized, SourceKind } from './kind.ts'
import { pause } from './poll.ts'

const SOURCE = 'discord'
export const DiscordConfigSchema = DiscordBotSchema.extend({
  channels: z.array(z.object({ channelId: Snowflake, name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .max(100).refine(channels => new Set(channels.map(channel => channel.channelId)).size === channels.length, 'Duplicate channel IDs').default([]),
  pollIntervalMs: z.number().int().min(5000).max(300000).default(15000),
  readPageSize: z.number().int().min(1).max(100).default(50),
}).strict()
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>
export const discordTriggerId = (id: string): string => key(SOURCE, id)
const messageUrl = (channel: string, guild = '@me', message = ''): string => `https://discord.com/channels/${guild}/${channel}${message ? `/${message}` : ''}`
export function discordText(message: DiscordMessage): string {
  return [message.content, ...message.attachments.map(file => `[Attachment: ${file.filename}] ${file.url}`)].filter(Boolean).join('\n')
}
/** Each native Discord channel/thread is one domain Thread. Bot/webhook messages can never authorize explicit work. */
export function discordTrigger(message: DiscordMessage, botId: string, guildId?: string): Trigger | undefined {
  if (message.author.id === botId || ![0, 19].includes(message.type)) return
  const mentioned = message.mentions.some(user => user.id === botId)
  const parentId = message.message_reference?.channel_id === message.channel_id || !message.message_reference?.channel_id
    ? message.message_reference?.message_id : undefined
  return {
    id: discordTriggerId(message.id), source: SOURCE, threads: [{ source: SOURCE, id: message.channel_id }],
    actor: { source: SOURCE, id: message.author.id }, human: !message.author.bot && !message.webhook_id,
    ...(mentioned ? { addressed: 'mention' as const } : {}),
    at: new Date(message.timestamp).toISOString(), text: discordText(message), url: messageUrl(message.channel_id, guildId, message.id),
    channel: { source: SOURCE, thread: `discord:${message.channel_id}`, address: { channelId: message.channel_id, messageId: message.id, ...(guildId ? { guildId } : {}) } },
    meta: { channelId: message.channel_id, messageId: message.id, ...(guildId ? { guildId } : {}), ...(parentId ? { parentId } : {}) },
  }
}
const contextMessage = (message: DiscordMessage): ContextMessage => ({
  id: message.id, from: message.author.id, at: message.timestamp, text: discordText(message),
  ...(message.author.bot || message.webhook_id ? { bot: true as const } : {}),
  ...(message.message_reference?.message_id ? { reply_to: message.message_reference.message_id } : {}),
})
const MessageEnvelope = z.object({ id: Snowflake, channel_id: Snowflake })
/** Preserve pagination identity even when optional message content cannot be normalized. */
function discordPage(values: unknown[]): { id: string; channel_id: string; message: DiscordMessage | undefined }[] {
  return values.map(value => {
    const envelope = MessageEnvelope.safeParse(value)
    if (!envelope.success) throw new Error('Discord message lacks a valid ID/channel; cannot safely advance its cursor')
    const parsed = DiscordMessage.safeParse(value)
    return { ...envelope.data, message: parsed.success ? parsed.data : undefined }
  })
}
/** Reads only the trigger's channel; a parent reference to another channel is deliberately not followed. */
export async function readDiscord(commands: Commands, trigger: Trigger, part: ContextPartName, cursor?: string, size = 50): Promise<ContextPart> {
  if (trigger.source !== SOURCE) throw new Error('A Discord trigger is required')
  const channel = Snowflake.parse(trigger.meta.channelId), message = Snowflake.parse(trigger.meta.messageId)
  const base = `channels/${channel}/messages`
  if (part !== 'thread') {
    const target = part === 'parent' ? trigger.meta.parentId : message
    if (!target) return { messages: [], body: { channel_id: channel } }
    try {
      const item = await commands.discord(DiscordMessage, `${base}/${Snowflake.parse(target)}`)
      return { messages: [contextMessage(item)], body: { channel_id: channel } }
    } catch (error) {
      if (error instanceof CliError && error.code === 404) return { messages: [], body: { channel_id: channel }, status: 'deleted' }
      throw error
    }
  }
  const before = cursor ? Snowflake.parse(cursor) : (BigInt(message) + 1n).toString()
  const page = discordPage(await commands.discord(z.array(z.unknown()), `${base}?limit=${size}&before=${before}`))
  if (page.some(item => item.channel_id !== channel)) throw new Error('Discord returned a message outside the requested channel')
  const messages = page.flatMap(item => item.message ? [contextMessage(item.message)] : [])
  return { messages, ...(page.length === size ? { next: page.at(-1)!.id } : {}),
    body: { channel_id: channel, order: 'newest_first', skipped: page.length - messages.length } }
}

/** Persistent receipt plus Discord's recent-nonce deduplication cover normal retries and process restarts. */
export async function sendDiscord(host: ChannelHost, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const bot = commands.deployment.discord
  if (!bot) throw new Error('Discord bot is not configured')
  const channel = Snowflake.parse(message.channel.address.channelId)
  const target = Snowflake.parse(message.channel.address.messageId)
  const text = checkedDiscordText(message.text)
  const identity = createHash('sha256').update(JSON.stringify([bot.botId, channel, message.id])).digest('hex')
  const directory = join(commands.deployment.stateDir, 'discord-outbox')
  const receipt = join(directory, `${identity}.json`)
  try { z.object({ id: Snowflake }).parse(JSON.parse(await readFile(receipt, 'utf8'))); return 'sent' }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let sent: { id: string }
  try {
    sent = await commands.discord(z.object({ id: Snowflake }), `channels/${channel}/messages`, {
      content: text, nonce: identity.slice(0, 25), enforce_nonce: true,
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: { message_id: target, channel_id: channel, fail_if_not_exists: false },
    })
  } catch (error) {
    if (error instanceof CliError && error.code === 404) return 'gone'
    throw error
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${receipt}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ ...sent, outgoingId: message.id }), { mode: 0o600 })
  await rename(temporary, receipt)
  // Maintenance never changes delivery success; the canonical Outbox retains the authoritative sent status.
  if (host.receiptStatus) await pruneDiscordReceipts(directory, host.receiptStatus).catch(() => {})
  return 'sent'
}

const lastReceiptPrune = new Map<string, number>()
/** Prune old/excess transport receipts only after the canonical Outbox confirms delivery. Pending/legacy receipts stay. */
export async function pruneDiscordReceipts(directory: string, status: NonNullable<ChannelHost['receiptStatus']>): Promise<void> {
  const now = Date.now()
  if (now - (lastReceiptPrune.get(directory) ?? 0) < 300_000) return
  const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json(?:\.[0-9]+\.tmp)?$/.test(name))
  const entries = await Promise.all(files.map(async name => {
    const file = join(directory, name)
    const info = await stat(file)
    return { file, mtime: info.mtimeMs }
  }))
  entries.sort((a, b) => b.mtime - a.mtime)
  for (const [index, entry] of entries.entries()) {
    if (index < 1000 && now - entry.mtime < 30 * 86400_000) continue
    let stored: unknown
    try { stored = JSON.parse(await readFile(entry.file, 'utf8')) }
    catch { continue /* An unreadable receipt cannot prove delivery; keep it and continue maintaining the others. */ }
    const value = z.object({ outgoingId: z.string() }).safeParse(stored)
    if (value.success && status(value.data.outgoingId) === 'sent') await unlink(entry.file)
  }
  lastReceiptPrune.set(directory, now)
}

/** One bounded page per channel per round; checkpoints advance only after each trigger is durably received. */
export async function pollDiscord(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const config = ctx.config<DiscordConfig>(SOURCE), bot = ctx.deployment.discord
  if (!config || !bot) return
  const roundSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
  const commands = ctx.commands.withSignal(roundSignal)
  const failures: string[] = []
  let budgetExhausted = false
  const start = ctx.state.get(KV.discord.nextChannel(bot.botId)) ?? 0
  for (let offset = 0; offset < config.channels.length; offset++) {
    const index = (start + offset) % config.channels.length
    const entry = config.channels[index]!
    ctx.state.set(KV.discord.nextChannel(bot.botId), (index + 1) % config.channels.length)
    if (signal.aborted || !ctx.config(SOURCE)) return
    if (!ctx.config<DiscordConfig>(SOURCE)?.channels.some(channel => channel.channelId === entry.channelId)) continue
    try {
      const channel = await commands.discord(DiscordChannel, `channels/${entry.channelId}`)
      if (![0, 5, 10, 11, 12].includes(channel.type)) throw new Error('Use a guild text channel, announcement channel or thread ID')
      const checkpoint = KV.discord.cursor(bot.botId, channel.id)
      let after = ctx.state.get(checkpoint)
      // Use the server's boundary so a fast local clock cannot silently discard new messages.
      if (after === undefined) {
        after = channel.last_message_id ?? '0'
        if (channel.last_message_id === undefined) {
          const latest = await commands.discord(z.array(z.object({ id: Snowflake })), `channels/${channel.id}/messages?limit=1`)
          after = latest[0]?.id ?? '0'
        }
        ctx.state.set(checkpoint, after)
      }
      const page = await commands.discord(z.array(z.unknown()), `channels/${channel.id}/messages?limit=100&after=${after}`)
      // Discord's `after` window is the next page, returned newest first. Snowflakes must never pass through Number.
      // An identifiable malformed message is skipped with a diagnostic instead of blocking every future poll.
      const messages = discordPage(page)
      messages.sort((a, b) => {
        if (BigInt(a.id) < BigInt(b.id)) return -1
        if (BigInt(a.id) > BigInt(b.id)) return 1
        return 0
      })
      for (const message of messages) {
        if (signal.aborted) return
        const current = ctx.config<DiscordConfig>(SOURCE)?.channels.find(channel => channel.channelId === entry.channelId)
        if (!current) return
        if (message.channel_id !== channel.id) throw new Error('Discord returned a message outside the requested channel')
        if (BigInt(message.id) <= BigInt(after)) continue
        if (!message.message) failures.push(`${channel.id}: skipped malformed message ${message.id}`)
        const trigger = message.message ? discordTrigger(message.message, bot.botId, channel.guild_id) : undefined
        // Keep unmentioned channel chatter out of Intake, including its follow-up and ended-ticket resume paths.
        if (trigger && (current.listen === 'all' || trigger.addressed === 'mention')) {
          await ctx.receive(trigger)
          ctx.threads.describe(`discord:${channel.id}`, { label: channel.name || entry.name || channel.id, url: messageUrl(channel.id, channel.guild_id) })
        }
        ctx.state.set(checkpoint, message.id)
        after = message.id
      }
    } catch (error) {
      if (signal.aborted) return
      if (roundSignal.aborted) { budgetExhausted = true; break }
      failures.push(`${entry.channelId}: ${error instanceof Error ? error.message : 'Discord poll failed'}`)
      // Invalid bot credentials apply to every channel; avoid repeated unauthorized requests.
      if (error instanceof CliError && error.code === 401) throw error
    }
  }
  const detail = budgetExhausted ? 'Discord polling budget reached; continuing from saved cursors next round' : 'Polling configured Discord channels and threads'
  ctx.report(SOURCE, failures.length ? { state: 'error', detail: failures.join('\n') } : { state: 'ready', detail, at: new Date().toISOString() })
}
export async function runDiscord(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  while (!signal.aborted) {
    const config = ctx.config<DiscordConfig>(SOURCE)
    if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else if (!ctx.configured()) ctx.report(SOURCE, health('paused', 'setupPending'))
    else if (!ctx.deployment.discord) ctx.report(SOURCE, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : health('paused', 'discordTokenUnset'))
    else {
      try { await pollDiscord(ctx, signal) }
      catch (error) {
        if (signal.aborted) return
        const detail = error instanceof Error ? error.message : 'Discord poll failed'
        ctx.report(SOURCE, { state: 'error', detail: error instanceof CliError && error.code === 401 ? `${detail}; correct the token file and restart dsh-superagent` : detail })
        // An invalid token needs a corrected file and restart, not another request for every poll.
        if (error instanceof CliError && error.code === 401) return
      }
    }
    await pause(config?.pollIntervalMs ?? 5000, signal)
  }
}

export const discordKind: SourceKind<DiscordConfig> = {
  kind: SOURCE, title: { zh: 'Discord', en: 'Discord' },
  description: { zh: '轮询指定的服务器文字频道和线程，以机器人身份回复；每个频道或线程对应一个工单会话。', en: 'Polls explicit guild text channels and threads, replies as the bot; each channel/thread is one conversation.' },
  schema: DiscordConfigSchema, health: [SOURCE],
  fields: [
    { key: 'tokenFile', type: 'text', label: { zh: 'Bot Token 文件', en: 'Bot token file' }, hint: { zh: '私有 JSON 文件的绝对路径，内容为 {"token":"…"}；不要在此填写 Token。保存时校验机器人身份。', en: 'Absolute path of a private JSON file containing {"token":"…"}; enter the path, never the token. Saving verifies the bot identity.' } },
    { key: 'channels', type: 'rows', label: { zh: '接收的频道和线程', en: 'Channels and threads' }, hint: { zh: '启用开发者模式后复制频道或线程 ID；首次只接收启用后的新消息，线程需要单独添加。', en: 'Copy channel/thread IDs with Developer Mode enabled. First activation receives new messages only; add threads separately.' }, columns: [
      { key: 'channelId', type: 'text', pattern: '[0-9]{1,20}', label: { zh: '频道 / 线程 ID', en: 'Channel / thread ID' } },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All messages' } }] },
    ] },
    { key: 'pollIntervalMs', type: 'number', advanced: true, min: 5000, max: 300000, label: { zh: '轮询间隔 / 毫秒', en: 'Polling interval / ms' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 100, label: { zh: '上下文每页消息数', en: 'Context messages per page' } },
  ],
  scope({ meta }, config) {
    const channel = config.channels.find(entry => entry.channelId === meta.channelId)
    return channel ? { listened: true, observed: channel.listen === 'all', row: channel.channelId } : { listened: false, reason: 'channel_not_allowed' }
  },
  channel: {
    allowed: (address, config) => config.channels.some(channel => channel.channelId === address.channelId),
    send: sendDiscord,
    link: address => ({ url: messageUrl(address.channelId ?? '', address.guildId, address.messageId), label: { zh: 'Discord 消息', en: 'Discord message' }, ...(address.messageId ? { triggerId: discordTriggerId(address.messageId) } : {}) }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId),
    read: (commands, trigger, part, cursor, config) => readDiscord(commands, trigger, part, cursor, config.readPageSize),
  },
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? discordTriggerId(trigger.meta.parentId) : undefined,
  find(query) {
    const match = /discord\.com\/channels\/(?:[0-9]+|@me)\/([0-9]+)(?:\/([0-9]+))?/.exec(query)
    return { threads: match ? [`discord:${match[1]}`] : [], terms: match?.[2] ? [discordTriggerId(match[2])] : [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: Snowflake, name: z.string().optional() })).default([]) }).strict(),
    explicit: { zh: '消息 @ 机器人；身份按 Discord 用户 ID 匹配', en: 'The message mentions the bot; identities match Discord user IDs' },
    unnamed: { person: { zh: 'Discord 用户', en: 'Discord user' }, bot: { zh: 'Discord 机器人', en: 'Discord bot' } },
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许发起工作的用户', en: 'Users allowed to originate work' }, columns: [
      { key: 'id', type: 'text', pattern: '[0-9]{1,20}', label: { zh: '用户 ID', en: 'User ID' } },
      { key: 'name', type: 'text', optional: true, label: { zh: '姓名', en: 'Name' } },
    ] }],
    rows(stored) {
      return DiscordConfigSchema.parse(stored).channels.map(channel => ({ id: channel.channelId, label: channel.name || channel.channelId,
        note: channel.listen === 'all' ? { zh: '全部消息', en: 'All messages' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: channel.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: channel.listen === 'all' } }))
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_DISCORD_BOT', description: { zh: 'Discord 机器人用户 ID', en: 'Discord bot user ID' } },
      { key: 'DSH_SUPERAGENT_DISCORD_CHANNEL', description: { zh: '工单来源的 Discord 频道或线程 ID', en: 'Discord channel/thread ID that started the ticket' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_DISCORD_BOT: deployment.discord?.botId ?? '', DSH_SUPERAGENT_DISCORD_CHANNEL: trigger?.source === SOURCE ? String(trigger.meta.channelId ?? '') : '' }),
  },
  facts: (deployment): Record<string, string | Localized> => deployment?.discord ? { tokenFile: `Bot: ${deployment.discord.name} (${deployment.discord.botId})` } : {},
}
export const name = 'dsh-superagent-discord'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(discordKind), 'discord: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runDiscord(sourceContext(ctx.orchestrator, discordKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
