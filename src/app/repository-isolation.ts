/** Reject ambiguous subscriptions before they can create duplicate work in two repositories. */
import type { Settings } from '../policy.ts'
import { SettingsConflict } from './settings.ts'

export function assertRepositoryIsolation(entries: readonly { id: string; settings: Settings }[], multi = entries.length > 1): void {
  const owners = new Map<string, string>()
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
      // This first version has no cross-repository IM request routing: dedicate each bot configuration to one repository.
      if (kind === 'feishu' && config.cli) claim(`feishu-cli:${config.cli}`, id)
      if (kind === 'discord' && config.tokenFile) claim(`discord-token:${config.tokenFile}`, id)
      const rows = kind === 'feishu' ? config.chats : kind === 'discord' ? config.channels : undefined
      if (Array.isArray(rows)) for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const channel = row.chatId ?? row.channelId
        if (typeof channel === 'string' && channel) claim(`${kind}-channel:${channel}`, id)
      }
    }
  }
}
