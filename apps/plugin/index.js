import { BridgeServer } from './lib/bridge.js'
import { MonitorStore } from './lib/store.js'

export const name = 'dsh-task-monitor-bridge'
export const inject = ['sessions', 'agents', 'sessionProjections']

function normalizeConfig(config) {
  const port = Number(config?.port)
  const coalesceMs = Number(config?.coalesceMs)
  const maxTasks = Number(config?.maxTasks)
  return {
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0,
    coalesceMs: Number.isFinite(coalesceMs) ? Math.min(1000, Math.max(50, coalesceMs)) : 150,
    maxTasks: Number.isFinite(maxTasks) ? Math.min(100, Math.max(1, maxTasks)) : 30,
  }
}

/**
 * Host half of the DSH task monitor.
 *
 * It folds the Host's session events into task snapshots and publishes them on
 * a loopback SSE endpoint. It never writes to Sessions, never adds event types
 * and never persists monitor state.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const store = new MonitorStore(ctx, config)
  const bridge = new BridgeServer(ctx, config, store)

  ctx.effect(() => store.start())
  ctx.effect(() => {
    bridge.start().catch((error) => {
      ctx.logger?.warn?.(`[task-monitor] bridge failed to start: ${String(error)}`)
    })
    return () => {
      bridge.dispose().catch(() => {})
    }
  })

  ctx.logger?.info?.(
    `[task-monitor] plugin loaded (coalesce=${config.coalesceMs}ms, maxTasks=${config.maxTasks})`,
  )
}
