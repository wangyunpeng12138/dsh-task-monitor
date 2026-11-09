import type { Phase, TaskSnapshot } from '@dsh-monitor/protocol'

export const PHASE_LABEL: Record<Phase, string> = {
  running: '运行中',
  waiting: '需介入',
  completed: '已完成',
  failed: '失败',
  aborted: '已终止',
  interrupted: '已中断',
  blocked: '被阻断',
  stale: '疑似挂起',
  unknown: '未知',
}

export const PHASE_COLOR: Record<Phase, string> = {
  running: '#4c9aff',
  waiting: '#f2b84b',
  completed: '#43c98b',
  failed: '#f06a6a',
  aborted: '#c084fc',
  interrupted: '#f59e0b',
  blocked: '#fb923c',
  stale: '#94a3b8',
  unknown: '#64748b',
}

export function basename(path?: string): string {
  if (!path) return ''
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/)
  return parts[parts.length - 1] || normalized
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const total = Math.floor(ms / 1000)
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

export function formatClock(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

export function taskElapsed(task: TaskSnapshot, now = Date.now()): number {
  const start = task.startedAt ?? task.updatedAt
  if (task.phase === 'completed' || task.phase === 'failed' || task.phase === 'aborted') {
    return Math.max(0, task.updatedAt - start)
  }
  return Math.max(0, now - start)
}

export function sortTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
  const rank: Record<Phase, number> = {
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
  return [...tasks].sort((a, b) => {
    const r = rank[a.phase] - rank[b.phase]
    if (r !== 0) return r
    return b.updatedAt - a.updatedAt
  })
}

export function progressStyle(task: TaskSnapshot): Record<string, string> {
  const percent = task.progress.percent
  if (percent === undefined) return {}
  return { width: `${Math.max(2, Math.min(100, percent))}%` }
}
