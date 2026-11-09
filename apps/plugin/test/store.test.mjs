import test from 'node:test'
import assert from 'node:assert/strict'

import { MonitorStore } from '../lib/store.js'

function fakeContext() {
  const listeners = new Map()
  const session = { id: 'session-store', header: { cwd: 'E:\\work\\demo' } }
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    sessions: { list: () => [session] },
    sessionProjections: {
      snapshot: () => ({
        asOfSeq: 1,
        values: {
          title: 'Store task',
          workingDirectory: 'E:\\work\\demo',
          todos: [{ content: 'step one', status: 'in_progress' }],
        },
      }),
    },
    agents: { get: () => undefined },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    emit(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args)
    },
    listeners,
    session,
  }
  return ctx
}

test('store folds live events and publishes a snapshot', async () => {
  const ctx = fakeContext()
  const store = new MonitorStore(ctx, { coalesceMs: 10, maxTasks: 30 })
  const frames = []
  store.setPublisher((frame) => frames.push(frame))
  const dispose = store.start()

  try {
    assert.equal(store.tasks().length, 1)
    assert.equal(store.tasks()[0].title, 'Store task')

    ctx.emit('session/event', ctx.session, { type: 'turn/start', seq: 2, time: 1_000, data: { turn: 1 } })
    ctx.emit('session/event', ctx.session, { type: 'step/start', seq: 3, time: 1_100, data: { turn: 1, step: 1 } })
    ctx.emit('agent/status', { agent: { id: ctx.session.id, session: ctx.session }, status: 'running' })
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.ok(frames.length >= 1)
    const latest = frames.at(-1)
    assert.equal(latest.tasks[0].phase, 'running')
    assert.equal(latest.tasks[0].turn.step, 1)
    assert.equal(latest.aggregate.running, 1)
  } finally {
    dispose()
  }
})
