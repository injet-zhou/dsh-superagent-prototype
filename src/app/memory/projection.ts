/** Private Markdown projections are derived artifacts; only SQLite is authoritative. */
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MemoryService } from './service.ts'
import { MEMORY_BOUNDARY, MemoryId } from './types.ts'
import { MemoryKnowledge } from './knowledge.ts'

const prose = (value: string): string => value.replace(/[&<>`*_\[\]()!#|\\]/g, char => `&#${char.charCodeAt(0)};`)

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
        const root = await realpath(this.stateDir), directory = join(root, 'memory'), wiki = join(directory, 'wiki'), topics = join(directory, 'topics')
        await this.directory(directory); await this.directory(wiki); await this.directory(topics)
        const memory = this.memory.publisher(), index = [`# Repository memory\n\n${MEMORY_BOUNDARY}\n`]
        const knowledge = new MemoryKnowledge(memory), topicIndex = [`# Knowledge topics\n\n${MEMORY_BOUNDARY}\n`]
        index.push('## Topics\n')
        for (const record of knowledge.topics()) {
          const topic = knowledge.view(record.id)!
          MemoryId.parse(topic.id)
          const body = [`# ${prose(topic.title)}\n\n${MEMORY_BOUNDARY}\n\nDerived topic · revision ${topic.revision}\n`]
          if (topic.stale) body.push('Source revisions changed or were invalidated. Unavailable sections are withdrawn pending a new review.\n')
          for (const section of topic.sections) {
            body.push(`## ${prose(section.heading)}\n\n${section.kind === 'inference' ? 'Inference from cited sources' : 'Derived ' + section.kind}\n\n${prose(section.text)}\n\nSources:\n`)
            for (const source of section.sources) body.push(`- [${source.noteId}](../wiki/${source.noteId}.md), revision ${source.revision}; evidence ${source.evidenceIds.join(', ')}\n`)
          }
          if (topic.relations.length) body.push('## Proposed knowledge relationships\n')
          for (const relation of topic.relations) body.push(`- [${relation.from}](../wiki/${relation.from}.md) ${relation.kind} [${relation.to}](../wiki/${relation.to}.md): ${prose(relation.explanation)}\n`)
          if (topic.relatedTopics.length) body.push('## Related topics\n')
          for (const id of topic.relatedTopics) body.push(`- [${id}](${id}.md)\n`)
          await this.write(topics, `${topic.id}.md`, body.join('\n'))
          if (!topic.stale) {
            index.push(`- [${prose(topic.title)}](topics/${topic.id}.md)\n`)
            topicIndex.push(`- [${prose(topic.title)}](${topic.id}.md)\n`)
          }
        }
        await this.write(topics, 'index.md', topicIndex.join('\n'))
        index.push('\n## Verified source notes\n')
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
