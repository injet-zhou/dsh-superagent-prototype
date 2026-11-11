import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { Store } from '../../src/app/store.ts'
import { MemoryStore } from '../../src/app/memory/store.ts'
import { MemoryService } from '../../src/app/memory/service.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { fingerprint } from '../../src/app/memory/security.ts'
import type { EvidenceInput, NoteInput } from '../../src/app/memory/types.ts'

export const exampleNote: NoteInput = { kind: 'procedure', title: 'SQLite migration checks', body: 'Run pnpm test tests/migration.spec.ts after changing SQLite migrations.', scope: { paths: ['src/app'] } }
export const exampleEvidence: EvidenceInput = { ticketId: 'ticketA', sessionId: 'worker-ticketA', eventRef: `seq:3:${fingerprint('test passed')}`,
  kind: 'test', excerpt: 'pnpm test tests/migration.spec.ts exited 0 on this checkout.', supportsVerification: true }
export function memoryFixture(repository = 'default:github:acme/widgets') {
  const directory = mkdtempSync(join(tmpdir(), 'agent-memory-')), path = join(directory, 'db.sqlite')
  const store = new Store(path), board = new HealthBoard()
  const service = new MemoryService(store, board.claim('memory'))
  service.bind(repository)
  const memory = service.publisher()
  onTestFinished(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, path, store, memory, service, board }
}
