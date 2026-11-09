import {
  applyAgentStatus,
  applyEvent,
  applySessionMeta,
  computeAggregate,
  createFold,
  seedFold,
  sortTasks,
  toSnapshot,
} from './reducer.js'

/**
 * Owns the live fold for every Session the Host currently has loaded.
 * It never writes to DSH; it only reads services and events.
 */
export class MonitorStore {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.folds = new Map()
    this.disposers = []
    this.timer = undefined
    this.publisher = undefined
    this.seq = 0
    this.sourceId = `plugin-${process.pid}`
    this.lastPublished = 0
    this.lastTaskSignature = ''
  }

  start() {
    this.seedAll()
    const listen = (name, handler) => {
      this.disposers.push(this.ctx.on(name, handler, { global: true }))
    }
    listen('session/created', (session) => {
      this.seed(session)
      this.schedule()
    })
    listen('session/disposed', (session) => {
      this.folds.delete(session.id)
      this.schedule()
    })
    listen('session/event', (session, event) => this.onEvent(session, event))
    listen('agent/status', (payload) => this.onStatus(payload))

    return () => this.dispose()
  }

  setPublisher(publisher) {
    this.publisher = publisher
  }

  seedAll() {
    for (const session of this.ctx.sessions.list()) {
      this.seed(session)
    }
  }

  seed(session) {
    if (this.folds.has(session.id)) return this.folds.get(session.id)
    const fold = createFold(session.id)
    let values = {}
    let asOfSeq = 0
    try {
      const snapshot = this.ctx.sessionProjections.snapshot(session)
      values = snapshot?.values ?? {}
      asOfSeq = snapshot?.asOfSeq ?? 0
    } catch (error) {
      this.ctx.logger?.debug?.(`[task-monitor] projection seed failed for ${session.id}: ${String(error)}`)
    }
    const agent = this.ctx.agents?.get?.(session.id)
    const header = session.header ?? {}
    seedFold(fold, {
      values,
      status: agent?.status,
      cwd: header.cwd ?? session.cwd ?? values.workingDirectory,
      parentId: header.parentSessionId ?? session.parentSession,
      updatedAt: Date.now(),
    })
    applySessionMeta(fold, {
      cwd: header.cwd ?? session.cwd,
      parentId: header.parentSessionId ?? session.parentSession,
    })
    fold.asOfSeq = asOfSeq
    this.folds.set(session.id, fold)
    return fold
  }

  onEvent(session, event) {
    const fold = this.folds.get(session.id) ?? this.seed(session)
    if (!fold) return
    try {
      applyEvent(fold, event)
    } catch (error) {
      this.ctx.logger?.warn?.(`[task-monitor] event fold failed: ${String(error)}`)
    }
    this.schedule()
  }

  onStatus({ agent, status }) {
    if (!agent) return
    const fold = this.folds.get(agent.id) ?? this.seed(agent.session)
    if (!fold) return
    applyAgentStatus(fold, status)
    this.schedule()
  }

  schedule() {
    if (!this.publisher || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.publish()
    }, this.config.coalesceMs)
    this.timer.unref?.()
  }

  tasks(now = Date.now()) {
    const tasks = []
    for (const fold of this.folds.values()) {
      const snapshot = toSnapshot(fold, { sourceId: this.sourceId, now })
      if (snapshot) tasks.push(snapshot)
    }
    sortTasks(tasks)
    return tasks.slice(0, this.config.maxTasks)
  }

  publish() {
    if (!this.publisher) return
    const now = Date.now()
    const tasks = this.tasks(now)
    const signature = JSON.stringify(tasks)
    if (signature === this.lastTaskSignature) return
    this.lastTaskSignature = signature
    this.seq += 1
    this.lastPublished = now
    this.publisher({
      seq: this.seq,
      generatedAt: now,
      tasks,
      aggregate: computeAggregate(tasks),
    })
  }

  snapshot() {
    const now = Date.now()
    const tasks = this.tasks(now)
    return {
      schema: 1,
      generatedAt: now,
      dsh: {
        sourceId: this.sourceId,
        pid: process.pid,
        version: this.dshVersion(),
        profile: process.env.DSH_PROFILE ?? 'default',
        mode: 'plugin',
      },
      aggregate: computeAggregate(tasks),
      tasks,
      health: {
        source: 'plugin',
        lastSeq: this.seq,
        lastEventAt: this.lastPublished || undefined,
        latencyMs: 0,
      },
    }
  }

  dshVersion() {
    return process.env.DSH_VERSION ?? '0.2.2-rc.1'
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // A listener may already be gone during Host shutdown.
      }
    }
    this.folds.clear()
    this.publisher = undefined
  }
}
