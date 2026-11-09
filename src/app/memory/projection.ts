/** Private Markdown projections are derived artifacts; only SQLite is authoritative. */
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MemoryService } from './service.ts'
import { MEMORY_BOUNDARY, MemoryId } from './types.ts'

/** Coalesces rebuilds, refuses symlink paths, and atomically replaces each generated file. */
export class MemoryProjection {
  private running?: Promise<void>
  private dirty = false
  constructor(private readonly memory: MemoryService, private readonly stateDir: string, private readonly signal: AbortSignal) {
    memory.subscribe(() => { void this.rebuild() })
  }
  rebuild(): Promise<void> {
    if (!this.memory.active() || this.signal.aborted) return Promise.resolve()
    this.dirty = true
    return this.running ??= this.loop().finally(() => {
      this.running = undefined
      if (this.dirty && !this.signal.aborted && this.memory.active()) void this.rebuild()
    })
  }
  idle(): Promise<void> { return this.running ?? Promise.resolve() }
  private async directory(path: string): Promise<void> {
    const before = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (before && (!before.isDirectory() || before.isSymbolicLink())) throw new Error('memory_projection_path')
    if (!before) await mkdir(path, { mode: 0o700 })
    if ((await realpath(path)) !== path) throw new Error('memory_projection_path')
  }
  private async write(directory: string, name: string, text: string): Promise<void> {
    this.signal.throwIfAborted()
    if (!this.memory.active()) return
    const target = join(directory, name)
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('memory_projection_path')
    const temporary = join(directory, `.memory-${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(text); await file.sync() } finally { await file.close() }
      this.signal.throwIfAborted()
      if (!this.memory.active()) return
      if (await realpath(directory) !== directory) throw new Error('memory_projection_path')
      await rename(temporary, target)
    } finally { await rm(temporary, { force: true }).catch(() => {}) }
  }
  private async loop(): Promise<void> {
    try {
      do {
        this.dirty = false
        const root = await realpath(this.stateDir), directory = join(root, 'memory'), wiki = join(directory, 'wiki')
        await this.directory(directory); await this.directory(wiki)
        const memory = this.memory.publisher(), index = [`# Repository memory\n\n${MEMORY_BOUNDARY}\n`]
        let after = ''
        for (;;) {
          this.signal.throwIfAborted()
          if (!this.memory.active()) return
          const page = memory.page(after)
          if (!page.length) break
          for (const note of page) {
            if (!this.memory.active()) return
            MemoryId.parse(note.id)
            const details = memory.get(note.id)!
            await this.write(wiki, `${note.id}.md`, `# Memory ${note.id}\n\n${MEMORY_BOUNDARY}\n\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\`\n`)
            if (note.status === 'verified') index.push(`- [${note.id}](wiki/${note.id}.md) — ${JSON.stringify(note.title).replace(/[<>&\[\]()`]/g, char => `&#${char.charCodeAt(0)};`)}\n`)
          }
          after = page.at(-1)!.id
        }
        await this.write(directory, 'index.md', index.join('\n'))
      } while (this.dirty && !this.signal.aborted && this.memory.active())
      this.memory.projectionResult(false)
    } catch { if (!this.signal.aborted) this.memory.projectionResult(true) }
  }
}
