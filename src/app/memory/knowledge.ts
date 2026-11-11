/** Derived topic articles and salience metadata. Claims and attestations remain in Notes. */
import { KV } from '../../kv.ts'
import { MemoryConflict, type MemoryStore } from './store.ts'
import { MemoryId, MemoryImportance, MemoryTopicInput, type MemoryDetails, type MemoryTopic, type MemoryNote } from './types.ts'
import { fingerprint, safeText } from './security.ts'

export function importanceOf(note: MemoryNote) {
  return note.importance?.noteRevision === note.revision ? note.importance.level : note.kind === 'incident' ? 'incidental' : 'routine'
}

/** Publishes derived topics and independently versioned salience for one bound repository. */
export class MemoryKnowledge {
  constructor(private readonly memory: MemoryStore) {}
  prioritize(id: string, revision: number, importanceRevision: number, level: 'core' | 'routine' | 'incidental', reason: string, job: string): void {
    this.memory.store.atomic(() => {
      const note = this.memory.get(id)?.note, previous = this.memory.store.get(KV.memory.importance(id))
      if (!note || note.revision !== revision || note.status === 'retracted' || (previous?.revision ?? 0) !== importanceRevision) throw new MemoryConflict('memory_importance_conflict')
      const parsed = MemoryImportance.parse(level)
      if (previous?.level === parsed && previous.noteRevision === revision) return
      const record = { repository: this.memory.repository, revision: importanceRevision + 1, noteRevision: revision,
        level: parsed, reason: safeText(reason, 500), at: new Date().toISOString(), job: fingerprint(job) }
      this.memory.store.set(KV.memory.importance(id), record)
      this.memory.store.set(KV.memory.importanceVersion(id, record.revision), record)
      this.memory.notify()
    })
  }
  importanceHistory(id: string) {
    MemoryId.parse(id)
    return this.memory.store.keys(KV.memory.importanceVersion).filter(key => key.startsWith(KV.memory.importanceVersion.prefix + id + ':'))
      .map(key => this.memory.store.get(key)!).filter(record => record.repository === this.memory.repository).sort((a, b) => b.revision - a.revision)
  }
  topic(id: string): MemoryTopic | undefined {
    MemoryId.parse(id)
    const topic = this.memory.store.get(KV.memory.topic(id))
    return topic?.repository === this.memory.repository ? topic : undefined
  }
  topics(): MemoryTopic[] { return this.memory.store.keys(KV.memory.topic).map(key => this.memory.store.get(key)!).filter(topic => topic.repository === this.memory.repository) }
  publish(raw: unknown, expectedRevision: number, offered: readonly MemoryDetails[], reason: string, job: string, proposedTopics: ReadonlySet<string> = new Set()): void {
    const parsed = MemoryTopicInput.parse(raw)
    const topic = MemoryTopicInput.parse({ ...parsed, title: safeText(parsed.title, 160), sections: parsed.sections.map(section =>
      ({ ...section, heading: safeText(section.heading, 120), text: safeText(section.text, 3000) })),
    relations: parsed.relations.map(relation => ({ ...relation, explanation: safeText(relation.explanation, 500) })) })
    this.memory.store.atomic(() => {
      if ((this.topic(topic.id)?.revision ?? 0) !== expectedRevision) throw new MemoryConflict('memory_topic_conflict')
      const sourceIds = new Set<string>()
      for (const section of topic.sections) for (const source of section.sources) {
        const previous = offered.find(item => item.note.id === source.noteId), current = this.memory.get(source.noteId)
        if (!previous || previous.note.repository !== this.memory.repository || previous.note.revision !== source.revision
          || current?.note.revision !== source.revision) throw new MemoryConflict('memory_revision_conflict')
        if (current.note.status !== 'verified' || source.evidenceIds.some(id => !previous.evidence.some(item => item.id === id) || !current.evidence.some(item => item.id === id))) throw new Error('memory_topic_source_unverified')
        sourceIds.add(source.noteId)
      }
      if (topic.relations.some(relation => !sourceIds.has(relation.from) || !sourceIds.has(relation.to))) throw new Error('memory_topic_unknown_relation')
      if (topic.relatedTopics.some(id => id === topic.id || !this.topic(id) && !proposedTopics.has(id))) throw new Error('memory_topic_unknown_link')
      const record: MemoryTopic = { ...topic, repository: this.memory.repository, revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(), reason: safeText(reason, 500), job: fingerprint(job) }
      this.memory.store.set(KV.memory.topic(topic.id), record)
      this.memory.store.set(KV.memory.topicVersion(topic.id, record.revision), record)
      this.memory.notify()
    })
  }
  /** Never serve obsolete synthesized prose after a cited source changes or is invalidated. */
  view(id: string) {
    const topic = this.topic(id)
    if (!topic) return undefined
    const sections = topic.sections.filter(section => section.sources.every(source => {
      const current = this.memory.get(source.noteId)
      return current?.note.status === 'verified' && current.note.revision === source.revision
        && source.evidenceIds.every(id => current.evidence.some(item => item.id === id))
    }))
    const sourceIds = new Set(sections.flatMap(section => section.sources.map(source => source.noteId)))
    return { ...topic, stale: sections.length !== topic.sections.length, sections,
      relations: topic.relations.filter(relation => sourceIds.has(relation.from) && sourceIds.has(relation.to)),
      relatedTopics: topic.relatedTopics.filter(id => this.topic(id)) }
  }
}
