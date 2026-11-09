import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'

import { BridgeServer } from '../lib/bridge.js'

function fakeStore() {
  const tasks = [
    {
      id: 'session-1',
      sourceId: 'plugin-test',
      title: 'Test task',
      origin: 'user',
      phase: 'running',
      updatedAt: Date.now(),
      progress: { kind: 'steps', label: '第 1 步' },
    },
  ]
  const state = {
    schema: 1,
    generatedAt: Date.now(),
    dsh: { sourceId: 'plugin-test', pid: process.pid, version: 'test', profile: 'test', mode: 'plugin' },
    aggregate: { total: 1, running: 1, waiting: 0, failed: 0, attention: 0, worst: 'running' },
    tasks,
    health: { source: 'plugin', lastSeq: 1 },
  }
  return {
    publisher: undefined,
    snapshot: () => state,
    setPublisher(fn) {
      this.publisher = fn
    },
    dshVersion: () => '0.2.2-test',
  }
}

test('bridge requires the token and exposes health, snapshot, SSE and discovery', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-test-'))
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'test'

  const store = fakeStore()
  const calls = { cancelled: 0, killed: 0 }
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    agents: { get: () => ({ cancel: () => { calls.cancelled += 1 } }) },
    jobs: { kill: async () => { calls.killed += 1 } },
  }
  const bridge = new BridgeServer(
    ctx,
    { port: 0, coalesceMs: 150, maxTasks: 30 },
    store,
  )

  try {
    await bridge.start()
    const discoveryPath = path.join(home, 'storages', 'task-monitor', 'bridges', `${process.pid}-test.json`)
    const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'))
    assert.equal(discovery.protocol, 1)
    assert.equal(discovery.url, `http://127.0.0.1:${bridge.port}`)

    const unauthorized = await fetch(`${discovery.url}/v1/snapshot`)
    assert.equal(unauthorized.status, 401)

    const headers = { authorization: `Bearer ${discovery.token}` }
    const health = await fetch(`${discovery.url}/v1/health`, { headers })
    assert.equal(health.status, 200)
    assert.equal((await health.json()).protocol, 1)

    const snapshot = await fetch(`${discovery.url}/v1/snapshot`, { headers })
    assert.equal(snapshot.status, 200)
    const state = await snapshot.json()
    assert.equal(state.schema, 1)
    assert.equal(state.tasks[0].id, 'session-1')

    const cancelTurn = await fetch(`${discovery.url}/v1/actions/cancel-turn`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    })
    assert.equal(cancelTurn.status, 200)
    assert.equal(calls.cancelled, 1)

    const cancelJob = await fetch(`${discovery.url}/v1/actions/cancel-job`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', jobId: 'job-1' }),
    })
    assert.equal(cancelJob.status, 200)
    assert.equal(calls.killed, 1)

    const controller = new AbortController()
    const stream = await fetch(`${discovery.url}/v1/events`, {
      headers: { ...headers, accept: 'text/event-stream' },
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)
    const reader = stream.body.getReader()
    const { value } = await reader.read()
    const first = new TextDecoder().decode(value)
    assert.match(first, /event: snapshot/)
    controller.abort()
    await reader.cancel().catch(() => {})

    await bridge.dispose()
    await assert.rejects(readFile(discoveryPath, 'utf8'))
  } finally {
    await bridge.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = previousProfile
    await rm(home, { recursive: true, force: true })
  }
})
