/** WeCom intelligent-robot WebSocket transport: persistent connection, callbacks and Markdown messages. */
import { WSClient, type Logger } from '@wecom/aibot-node-sdk'
import { createHash } from 'node:crypto'
import { readWecomSecret } from './wecom-secret.ts'

/** Connection settings derived by setup; the secret itself is read from `secretFile` on every connect. */
export interface WecomConnectionOptions {
  botId: string
  secretFile: string
  wsUrl?: string
  /** How long one authentication round may take; tests shorten it. */
  connectTimeoutMs?: number
}
/** Health-bearing connection state. `retry` asks the caller to reconnect; a connection kicked by another client is not retried. */
export interface WecomConnectionState { state: 'ready' | 'paused' | 'error'; detail: string; retry?: boolean }
export interface WecomConnection {
  readonly connected: boolean
  /** Connects and resolves once the robot is authenticated; rejects when it cannot authenticate in time. */
  connect(): Promise<void>
  disconnect(): void
  /** Sends one Markdown message; `'gone'` only when WeCom permanently rejects the conversation. */
  send(conversation: string, text: string): Promise<'sent' | 'gone'>
  /** Receives the body of each robot message callback; returns a disposer. */
  onMessage(listener: (body: unknown) => void): () => void
  onState(listener: (state: WecomConnectionState) => void): () => void
}

/** WeCom user IDs that mean the conversation can never receive a message again. */
const GONE = new Set([40003, 81013, 86003])
/** The SDK writes connection chatter to its logger; health carries what an operator needs, so its output is dropped. */
const QUIET: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const AUTH_TIMEOUT_MS = 30_000
const authTimedOut = (): Error => new Error('Timed out waiting for WeCom authentication; check the network and the robot secret file')
// SDK errors and remote diagnostics may echo the authentication payload; expose only fixed messages and numeric codes.
const connectionFailed = (): Error => new Error('WeCom connection failed; check the network and robot credentials')

/** One robot's shared WebSocket: connects on demand, fans callbacks to its consumers, and sends Markdown replies. */
class WecomTransport implements WecomConnection {
  private client?: WSClient
  private state: 'idle' | 'connecting' | 'ready' = 'idle'
  private pending?: Promise<void>
  private manual = false
  private kicked = false
  private blocked?: string
  private authTimer?: ReturnType<typeof setTimeout>
  private rejectConnect?: (error: Error) => void
  private readonly connectTimeoutMs: number
  private readonly messages = new Set<(body: unknown) => void>()
  private readonly states = new Set<(state: WecomConnectionState) => void>()

  constructor(private readonly options: WecomConnectionOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? AUTH_TIMEOUT_MS
  }

  get connected(): boolean { return this.state === 'ready' }

  connect(): Promise<void> {
    if (this.blocked) return Promise.reject(new Error(this.blocked))
    if (this.state === 'ready') return Promise.resolve()
    if (this.pending) return this.pending
    const pending = this.open()
    this.pending = pending
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined }).catch(() => {})
    return pending
  }

  private open(): Promise<void> {
    this.destroy()
    this.manual = false
    this.kicked = false
    this.state = 'connecting'
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error?: Error) => {
        if (settled) return
        settled = true
        this.rejectConnect = undefined
        this.clearAuthTimer()
        if (error) { this.state = 'connecting'; reject(error) } else resolve()
      }
      this.rejectConnect = error => settle(error)
      void (async () => {
        const secret = await readWecomSecret(this.options.secretFile)
        if (secret.botId !== this.options.botId) throw new Error('The WeCom secret file now names another robot; restart dsh-superagent after changing it')
        if (this.manual) throw new Error('The WeCom connection was closed while connecting')
        let client: WSClient
        try {
          client = new WSClient({ botId: secret.botId, secret: secret.secret, logger: QUIET,
            ...(this.options.wsUrl ? { wsUrl: this.options.wsUrl } : {}), maxReconnectAttempts: -1, maxAuthFailureAttempts: 3 })
        } catch { throw connectionFailed() }
        this.client = client
        // Every WebSocket open starts a fresh authentication round, including the SDK's automatic reconnects.
        client.on('connected', () => { this.armAuthTimeout() })
        client.on('authenticated', () => {
          this.clearAuthTimer()
          this.state = 'ready'
          this.emit({ state: 'ready', detail: 'Connected to WeCom' })
          settle()
        })
        client.on('disconnected', () => {
          this.clearAuthTimer()
          if (this.kicked) return
          this.state = 'connecting'
          this.emit({ state: 'paused', detail: 'The WeCom connection closed; reconnecting' })
          if (!settled) settle(new Error('The WeCom connection closed before authentication'))
        })
        client.on('reconnecting', () => { this.emit({ state: 'paused', detail: 'Reconnecting to WeCom' }) })
        client.on('error', () => {
          const error = connectionFailed()
          this.state = 'connecting'
          this.emit({ state: 'error', detail: error.message, retry: true })
          if (!settled) settle(error)
        })
        client.on('event.disconnected_event', () => {
          this.clearAuthTimer()
          this.kicked = true
          this.state = 'connecting'
          const detail = 'WeCom closed this connection because another client connected with the same robot; stop the other client, then restart dsh-superagent'
          this.blocked = detail
          this.emit({ state: 'error', detail, retry: false })
          if (!settled) settle(new Error(detail))
        })
        client.on('message', frame => {
          for (const listener of [...this.messages]) {
            try { listener(frame.body) } catch { /* One consumer's failure must not starve the others. */ }
          }
        })
        // The timer also covers a socket that never opens; `connected` restarts it for each reconnect.
        this.armAuthTimeout()
        try { client.connect() } catch { throw connectionFailed() }
      })().catch(error => {
        settle(error instanceof Error ? error : new Error(String(error)))
        this.destroy()
      })
    })
  }

  /** Arms the protection for one authentication round; a timeout reports a retryable error and drops the dead client. */
  private armAuthTimeout(): void {
    this.clearAuthTimer()
    this.authTimer = setTimeout(() => {
      this.authTimer = undefined
      const error = authTimedOut()
      this.emit({ state: 'error', detail: error.message, retry: true })
      this.rejectConnect?.(error)
      this.destroy()
    }, this.connectTimeoutMs)
  }

  private clearAuthTimer(): void {
    if (!this.authTimer) return
    clearTimeout(this.authTimer)
    this.authTimer = undefined
  }

  disconnect(): void {
    this.manual = true
    this.blocked = undefined
    this.rejectConnect?.(new Error('The WeCom connection was closed'))
    this.rejectConnect = undefined
    this.destroy()
    this.state = 'idle'
  }

  async send(conversation: string, text: string): Promise<'sent' | 'gone'> {
    await this.connect()
    if (!this.client) throw new Error('The WeCom connection is not ready')
    try {
      await this.client.sendMessage(conversation, { msgtype: 'markdown', markdown: { content: text } })
      return 'sent'
    } catch (error) {
      const failure = error as { errcode?: unknown }
      const code = typeof failure?.errcode === 'number' ? failure.errcode : undefined
      if (code !== undefined) {
        if (GONE.has(code)) return 'gone'
        throw new Error(`WeCom rejected the reply (errcode ${code})`)
      }
      throw new Error('WeCom could not send the reply; check the connection and retry')
    }
  }

  onMessage(listener: (body: unknown) => void): () => void {
    this.messages.add(listener)
    return () => { this.messages.delete(listener) }
  }

  onState(listener: (state: WecomConnectionState) => void): () => void {
    this.states.add(listener)
    return () => { this.states.delete(listener) }
  }

  private emit(state: WecomConnectionState): void {
    for (const listener of [...this.states]) {
      try { listener(state) } catch { /* A health reporter's failure must not break the connection. */ }
    }
  }

  private destroy(): void {
    this.clearAuthTimer()
    const client = this.client
    this.client = undefined
    if (!client) return
    client.removeAllListeners()
    try { client.disconnect() } catch { /* The SDK may already have closed the socket. */ }
  }
}

const transports = new Map<string, WecomTransport>()
/** Returns the process-wide connection for one robot, so callbacks and replies share a single WebSocket. */
export function wecomTransport(options: WecomConnectionOptions): WecomConnection {
  const identity = createHash('sha256').update(JSON.stringify([options.secretFile, options.botId, options.wsUrl ?? '',
    options.connectTimeoutMs ?? AUTH_TIMEOUT_MS])).digest('hex')
  let transport = transports.get(identity)
  if (!transport) { transport = new WecomTransport(options); transports.set(identity, transport) }
  return transport
}

/** Closes every shared connection; tests call it so one case cannot reuse another's socket. */
export function resetWecomTransports(): void {
  for (const transport of transports.values()) transport.disconnect()
  transports.clear()
}
