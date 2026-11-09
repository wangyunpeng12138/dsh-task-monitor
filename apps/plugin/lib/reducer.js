/**
 * Pure fold from DSH session events to monitor task snapshots.
 *
 * This file has no Cordis or Node dependency so it can be exercised with
 * plain `node --test` and reused by the bridge without a build step.
 */

const PHASE_RANK = {
  waiting: 0,
  failed: 1,
  running: 2,
  blocked: 3,
  interrupted: 4,
  stale: 5,
  completed: 6,
  aborted: 7,
  unknown: 8,
}

export function createFold(id) {
  return {
    id,
    title: '',
    cwd: '',
    origin: 'user',
    parentId: undefined,
    phase: 'unknown',
    phaseReason: undefined,
    startedAt: undefined,
    updatedAt: 0,
    turn: { index: 0, step: undefined },
    openTurn: false,
    agentRunning: false,
    lastTurnEnd: undefined,
    todos: undefined,
    stats: {
      steps: 0,
      lastTurn: 0,
      openStep: undefined,
      pendingCalls: {},
    },
    approvals: new Map(),
    waiting: undefined,
    goal: undefined,
    model: undefined,
    tokens: undefined,
    jobs: new Map(),
    lastEvent: undefined,
  }
}

function asNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value) {
  return typeof value === 'string' ? value : undefined
}

function basename(path) {
  if (!path) return ''
  const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || String(path)
}

function normalizeTodos(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const items = value
    .map((item) => ({
      content: asString(item?.content) ?? '',
      status: ['pending', 'in_progress', 'completed'].includes(item?.status) ? item.status : 'pending',
    }))
    .filter((item) => item.content)
  return items.length ? items : undefined
}

function extractGoal(value) {
  if (!value || typeof value !== 'object') return undefined
  const current = value.current ?? value
  if (!current || typeof current !== 'object') return undefined
  const objective = asString(current.objective) ?? asString(current.title)
  const phase = asString(current.phase)
  const round = asNumber(current.round ?? current.roundNumber, 0) || undefined
  const maxRounds = asNumber(current.maxRounds ?? current.max, 0) || undefined
  if (!objective && !phase && !round) return undefined
  return { objective, phase, round, maxRounds }
}

function extractModel(values) {
  const last = values.modelSelection?.lastUsed ?? values.modelSelection
  if (!last || typeof last !== 'object') return undefined
  const provider = asString(last.provider)
  const model = asString(last.model)
  if (!provider || !model) return undefined
  return { provider, model }
}

function extractTokens(values) {
  const pressure = values.contextPressure
  const window = asNumber(pressure?.contextWindow, 0)
  const used = asNumber(pressure?.pressureTokens, 0)
  const outputTokens = asNumber(values.tokenUsage?.totals?.outputTokens, 0) || undefined
  const contextPressure = window > 0 ? Math.min(1, Math.max(0, used / window)) : undefined
  if (contextPressure === undefined && outputTokens === undefined) return undefined
  return { contextPressure, outputTokens }
}

function questionList(value) {
  const active = value?.questions?.active
  return Array.isArray(active) ? active : []
}

function questionSummary(active) {
  if (!Array.isArray(active) || active.length === 0) return '等待回答'
  const first = active[0]
  const text =
    asString(first?.questions?.[0]?.question) ??
    asString(first?.questions?.[0]?.prompt) ??
    asString(first?.prompt) ??
    asString(first?.summary)
  return `${active.length} 个问题${text ? ` · ${text}` : '待回答'}`
}

function waitingFromQuestions(active, now) {
  if (!active || active.length === 0) return undefined
  return {
    kind: 'question',
    callId: asString(active[0]?.callId),
    since: asNumber(active[0]?.askedAt, now),
    summary: questionSummary(active),
  }
}

function approvalSummary(data) {
  return (
    asString(data?.summary) ??
    asString(data?.title) ??
    asString(data?.toolName) ??
    asString(data?.name) ??
    asString(data?.command) ??
    '等待审批'
  )
}

export function seedFold(fold, seed) {
  const values = seed?.values ?? {}
  fold.title = asString(values.title) ?? fold.title
  fold.cwd = asString(seed?.cwd) ?? asString(values.workingDirectory) ?? fold.cwd
  fold.origin = seed?.parentId ? 'subagent' : 'user'
  fold.parentId = seed?.parentId
  fold.todos = normalizeTodos(values.todos)
  fold.goal = extractGoal(values.goal)
  fold.model = extractModel(values)
  fold.tokens = extractTokens(values)
  fold.updatedAt = asNumber(seed?.updatedAt, Date.now())
  fold.agentRunning = seed?.status === 'running'

  const stats = values.sessionStats
  if (stats && typeof stats === 'object') {
    fold.stats.steps = asNumber(stats.steps, 0)
    fold.stats.lastTurn = asNumber(stats.lastTurn, 0)
    if (stats.openStep && typeof stats.openStep === 'object') {
      fold.stats.openStep = {
        turn: asNumber(stats.openStep.turn, 0),
        step: asNumber(stats.openStep.step, 0),
        startTime: asNumber(stats.openStep.startTime, 0) || undefined,
      }
      fold.openTurn = true
      fold.turn.index = fold.stats.openStep.turn
      fold.turn.step = fold.stats.openStep.step
      fold.startedAt = fold.stats.openStep.startTime
    }
    if (stats.pendingCalls && typeof stats.pendingCalls === 'object') {
      for (const [callId, call] of Object.entries(stats.pendingCalls)) {
        fold.stats.pendingCalls[callId] = {
          name: asString(call?.name) ?? 'tool',
          startedAt: asNumber(call?.startedAt, fold.updatedAt),
        }
      }
    }
  }

  const active = questionList(values.userQuestions)
  fold.waiting = waitingFromQuestions(active, fold.updatedAt)

  if (fold.waiting) fold.phase = 'waiting'
  else if (fold.agentRunning || fold.openTurn) fold.phase = 'running'
  else if (fold.stats.lastTurn > 0 || fold.turn.index > 0) fold.phase = 'completed'
  else fold.phase = 'unknown'

  if (!fold.title) fold.title = basename(fold.cwd) || `会话 ${fold.id.slice(0, 12)}`
  return fold
}

export function applyAgentStatus(fold, status) {
  fold.agentRunning = status === 'running'
  if (fold.agentRunning) {
    if (!fold.waiting) {
      fold.phase = 'running'
      fold.phaseReason = 'agent running'
    }
    return fold
  }
  if (fold.waiting) {
    fold.phase = 'waiting'
    return fold
  }
  if (fold.openTurn) {
    // Between steps the loop may be idle for a moment; a turn is still open.
    fold.phase = 'running'
    return fold
  }
  return fold
}

function setWaitingFromApprovals(fold, time) {
  if (fold.approvals.size === 0) {
    if (fold.waiting?.kind === 'approval') fold.waiting = undefined
    return
  }
  const entries = [...fold.approvals.values()]
  const first = entries.reduce((min, item) => (item.since < min.since ? item : min), entries[0])
  fold.waiting = {
    kind: 'approval',
    since: first.since,
    summary: first.summary,
  }
  fold.phase = 'waiting'
}

export function applyEvent(fold, event) {
  if (!event || typeof event !== 'object') return fold
  const type = event.type
  const data = event.data ?? {}
  const time = asNumber(event.time, Date.now())
  fold.updatedAt = Math.max(fold.updatedAt, time)
  fold.lastEvent = { type, seq: asNumber(event.seq, 0), time }

  switch (type) {
    case 'turn/start': {
      fold.openTurn = true
      fold.lastTurnEnd = undefined
      fold.turn.index = asNumber(data.turn, fold.turn.index + 1)
      fold.turn.step = undefined
      fold.startedAt = time
      fold.phase = fold.waiting ? 'waiting' : 'running'
      fold.phaseReason = 'turn started'
      fold.stats.openStep = undefined
      fold.stats.pendingCalls = {}
      break
    }
    case 'turn/end': {
      const kind = asString(data.reason?.kind) ?? 'completed'
      fold.openTurn = false
      fold.lastTurnEnd = { kind, time }
      fold.stats.openStep = undefined
      fold.stats.pendingCalls = {}
      fold.stats.lastTurn = fold.turn.index
      fold.waiting = undefined
      fold.approvals.clear()
      fold.phaseReason = kind
      switch (kind) {
        case 'aborted':
          fold.phase = 'aborted'
          break
        case 'error':
        case 'max-tokens':
          fold.phase = 'failed'
          break
        case 'blocked':
          fold.phase = 'blocked'
          break
        case 'interrupted':
        case 'forked':
          fold.phase = 'interrupted'
          break
        default:
          fold.phase = 'completed'
      }
      break
    }
    case 'step/start': {
      const turn = asNumber(data.turn, fold.turn.index)
      const step = asNumber(data.step, 0)
      fold.turn.index = turn
      fold.turn.step = step
      fold.stats.openStep = { turn, step, startTime: time }
      fold.stats.steps += 1
      fold.openTurn = true
      if (!fold.waiting && !fold.agentRunning) {
        fold.phase = 'running'
        fold.phaseReason = 'step started'
      }
      break
    }
    case 'step/end': {
      fold.stats.openStep = undefined
      break
    }
    case 'user/message': {
      if (data.source?.kind === 'user') {
        fold.lastPromptAt = time
        if (!fold.startedAt) fold.startedAt = time
      }
      break
    }
    case 'tool/call': {
      const callId = asString(data.callId)
      const name = asString(data.name) ?? 'tool'
      if (callId) fold.stats.pendingCalls[callId] = { name, startedAt: time }
      if (name === 'ask_user_question' && callId) {
        let summary = '等待回答'
        try {
          const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
          const questions = Array.isArray(args?.questions) ? args.questions : []
          const text = asString(questions[0]?.question) ?? asString(questions[0]?.prompt)
          summary = `${questions.length || 1} 个问题${text ? ` · ${text}` : '待回答'}`
        } catch {
          // Arguments are model output; an invalid JSON preview must not break monitoring.
        }
        fold.waiting = { kind: 'question', callId, since: time, summary }
        fold.phase = 'waiting'
      }
      break
    }
    case 'tool/result': {
      const callId = asString(data.toolCallId) ?? asString(data.message?.toolCallId) ?? asString(data.callId)
      if (callId) delete fold.stats.pendingCalls[callId]
      if (callId && fold.waiting?.kind === 'question' && fold.waiting.callId === callId) {
        fold.waiting = undefined
        if (fold.openTurn) fold.phase = 'running'
      }
      break
    }
    case 'todo/write': {
      fold.todos = normalizeTodos(data.todos)
      break
    }
    case 'job/registered': {
      const jobId = asString(data.jobId)
      if (jobId) {
        fold.jobs.set(jobId, {
          id: jobId,
          kind: asString(data.kind) ?? 'job',
          label: asString(data.label) ?? jobId,
          startedAt: asNumber(data.startedAt, time),
          finishedAt: undefined,
          status: 'running',
          detail: undefined,
        })
      }
      break
    }
    case 'job/settled': {
      const jobId = asString(data.jobId)
      if (jobId) {
        const previous = fold.jobs.get(jobId)
        fold.jobs.set(jobId, {
          id: jobId,
          kind: asString(data.kind) ?? previous?.kind ?? 'job',
          label: asString(data.label) ?? previous?.label ?? jobId,
          startedAt: asNumber(data.startedAt, previous?.startedAt ?? time),
          finishedAt: asNumber(data.finishedAt, time),
          status: asString(data.status) ?? 'settled',
          detail: asString(data.detail),
        })
      }
      break
    }
    case 'approval/asked': {
      const requestId = asString(data.requestId) ?? asString(data.id) ?? asString(data.approvalId) ?? `approval-${event.seq}`
      fold.approvals.set(requestId, { since: time, summary: approvalSummary(data) })
      setWaitingFromApprovals(fold, time)
      break
    }
    case 'approval/decided': {
      const requestId = asString(data.requestId) ?? asString(data.id) ?? asString(data.approvalId)
      if (requestId) {
        fold.approvals.delete(requestId)
      } else if (fold.approvals.size === 1) {
        fold.approvals.delete(fold.approvals.keys().next().value)
      }
      setWaitingFromApprovals(fold, time)
      if (!fold.waiting && fold.openTurn) fold.phase = 'running'
      break
    }
    case 'goal/change': {
      const goal = extractGoal(data.goal ?? data.current ?? data)
      if (goal) fold.goal = goal
      break
    }
    case 'session/title': {
      const title = asString(data.title) ?? asString(data.value) ?? asString(data.text)
      if (title) fold.title = title
      break
    }
    case 'model/selection': {
      const provider = asString(data.provider)
      const model = asString(data.model)
      if (provider && model) fold.model = { provider, model }
      break
    }
    default:
      break
  }

  if (!fold.title) fold.title = basename(fold.cwd)
  return fold
}

export function applySessionMeta(fold, meta) {
  if (!meta) return fold
  if (meta.cwd) fold.cwd = meta.cwd
  if (meta.parentId) {
    fold.origin = 'subagent'
    fold.parentId = meta.parentId
  }
  if (!fold.title) fold.title = basename(fold.cwd) || `会话 ${fold.id.slice(0, 12)}`
  return fold
}

function buildTodoProgress(todos) {
  if (!todos || todos.length === 0) return undefined
  const done = todos.filter((item) => item.status === 'completed').length
  const doing = todos.filter((item) => item.status === 'in_progress').length
  const current = todos.find((item) => item.status === 'in_progress')?.content
  const percent = Math.round(((done + doing * 0.5) / todos.length) * 100)
  return {
    items: todos,
    done,
    total: todos.length,
    current,
    progress: {
      kind: 'todos',
      percent: Math.max(0, Math.min(100, percent)),
      label: `${done}/${todos.length}${current ? ` · ${current}` : ''}`,
    },
  }
}

function fallbackProgress(fold, phase) {
  if (phase === 'completed') {
    return { kind: 'turn', percent: 100, label: '已完成' }
  }
  const pending = Object.keys(fold.stats.pendingCalls).length
  const step = fold.stats.openStep?.step ?? fold.turn.step
  if (step) {
    return {
      kind: 'steps',
      label: `第 ${step} 步${pending > 0 ? ` · ${pending} 个工具执行中` : ''}`,
    }
  }
  if (fold.turn.index > 0) {
    return { kind: 'turn', label: `第 ${fold.turn.index} 回合` }
  }
  return { kind: 'turn', label: '等待开始' }
}

function jobsSummary(fold, now) {
  const jobs = [...fold.jobs.values()]
  if (jobs.length === 0) return undefined
  const running = jobs.filter((job) => !job.finishedAt)
  const recent = jobs
    .slice()
    .sort((a, b) => (b.finishedAt ?? now) - (a.finishedAt ?? now))
    .slice(0, 5)
    .map((job) => ({
      id: job.id,
      kind: job.kind,
      label: job.label,
      elapsedMs: Math.max(0, (job.finishedAt ?? now) - job.startedAt),
    }))
  return { running: running.length, total: jobs.length, recent }
}

export function resolvePhase(fold) {
  if (fold.waiting) return 'waiting'
  if (fold.openTurn || fold.agentRunning) return 'running'
  return fold.phase
}

export function toSnapshot(fold, options = {}) {
  const now = options.now ?? Date.now()
  const phase = resolvePhase(fold)
  const todo = buildTodoProgress(fold.todos)
  const progress = todo?.progress ?? fallbackProgress(fold, phase)
  const jobs = jobsSummary(fold, now)
  const title = fold.title || basename(fold.cwd) || `会话 ${fold.id.slice(0, 12)}`

  if (!title && !fold.turn.index && !todo && !fold.waiting) return undefined
  if (phase === 'unknown' && !todo && !fold.waiting && !fold.turn.index) return undefined

  return {
    id: fold.id,
    sourceId: options.sourceId ?? 'plugin',
    title,
    cwd: fold.cwd || undefined,
    origin: fold.origin,
    parentId: fold.parentId,
    phase,
    phaseReason: fold.phaseReason ?? fold.lastTurnEnd?.kind,
    startedAt: fold.startedAt,
    updatedAt: fold.updatedAt || now,
    turn: fold.turn.index > 0 ? { index: fold.turn.index, step: fold.turn.step } : undefined,
    todos: todo
      ? {
          items: todo.items,
          done: todo.done,
          total: todo.total,
          current: todo.current,
        }
      : undefined,
    progress,
    jobs,
    waiting: fold.waiting
      ? { kind: fold.waiting.kind, since: fold.waiting.since, summary: fold.waiting.summary }
      : undefined,
    goal: fold.goal,
    model: fold.model,
    tokens: fold.tokens,
    lastEvent: fold.lastEvent,
  }
}

export function computeAggregate(tasks) {
  let running = 0
  let waiting = 0
  let failed = 0
  let worst = 'unknown'
  let worstRank = Number.POSITIVE_INFINITY
  for (const task of tasks) {
    if (task.phase === 'running') running += 1
    if (task.phase === 'waiting') waiting += 1
    if (task.phase === 'failed' || task.phase === 'interrupted') failed += 1
    const rank = PHASE_RANK[task.phase] ?? 8
    if (rank < worstRank) {
      worstRank = rank
      worst = task.phase
    }
  }
  return { total: tasks.length, running, waiting, failed, attention: waiting, worst }
}

export function sortTasks(tasks) {
  return tasks.slice().sort((a, b) => {
    const rank = (PHASE_RANK[a.phase] ?? 8) - (PHASE_RANK[b.phase] ?? 8)
    if (rank !== 0) return rank
    return b.updatedAt - a.updatedAt
  })
}
