/** Bot-only Discord REST transport. Credentials never enter settings, subprocess arguments or diagnostics. */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { CliError } from './errors.ts'

export const Snowflake = z.string().regex(/^[0-9]{1,20}$/)
export const DiscordUser = z.object({ id: Snowflake, username: z.string(), bot: z.boolean().optional() })
export const DiscordChannel = z.object({ id: Snowflake, type: z.number().int(), guild_id: Snowflake.optional(), name: z.string().nullish(), last_message_id: Snowflake.nullish() })
export const DiscordMessage = z.object({
  id: Snowflake, channel_id: Snowflake, author: DiscordUser, content: z.string(), timestamp: z.iso.datetime({ offset: true }),
  type: z.number().int().default(0), webhook_id: Snowflake.optional(),
  mentions: z.array(DiscordUser).default([]),
  message_reference: z.object({ message_id: Snowflake.optional(), channel_id: Snowflake.optional() }).optional(),
  attachments: z.array(z.object({ filename: z.string(), url: z.url() })).default([]),
})
export type DiscordMessage = z.infer<typeof DiscordMessage>

/** Identifies an insecure token file without including its content in diagnostics. */
class TokenPermissionsError extends Error {}

/** Only the bot identity, the channel/message endpoints this Source reads, and the bot's own reactions are exposed. */
const CHANNEL_PATH = /^users\/@me$|^channels\/[0-9]{1,20}(?:\/messages(?:\/[0-9]{1,20})?)?(?:\?(?:limit|before|after)=[0-9]+(?:&(?:limit|before|after)=[0-9]+)*)?$/
const REACTION_PATH = /^channels\/[0-9]{1,20}\/messages\/[0-9]{1,20}\/reactions\/(?!\.\.?\/)[A-Za-z0-9%._~!*'()-]+\/@me$/

/** One shared queue across command clones; conservatively pauses all routes when any bucket is exhausted. */
export class DiscordApi {
  private queue: Promise<unknown> = Promise.resolve()
  private resumeAt = 0
  constructor(readonly tokenFile: string) {}
  async request<T>(schema: z.ZodType<T>, path: string, signal: AbortSignal, body?: unknown,
    method: 'GET' | 'POST' | 'PUT' = body === undefined ? 'GET' : 'POST'): Promise<T> {
    // A body-carrying message endpoint is the only POST; adding a reaction is the only PUT this Source needs.
    if (!(method === 'PUT' ? REACTION_PATH : CHANNEL_PATH).test(path)) throw new Error('Unsupported Discord API path')
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const result = this.queue.then(() => this.perform(schema, path, bounded, body, method))
    this.queue = result.catch(() => {})
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(bounded.reason)
      bounded.addEventListener('abort', stop, { once: true })
      if (bounded.aborted) stop()
      result.then(resolve, reject).finally(() => bounded.removeEventListener('abort', stop))
    })
  }
  /**
   * Adds one emoji reaction as the bot. Discord answers 204 without a body and treats adding the same reaction again as success.
   * @throws CliError with the HTTP status when Discord refuses the message or the bot's permissions.
   */
  async react(channel: string, message: string, emoji: string, signal: AbortSignal): Promise<void> {
    // A dot-only segment would normalize the reaction URL back onto the message endpoint.
    if (!emoji || /^\.{1,2}$/.test(emoji)) throw new Error('Invalid Discord reaction emoji')
    const path = `channels/${Snowflake.parse(channel)}/messages/${Snowflake.parse(message)}/reactions/${encodeURIComponent(emoji)}/@me`
    await this.request(z.void(), path, signal, undefined, 'PUT')
  }
  private async perform<T>(schema: z.ZodType<T>, path: string, signal: AbortSignal, body: unknown,
    method: 'GET' | 'POST' | 'PUT'): Promise<T> {
    signal.throwIfAborted()
    if (!isAbsolute(this.tokenFile)) throw new Error('Discord token file must be an absolute path')
    let token: string
    try {
      const info = await stat(this.tokenFile)
      if (!info.isFile() || info.size > 8192) throw new Error()
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new TokenPermissionsError()
      token = z.object({ token: z.string().min(1).max(4096).regex(/^[A-Za-z0-9_.-]+$/) }).parse(JSON.parse(await readFile(this.tokenFile, 'utf8'))).token
    } catch (error) {
      if (error instanceof TokenPermissionsError) throw new Error('Discord token file must deny group and other access; use chmod 600 (or stricter)')
      throw new Error('Cannot read Discord bot token file; expected a private JSON file with a token field')
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted()
      if (this.resumeAt > Date.now()) await delay(this.resumeAt - Date.now(), undefined, { signal })
      let response: Response
      try {
        response = await fetch(`https://discord.com/api/v10/${path}`, {
          method, redirect: 'error',
          headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://github.com/injet-zhou/dsh-superagent-prototype, 0.1.0)' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
        })
      } catch {
        signal.throwIfAborted()
        throw new Error('Discord API connection failed')
      }
      // A reaction answers 204 with no body; an empty-body schema is the only one that accepts it.
      const data: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined)
      const reset = Number(response.headers.get('X-RateLimit-Reset-After'))
      if (response.headers.get('X-RateLimit-Remaining') === '0' && Number.isFinite(reset) && reset > 0) {
        this.resumeAt = Math.max(this.resumeAt, Date.now() + reset * 1000)
      }
      if (response.status === 429) {
        const retry = z.object({ retry_after: z.number().positive() }).safeParse(data)
        const seconds = retry.success ? retry.data.retry_after : Number(response.headers.get('Retry-After'))
        this.resumeAt = Math.max(this.resumeAt, Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000)
        continue
      }
      if (!response.ok) throw new CliError(`Discord API failed (HTTP ${response.status}); check bot credentials and channel permissions`, response.status)
      // Never surface schema errors containing remote content to setup diagnostics.
      const parsed = schema.safeParse(data)
      if (!parsed.success) throw new Error('Discord API returned an unexpected response')
      return parsed.data
    }
    throw new CliError('Discord API rate limit; retry later', 429)
  }
}
