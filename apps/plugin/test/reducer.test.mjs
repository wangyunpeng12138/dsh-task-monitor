import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyEvent,
  computeAggregate,
  createFold,
  seedFold,
  toSnapshot,
} from '../lib/reducer.js'

function makeFold() {
  const fold = createFold('session-test')
  seedFold(fold, {
    values: {
      title: 'Build the monitor',
      workingDirectory: 'E:\\work\\demo',
      todos: [
        { content: 'scaffold', status: 'completed' },
        { content: 'wire bridge', status: 'in_progress' },
        { content: 'test', status: 'pending' },
      ],
    },
    status: 'idle',
    cwd: 'E:\\work\\demo',
    updatedAt: 1_000,
  })
  return fold
}

test('seed builds todo progress and title', () => {
  const fold = makeFold()
  const snapshot = toSnapshot(fold, { now: 2_000 })
  assert.equal(snapshot.title, 'Build the monitor')
  assert.equal(snapshot.todos?.done, 1)
  assert.equal(snapshot.todos?.total, 3)
  assert.equal(snapshot.progress.kind, 'todos')
  assert.equal(snapshot.progress.percent, 50)
  assert.equal(snapshot.progress.label, '1/3 · wire bridge')
})

test('turn and step keep the task running', () => {
  const fold = makeFold()
  applyEvent(fold, { type: 'turn/start', seq: 1, time: 2_000, data: { turn: 1 } })
  applyEvent(fold, { type: 'step/start', seq: 2, time: 2_100, data: { turn: 1, step: 1 } })
  const snapshot = toSnapshot(fold, { now: 2_500 })
  assert.equal(snapshot.phase, 'running')
  assert.equal(snapshot.turn?.index, 1)
  assert.equal(snapshot.turn?.step, 1)
  assert.equal(snapshot.phaseReason, 'step started')
})

test('question tool call marks the task as waiting and a result clears it', () => {
  const fold = makeFold()
  applyEvent(fold, { type: 'turn/start', seq: 1, time: 2_000, data: { turn: 1 } })
  applyEvent(fold, {
    type: 'tool/call',
    seq: 2,
    time: 2_100,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-q',
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ question: 'Which branch?' }] }),
    },
  })
  let snapshot = toSnapshot(fold, { now: 2_200 })
  assert.equal(snapshot.phase, 'waiting')
  assert.equal(snapshot.waiting?.kind, 'question')
  assert.match(snapshot.waiting?.summary ?? '', /Which branch/)

  applyEvent(fold, {
    type: 'tool/result',
    seq: 3,
    time: 2_300,
    data: { turn: 1, step: 1, toolCallId: 'call-q', message: {} },
  })
  snapshot = toSnapshot(fold, { now: 2_400 })
  assert.equal(snapshot.phase, 'running')
  assert.equal(snapshot.waiting, undefined)
})

test('turn end maps reasons to phases', () => {
  for (const [kind, expected] of [
    ['completed', 'completed'],
    ['aborted', 'aborted'],
    ['error', 'failed'],
    ['max-tokens', 'failed'],
    ['blocked', 'blocked'],
    ['interrupted', 'interrupted'],
  ]) {
    const fold = makeFold()
    applyEvent(fold, { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } })
    applyEvent(fold, { type: 'turn/end', seq: 2, time: 200, data: { turn: 1, reason: { kind } } })
    const snapshot = toSnapshot(fold, { now: 300 })
    assert.equal(snapshot.phase, expected, `reason ${kind}`)
  }
})

test('jobs are counted and summarised', () => {
  const fold = makeFold()
  applyEvent(fold, {
    type: 'job/registered',
    seq: 1,
    time: 1_000,
    data: { jobId: 'pwsh-1', kind: 'pwsh', label: 'npm test', startedAt: 1_000 },
  })
  let snapshot = toSnapshot(fold, { now: 2_000 })
  assert.equal(snapshot.jobs?.running, 1)
  assert.equal(snapshot.jobs?.recent[0]?.elapsedMs, 1_000)

  applyEvent(fold, {
    type: 'job/settled',
    seq: 2,
    time: 3_000,
    data: {
      jobId: 'pwsh-1',
      kind: 'pwsh',
      label: 'npm test',
      startedAt: 1_000,
      finishedAt: 3_000,
      status: 'completed',
      detail: 'exit code: 0',
    },
  })
  snapshot = toSnapshot(fold, { now: 3_500 })
  assert.equal(snapshot.jobs?.running, 0)
  assert.equal(snapshot.jobs?.recent[0]?.elapsedMs, 2_000)
})

test('aggregate prefers waiting over running and counts failures', () => {
  const a = { phase: 'completed' }
  const b = { phase: 'running' }
  const c = { phase: 'waiting' }
  const d = { phase: 'failed' }
  assert.deepEqual(computeAggregate([a, b, c, d]), {
    total: 4,
    running: 1,
    waiting: 1,
    failed: 1,
    attention: 1,
    worst: 'waiting',
  })
})
