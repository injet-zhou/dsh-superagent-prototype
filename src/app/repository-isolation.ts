/** Reject ambiguous subscriptions before they can create duplicate work in two repositories. */
import type { Settings } from '../policy.ts'
import { SettingsConflict } from './settings.ts'

export function assertRepositoryIsolation(entries: readonly { id: string; settings: Settings }[], multi = entries.length > 1): void {
  const owners = new Map<string, string>()
  const wecomBots = new Map<string, { id: string; endpoint: string; otherChats: boolean }>()
  const claim = (key: string, id: string) => {
    const previous = owners.get(key)
    if (previous && previous !== id) throw new SettingsConflict(`Subscription is already assigned to repository ${previous}; it cannot also belong to ${id}`)
    owners.set(key, id)
  }
  for (const { id, settings } of entries) {
    for (const [kind, source] of Object.entries(settings.sources)) {
      if (!source.enabled) continue
      const config = source.config
      if (multi && kind === 'feishu' && config.otherChats === 'mentions') throw new SettingsConflict('Multi-repository Feishu requires explicit chat lists; otherChats must be none')
      if (kind === 'github' && config.repository) {
        let instance = 'https://github.com'
        if (config.provider === 'gitea' || config.provider === 'gitlab') {
          try { instance = new URL(String(config.baseUrl ?? '')).href.replace(/\/$/, '') }
          catch { continue /* Setup reports invalid instance URLs without stopping other repositories. */ }
        }
        claim(`repository:${instance}:${String(config.repository).toLowerCase()}`, id)
      }
      // Groups/channels select repositories. A shared bot's direct messages have no such selector.
      const bot = kind === 'feishu' ? config.cli : kind === 'wecom' ? config.secretFile : undefined
      if (bot && config.directMessages !== false) {
        const key = `${kind}-direct:${bot}`
        const previous = owners.get(key)
        if (previous && previous !== id) throw new SettingsConflict(`This ${kind === 'feishu' ? 'Feishu' : 'WeCom'} bot's direct messages already belong to repository ${previous}. Turn off Direct messages in ${id} to share the bot`)
        claim(key, id)
      }
      if (kind === 'wecom' && config.secretFile) {
        const file = String(config.secretFile), endpoint = String(config.wsUrl || 'wss://openws.work.weixin.qq.com')
        const previous = wecomBots.get(file)
        if (previous && previous.id !== id) {
          if (previous.otherChats || config.otherChats === 'mentions') throw new SettingsConflict('Sharing a WeCom robot requires explicit chat lists; otherChats must be none')
          if (previous.endpoint !== endpoint) throw new SettingsConflict('Repositories sharing a WeCom robot must use the same WebSocket address')
        }
        wecomBots.set(file, { id, endpoint, otherChats: config.otherChats === 'mentions' })
      }
      const rows = kind === 'feishu' ? config.chats : kind === 'discord' ? config.channels : kind === 'wecom' ? config.chats : undefined
      if (Array.isArray(rows)) for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const channel = row.chatId ?? row.channelId
        if (typeof channel === 'string' && channel) claim(`${kind}-channel:${channel}`, id)
      }
    }
  }
}
