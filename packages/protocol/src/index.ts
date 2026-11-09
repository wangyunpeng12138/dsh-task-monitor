/**
 * Wire protocol shared by the DSH bridge plugin and the monitor app.
 *
 * Keep this file dependency-free: the bridge plugin is plain ESM and may be
 * loaded by the DSH host without a build step, while the Tauri frontend
 * imports the same types through the workspace.
 */

export const PROTOCOL_VERSION = 1

export type Phase =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'interrupted'
  | 'blocked'
  | 'stale'
  | 'unknown'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

export interface TaskSnapshot {
  /** Session id, stable for the lifetime of the task. */
  id: string
  /** Discovery source id; the app merges sources by this + id. */
  sourceId: string
  title: string
  cwd?: string
  workspace?: string
  origin: 'user' | 'subagent'
  parentId?: string
  phase: Phase
  phaseReason?: string
  startedAt?: number
  updatedAt: number
  turn?: {
    index: number
    step?: number
  }
  todos?: {
    items: TodoItem[]
    done: number
    total: number
    current?: string
  }
  progress: {
    kind: 'todos' | 'steps' | 'turn'
    percent?: number
    label: string
  }
  jobs?: {
    running: number
    total: number
    recent: Array<{
      id: string
      kind: string
      label: string
      elapsedMs: number
    }>
  }
  waiting?: {
    kind: 'approval' | 'question'
    since: number
    summary: string
  }
  goal?: {
    objective?: string
    phase?: 'active' | 'paused' | 'blocked' | 'complete'
    round?: number
    maxRounds?: number
  }
  model?: {
    provider: string
    model: string
  }
  tokens?: {
    contextPressure?: number
    outputTokens?: number
  }
  error?: string
  lastEvent?: {
    type: string
    seq: number
    time: number
  }
}

export interface Aggregate {
  total: number
  running: number
  waiting: number
  failed: number
  attention: number
  worst: Phase
}

export interface DshInfo {
  sourceId: string
  pid: number
  version: string
  profile: string
  mode: 'plugin' | 'file'
}

export interface MonitorState {
  schema: 1
  generatedAt: number
  dsh?: DshInfo
  aggregate: Aggregate
  tasks: TaskSnapshot[]
  health: {
    source: 'plugin' | 'file' | 'offline'
    lastSeq: number
    lastEventAt?: number
    latencyMs?: number
    message?: string
  }
}

export interface PatchFrame {
  seq: number
  upserts: TaskSnapshot[]
  removed: string[]
  aggregate: Aggregate
}

export interface SnapshotFrame {
  schema: 1
  generatedAt: number
  tasks: TaskSnapshot[]
  aggregate: Aggregate
  health: MonitorState['health']
  dsh?: DshInfo
}

export interface BridgeDiscovery {
  protocol: number
  pid: number
  profile: string
  dshVersion: string
  url: string
  token: string
  startedAt: number
}

export const EMPTY_AGGREGATE: Aggregate = {
  total: 0,
  running: 0,
  waiting: 0,
  failed: 0,
  attention: 0,
  worst: 'unknown',
}

export function emptyState(): MonitorState {
  return {
    schema: 1,
    generatedAt: Date.now(),
    aggregate: EMPTY_AGGREGATE,
    tasks: [],
    health: { source: 'offline', lastSeq: 0 },
  }
}

export function phaseRank(phase: Phase): number {
  switch (phase) {
    case 'waiting':
      return 0
    case 'failed':
      return 1
    case 'running':
      return 2
    case 'blocked':
      return 3
    case 'interrupted':
      return 4
    case 'stale':
      return 5
    case 'completed':
      return 6
    default:
      return 7
  }
}

export function aggregateTasks(tasks: TaskSnapshot[]): Aggregate {
  let running = 0
  let waiting = 0
  let failed = 0
  let worst: Phase = 'unknown'
  let worstRank = Number.POSITIVE_INFINITY
  for (const task of tasks) {
    if (task.phase === 'running') running += 1
    if (task.phase === 'waiting') waiting += 1
    if (task.phase === 'failed' || task.phase === 'interrupted') failed += 1
    const rank = phaseRank(task.phase)
    if (rank < worstRank) {
      worstRank = rank
      worst = task.phase
    }
  }
  return {
    total: tasks.length,
    running,
    waiting,
    failed,
    attention: waiting,
    worst,
  }
}
