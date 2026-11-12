/** Optional WeCom intelligent robot Source: WebSocket callbacks, Policy admission and Markdown replies. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type ReceiveResult, type Trigger } from '../core/index.ts'
import { WecomBotSchema, type WecomBot } from '../deployment.ts'
import { checkedImText } from '../infra/text.ts'
import { wecomTransport, type WecomConnection, type WecomConnectionState } from '../infra/wecom.ts'
import { chatRecipients, health, mountSource, type SourceContext } from './host.ts'
import type { ChannelHost, Localized, SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const SOURCE = 'wecom'
export const WecomConfigSchema = WecomBotSchema.extend({
  chats: z.array(z.object({ chatId: z.string().trim().min(1).max(256), name: z.string().trim().max(60).optional() }).strict())
    .max(100).refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs').default([]),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  directMessages: z.boolean().default(true),
}).strict()
export type WecomConfig = z.infer<typeof WecomConfigSchema>
export const wecomTriggerId = (id: string): string => key(SOURCE, id)
const MENTIONS: Localized = { zh: '仅 @', en: '@ only' }
const directThread = (userId: string): string => `direct:${userId}`
const groupThread = (chatId: string): string => `group:${chatId}`

const TextSchema = z.looseObject({ content: z.string() })
const MediaSchema = z.looseObject({ url: z.string().optional(), aeskey: z.string().optional() })
const MixedItemSchema = z.looseObject({ msgtype: z.string(), text: TextSchema.optional(), image: MediaSchema.optional() })
const QuoteSchema = z.looseObject({ msgtype: z.string(), text: TextSchema.optional(), image: MediaSchema.optional(),
  mixed: z.looseObject({ msg_item: z.array(MixedItemSchema) }).optional(), voice: TextSchema.optional(), file: MediaSchema.optional() })
/** One message callback body; unknown fields are retained by the SDK and ignored here. */
export const WecomMessageSchema = z.looseObject({
  msgid: z.string().min(1).max(256), msgtype: z.string().min(1).max(32), chattype: z.enum(['single', 'group']),
  chatid: z.string().min(1).max(256).optional(), aibotid: z.string().max(256).optional(),
  from: z.looseObject({ userid: z.string().min(1).max(256) }),
  create_time: z.union([z.number().finite(), z.string().regex(/^\d+$/).transform(Number)]).optional(),
  text: TextSchema.optional(), image: MediaSchema.optional(), voice: TextSchema.optional(), file: MediaSchema.optional(), video: MediaSchema.optional(),
  mixed: z.looseObject({ msg_item: z.array(MixedItemSchema) }).optional(), quote: QuoteSchema.optional(),
})
export type WecomMessage = z.infer<typeof WecomMessageSchema>

/** Normalizes the millisecond or second timestamp the callback carries into an ISO-8601 time. */
export function wecomTime(value: number | undefined, now = Date.now()): string {
  if (value === undefined) return new Date(now).toISOString()
  const time = value < 1_000_000_000_000 ? value * 1000 : value
  return new Date(Number.isFinite(time) ? time : now).toISOString()
}

function mixedText(items: readonly z.infer<typeof MixedItemSchema>[]): string {
  return items.flatMap(item => item.msgtype === 'text' && item.text ? [item.text.content]
    : item.msgtype === 'image' ? ['[Image]'] : []).join('\n')
}
function quotedText(quote: z.infer<typeof QuoteSchema> | undefined): string | undefined {
  if (!quote) return undefined
  if (quote.text) return quote.text.content
  if (quote.voice) return `[Voice] ${quote.voice.content}`
  if (quote.mixed) return mixedText(quote.mixed.msg_item)
  return `[${quote.msgtype}]`
}
/** A readable form of the callback body for Assessors and workers; attachments are named but not downloaded. */
export function wecomText(message: WecomMessage): string {
  const text = message.msgtype === 'text' && message.text ? message.text.content
    : message.msgtype === 'voice' && message.voice ? `[Voice] ${message.voice.content}`
      : message.msgtype === 'mixed' && message.mixed ? mixedText(message.mixed.msg_item)
        : message.msgtype === 'image' ? '[Image]'
          : message.msgtype === 'file' ? '[File]'
            : message.msgtype === 'video' ? '[Video]' : `[${message.msgtype}]`
  const quote = quotedText(message.quote)
  return quote === undefined ? text : `> ${quote}\n\n${text}`
}

/** Each group is one Thread and each direct conversation is another; a group message without a group ID cannot be replied to. */
export function wecomThreadId(message: WecomMessage): string | undefined {
  return message.chattype === 'group' ? message.chatid ? groupThread(message.chatid) : undefined : directThread(message.from.userid)
}
/**
 * Converts one message callback into a Trigger. WeCom delivers only group messages that mention the robot, so a group
 * message is addressed; a direct conversation is addressed by definition. The robot has no user identity in callbacks.
 */
export function wecomTrigger(message: WecomMessage): Trigger | undefined {
  if (message.msgtype === 'event') return undefined
  const thread = wecomThreadId(message)
  if (!thread) return undefined
  const direct = message.chattype === 'single'
  const conversation = direct ? message.from.userid : message.chatid!
  return {
    id: wecomTriggerId(message.msgid), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: message.from.userid }, human: true,
    addressed: direct ? 'direct' : 'mention', at: wecomTime(message.create_time),
    text: wecomText(message),
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`,
      address: { conversation, messageId: message.msgid, direct: direct ? 'true' : 'false', userId: message.from.userid } },
    meta: { chattype: message.chattype, chatId: conversation, userId: message.from.userid, messageId: message.msgid,
      direct, msgtype: message.msgtype, ...(message.quote ? { quoted: true } : {}) },
  }
}

/** The receiving rule for a Trigger's `meta`, also used for reply destinations. */
export function wecomScope(meta: Record<string, unknown>, config: WecomConfig) {
  if (meta.direct === true) return config.directMessages ? { listened: true as const, observed: false as const, row: 'direct' }
    : { listened: false as const, reason: 'direct_messages_not_allowed' }
  const chatId = typeof meta.chatId === 'string' ? meta.chatId : ''
  if (chatId && config.chats.some(chat => chat.chatId === chatId)) return { listened: true as const, observed: false as const, row: chatId }
  return config.otherChats === 'mentions' ? { listened: true as const, observed: false as const, row: 'other' }
    : { listened: false as const, reason: 'chat_not_allowed' }
}

/** One reply receipt per outgoing message, so a crash or retry after WeCom accepted a message does not send it twice. */
const receiptFile = (directory: string, identity: string): string => join(directory, `${identity}.json`)
const lastPrune = new Map<string, number>()
async function pruneReceipts(directory: string, status: NonNullable<ChannelHost['receiptStatus']>): Promise<void> {
  const now = Date.now()
  if (now - (lastPrune.get(directory) ?? 0) < 300_000) return
  const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json(?:\.[0-9]+\.tmp)?$/.test(name))
  const entries = await Promise.all(files.map(async name => {
    const file = join(directory, name)
    return { file, mtime: (await stat(file)).mtimeMs }
  }))
  entries.sort((a, b) => b.mtime - a.mtime)
  for (const [index, entry] of entries.entries()) {
    if (index < 1000 && now - entry.mtime < 30 * 86400_000) continue
    let stored: unknown
    try { stored = JSON.parse(await readFile(entry.file, 'utf8')) } catch { continue /* An unreadable receipt cannot prove delivery. */ }
    const value = z.object({ outgoingId: z.string() }).safeParse(stored)
    if (value.success && status(value.data.outgoingId) === 'sent') await unlink(entry.file)
  }
  lastPrune.set(directory, now)
}
/** Posts one Markdown reply through the shared robot connection; no server-side idempotency key exists, so a local receipt dedupes retries. */
export async function sendWecom(host: ChannelHost, message: OutboundMessage, connection?: WecomConnection): Promise<'sent' | 'gone'> {
  const bot = host.commands.deployment.wecom
  if (!bot) throw new Error('The WeCom robot is not configured')
  const conversation = message.channel.address.conversation
  if (!conversation) throw new Error('Missing WeCom reply target')
  const text = checkedImText(message.text)
  const identity = createHash('sha256').update(JSON.stringify([bot.botId, conversation, message.id])).digest('hex')
  const directory = join(host.commands.deployment.stateDir, 'wecom-outbox')
  const receipt = receiptFile(directory, identity)
  try { await stat(receipt); return 'sent' }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const result = await (connection ?? wecomTransport(bot)).send(conversation, text)
  if (result === 'gone') return 'gone'
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${receipt}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ at: new Date().toISOString(), outgoingId: message.id }), { mode: 0o600 })
  await rename(temporary, receipt)
  // Maintenance never changes delivery success; the canonical Outbox retains the authoritative sent status.
  if (host.receiptStatus) await pruneReceipts(directory, host.receiptStatus).catch(() => {})
  return 'sent'
}

/** Takes in one callback body, returns `'ignored'` for an event or a message this Source cannot map. */
export async function receiveWecom(ctx: SourceContext, body: unknown, peers: Iterable<SourceContext> = [ctx]): Promise<ReceiveResult | 'ignored'> {
  const parsed = WecomMessageSchema.safeParse(body)
  if (!parsed.success) return 'ignored'
  const trigger = wecomTrigger(parsed.data)
  if (!trigger) return 'ignored'
  if (!chatRecipients(peers, SOURCE, trigger).includes(ctx)) return 'ignored'
  const result = await ctx.receive(trigger)
  const direct = trigger.meta.direct === true
  const chatId = String(trigger.meta.chatId ?? '')
  const config = ctx.config<WecomConfig>(SOURCE)
  const name = direct ? undefined : config?.chats.find(chat => chat.chatId === chatId)?.name
  const value = direct ? { zh: '私聊', en: 'Direct message' } : name || chatId
  ctx.threads.describe(threadKey(trigger.threads[0]!), { label: direct ? 'Direct message' : name || chatId,
    facts: { chat: { label: { zh: '会话', en: 'Chat' }, value } } })
  return result
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const consumers = new Map<WecomConnection, Set<SourceContext>>()
/**
 * Keeps the robot connection in step with the switch and the resolved account, reports its health, and takes in callbacks
 * in order. The SDK reconnects a dropped socket itself; the loop recreates the connection when authentication fails or a
 * fatal error asks for a retry.
 */
export async function runWecom(ctx: SourceContext, signal: AbortSignal,
  transportOf: (bot: WecomBot) => WecomConnection = bot => wecomTransport(bot)): Promise<void> {
  await ctx.ready
  let active: { key: string; connection: WecomConnection; offMessage: () => void; offState: () => void } | undefined
  let retry = false
  let received = 0
  let queue = Promise.resolve()
  const disconnect = async () => {
    const current = active
    active = undefined
    retry = false
    if (!current) return
    current.offMessage()
    current.offState()
    const peers = consumers.get(current.connection)!
    peers.delete(ctx)
    if (!peers.size) { consumers.delete(current.connection); current.connection.disconnect() }
  }
  const report = (state: WecomConnectionState) => {
    if (state.state === 'ready') { retry = false
      ctx.report(SOURCE, { state: 'ready', detail: `Connected to WeCom; ${received} messages received`, at: new Date().toISOString() }) }
    else if (state.state === 'paused') ctx.report(SOURCE, health('paused', 'wecomDisconnected'))
    else {
      retry = state.retry === true
      ctx.report(SOURCE, { state: 'error', detail: state.detail, at: new Date().toISOString() })
    }
  }
  try {
    while (!signal.aborted) {
      const config = ctx.config<WecomConfig>(SOURCE)
      if (!config) {
        await disconnect()
        ctx.report(SOURCE, health('paused', 'sourceOff'))
      } else if (!ctx.configured()) {
        await disconnect()
        ctx.report(SOURCE, health('paused', 'setupPending'))
      } else if (!ctx.deployment.wecom) {
        await disconnect()
        ctx.report(SOURCE, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : health('paused', 'wecomSecretUnset'))
      } else {
        const bot = ctx.deployment.wecom
        const identity = JSON.stringify([bot.secretFile, bot.botId, bot.wsUrl ?? ''])
        if (active && (retry || active.key !== identity)) await disconnect()
        if (!active) {
          const connection = transportOf(bot)
          const peers = consumers.get(connection) ?? new Set<SourceContext>()
          peers.add(ctx)
          consumers.set(connection, peers)
          const offMessage = connection.onMessage(body => {
            if (signal.aborted || !ctx.config(SOURCE)) return
            queue = queue.then(() => signal.aborted ? 'ignored' : receiveWecom(ctx, body, peers)).then(result => {
              if (result === 'ignored') return
              received++
              ctx.report(SOURCE, { state: 'ready', detail: `Connected to WeCom; ${received} messages received`, at: new Date().toISOString() })
            })
              .catch(error => { if (!signal.aborted) ctx.report(SOURCE, { state: 'error', detail: `Could not take in a WeCom message: ${messageOf(error)}` }) })
          })
          const offState = connection.onState(report)
          active = { key: identity, connection, offMessage, offState }
          try {
            await connection.connect()
            if (!signal.aborted && connection.connected) report({ state: 'ready', detail: 'Connected to WeCom' })
          }
          catch (error) {
            await disconnect()
            if (!signal.aborted) {
              ctx.report(SOURCE, { state: 'error', detail: `Could not connect to WeCom: ${messageOf(error)}`, at: new Date().toISOString() })
              await pause(30_000, signal)
            }
            continue
          }
        }
      }
      await pause(5_000, signal)
    }
  } finally {
    await disconnect()
    await queue.catch(() => {})
  }
}

export const wecomKind: SourceKind<WecomConfig> = {
  kind: SOURCE,
  title: { zh: '企业微信', en: 'WeCom' },
  description: { zh: '通过智能机器人接收单聊消息和群里 @ 机器人的消息，以机器人身份回复 Markdown；每个群或单聊是一个会话。',
    en: 'Receives direct messages and group messages that mention the intelligent robot, and replies in Markdown as the robot; each group or direct conversation is one conversation.' },
  schema: WecomConfigSchema, health: [SOURCE],
  fields: [
    { key: 'secretFile', type: 'text', label: { zh: '机器人密钥文件', en: 'Robot secret file' },
      hint: { zh: '私有 JSON 文件的绝对路径，内容为 {"botId":"…","secret":"…"}；不要在此填写密钥。保存时读取机器人身份，保存后重启 dsh-superagent。', en: 'Absolute path of a private JSON file containing {"botId":"…","secret":"…"}; enter the path, never the secret. Saving reads the robot identity and restarts dsh-superagent.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Groups' },
      hint: { zh: '列出的群各有自己的准入行；群聊里企业微信只推送 @ 机器人的消息。不知道群 ID 时，先把“其他群”设为“仅 @”，消息进来后再添加。', en: 'Each listed group gets its own admission row; WeCom delivers only messages that mention the robot. If you do not know a group ID, set Other groups to "@ only" first, then add the group after its message arrives.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群 ID', en: 'Group ID' } },
        { key: 'name', type: 'text', optional: true, label: { zh: '名字', en: 'Name' } },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other groups' },
      options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: MENTIONS }],
      hint: { zh: '机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁能发起工作看策略里的准入。', en: 'Groups the robot has joined that are not listed above. "@ only" receives messages there that mention the robot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收单聊', en: 'Direct messages' } },
    { key: 'wsUrl', type: 'text', advanced: true, pattern: 'wss://[^\\s]+', label: { zh: '私有部署的 WebSocket 地址', en: 'Private deployment WebSocket address' },
      hint: { zh: '留空使用 wss://openws.work.weixin.qq.com；私有部署填写企业管理端显示的 wss 地址。', en: 'Leave empty for wss://openws.work.weixin.qq.com; a private deployment uses the wss address shown in its admin console.' } },
  ],
  scope: ({ meta }, config) => wecomScope(meta, config),
  channel: {
    allowed: (address, config) => wecomScope({ direct: address.direct === 'true', chatId: address.conversation }, config).listened,
    send: sendWecom,
    link: address => ({ url: '', label: { zh: '企业微信消息', en: 'WeCom message' }, ...(address.messageId ? { triggerId: wecomTriggerId(address.messageId) } : {}) }),
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1).max(256), name: z.string().trim().max(100).optional() }).strict())
      .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user IDs').default([]) }).strict(),
    explicit: { zh: '名单里的人私聊机器人，或在群里 @ 机器人；企业微信只把群里 @ 机器人的消息推送给它。', en: 'Someone on the list messages the robot directly or mentions it in a group; WeCom delivers only group messages that mention the robot.' },
    unnamed: { person: { zh: '企业微信用户', en: 'WeCom user' }, bot: { zh: '企业微信机器人', en: 'WeCom robot' } },
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的企业微信用户', en: 'WeCom users who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: 'UserID', en: 'UserID' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
    ] }],
    rows(stored) {
      const config = WecomConfigSchema.parse(stored)
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: MENTIONS,
          cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })),
        { id: 'other', label: { zh: '其他群', en: 'Other groups' }, note: config.otherChats === 'mentions' ? MENTIONS : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '单聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_WECOM_BOT', description: { zh: '企业微信智能机器人 ID', en: 'WeCom intelligent robot ID' } },
      { key: 'DSH_SUPERAGENT_WECOM_CHAT', description: { zh: '工单来源的企业微信群或单聊 UserID', en: 'WeCom group or direct-conversation UserID that started the ticket' } },
    ],
    values: ({ deployment, trigger }) => ({ DSH_SUPERAGENT_WECOM_BOT: deployment.wecom?.botId ?? '',
      DSH_SUPERAGENT_WECOM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.wecom
    ? { secretFile: { zh: `当前机器人 ${deployment.wecom.botId}`, en: `Current robot ${deployment.wecom.botId}` } } : {},
}

export const name = 'dsh-superagent-wecom'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  mountSource(ctx, wecomKind, runWecom)
}
