/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { stopBackground, stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForChildren: (agent: Agent) => Promise<boolean>, drainChildren: () => Promise<void> = async () => {}) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const subagents = { waitForChildren: vi.fn(waitForChildren), listChildren: async () => [{ id: 'child-1' }], drainChildren: vi.fn(drainChildren) }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const agents = new Map<string, { id: string }>([[agent.id, agent], ['child-1', { id: 'child-1' }]])
  const ctx = { get: (name: string) => services[name], agents } as unknown as Context
  return { ctx, agent, jobs, subagents }
}

it('waits for and stops live descendants on DSH with the tree-scoped subagent API', async () => {
  const { agent } = setup(async () => false)
  const child = { id: 'child-1', cancel: vi.fn() }
  const grandchild = { id: 'child-2', cancel: vi.fn() }
  const agents = new Map([agent, child, grandchild].map(value => [value.id, value]))
  const listDescendants = vi.fn(async () => [child, grandchild, { id: 'finished-child' }])
  const waitForTreeWork = vi.fn(async () => false)
  const subagents = { listDescendants, waitForTreeWork }
  const ctx = { get: (name: string) => name === 'subagents' ? subagents : undefined, agents } as unknown as Context

  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(true)
  expect(waitForTreeWork).toHaveBeenCalledWith(agent)
  await stopBackground(ctx, agent.id, 'Assignment ended', true)
  expect(listDescendants).toHaveBeenCalledWith(agent.id)
  expect(waitForTreeWork).toHaveBeenCalledTimes(2)
  for (const descendant of [child, grandchild]) {
    expect(descendant.cancel).toHaveBeenCalledWith({ kind: 'parent' }, { keepInbox: false })
    expect(descendant.cancel.mock.invocationCallOrder[0]).toBeLessThan(waitForTreeWork.mock.invocationCallOrder[1]!)
  }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })

  agents.delete(child.id); agents.delete(grandchild.id)
  agent.cancel.mockClear()
  await stopBackground(ctx, agent.id, 'Assignment ended')
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup(async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); (agent as { status: string }).status = 'running'
    return false
  })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup(() => { joining(); return new Promise(() => {}) })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForChildren).toHaveBeenCalledTimes(1)
})

it('gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke', async () => {
  const { ctx, agent } = setup(async () => false, () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let stopped = false
    const stopping = stopSubagents(ctx, agent).then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})
