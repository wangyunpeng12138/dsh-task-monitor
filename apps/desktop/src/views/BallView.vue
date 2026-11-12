<script setup lang="ts">
import { computed, nextTick, onMounted } from 'vue'
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi'
import { useMonitorState, openDsh, togglePanel } from '../composables/useMonitorState'
import { useBallSnap } from '../composables/useBallSnap'
import { PHASE_LABEL } from '../lib/format'
import type { TaskSnapshot } from '@dsh-monitor/protocol'

const { edge, hovered, setHovered, notePointerMove, startDrag } = useBallSnap()
const { state, tasks, aggregate } = useMonitorState()

onMounted(async () => {
  await nextTick()
  const win = getCurrentWindow()
  try {
    // WebView2 may create the transparent window wider than requested
    // (Windows' minimum tracking width). Force the logical size back to a
    // square before placing it, otherwise the ball renders as an ellipse.
    await win.setSize(new LogicalSize(72, 72))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const monitor = await currentMonitor()
    if (monitor) {
      const area = monitor.workArea ?? { position: monitor.position, size: monitor.size }
      const size = await win.outerSize()
      const x = area.position.x + area.size.width - size.width - 24
      const y = area.position.y + area.size.height - size.height - 120
      await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
    }
  } catch (error) {
    console.warn('[ball] initial placement failed', error)
  }
})

const primary = computed<TaskSnapshot | undefined>(() => {
  return (
    tasks.value.find((t) => t.phase === 'waiting') ??
    tasks.value.find((t) => t.phase === 'running') ??
    tasks.value[0]
  )
})

const status = computed(() => {
  if (state.value.health.source === 'offline' && aggregate.value.total === 0) return 'offline'
  if (aggregate.value.waiting > 0) return 'waiting'
  if (aggregate.value.running > 0) return 'running'
  if (aggregate.value.failed > 0) return 'failed'
  if (aggregate.value.total > 0) return 'idle'
  return 'empty'
})

const count = computed(() => {
  if (status.value === 'waiting') return aggregate.value.waiting
  if (status.value === 'running') return aggregate.value.running
  if (status.value === 'failed') return aggregate.value.failed
  return 0
})

/** True when the docked ball shows as a slim bar instead of the full ball. */
const isBar = computed(() => edge.value !== null && !hovered.value)

const palette = computed(() => {
  if (status.value === 'waiting') {
    return { color: '#f2b84b', track: 'rgba(242,184,75,.30)' }
  }
  if (status.value === 'failed') {
    return { color: '#f06a6a', track: 'rgba(240,106,106,.30)' }
  }
  if (status.value === 'offline') {
    return { color: '#64748b', track: 'rgba(100,116,139,.28)' }
  }
  return { color: '#4c9aff', track: 'rgba(76,154,255,.30)' }
})

const percent = computed(() => primary.value?.progress.percent)

const ring = computed(() => {
  const { color, track } = palette.value
  if (percent.value === undefined) {
    return { background: `conic-gradient(from 210deg, ${color}, ${track} 70%)` }
  }
  return {
    background: `conic-gradient(from 210deg, ${color} 0deg, ${color} ${percent.value * 3.6}deg, ${track} ${percent.value * 3.6}deg)`,
  }
})

const barTrack = computed(() => ({ background: palette.value.track }))

const barFill = computed(() => {
  const { color } = palette.value
  const style: Record<string, string> = { background: color }
  if (percent.value === undefined) return style
  const length = `${Math.max(0, Math.min(100, percent.value))}%`
  if (edge.value === 'left' || edge.value === 'right') style.height = length
  else style.width = length
  return style
})

const tooltip = computed(() => {
  if (status.value === 'offline') return 'DSH 未连接'
  if (!primary.value) return 'DSH 任务监控'
  const p = primary.value
  return `${p.title} · ${PHASE_LABEL[p.phase]}${p.progress.label ? ` · ${p.progress.label}` : ''}`
})

async function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  const target = event.target as HTMLElement | null
  if (target?.closest('.ball-action')) return
  await startDrag()
}

async function onClick() {
  await togglePanel()
}

async function onDoubleClick() {
  await openDsh()
}

function onContextMenu(event: MouseEvent) {
  event.preventDefault()
}
</script>

<template>
  <main
    class="ball"
    :class="[
      `is-${status}`,
      {
        'is-bar': isBar,
        'is-bar-v': isBar && (edge === 'left' || edge === 'right'),
        'is-bar-h': isBar && (edge === 'top' || edge === 'bottom'),
      },
    ]"
    :title="tooltip"
    @pointerenter="setHovered(true)"
    @pointerleave="setHovered(false)"
    @pointermove="notePointerMove"
    @pointerdown="onPointerDown"
    @contextmenu="onContextMenu"
  >
    <template v-if="isBar">
      <div class="ball-bar" :style="barTrack">
        <div class="ball-bar-fill" :class="{ indeterminate: percent === undefined }" :style="barFill" />
      </div>
    </template>
    <template v-else>
      <div class="ball-ring" :style="ring" />
      <div class="ball-inner ball-action" @click.stop="onClick" @dblclick.stop="onDoubleClick">
        <span v-if="count > 0" class="ball-count">{{ count }}</span>
        <span v-else class="ball-glyph">{{ status === 'offline' ? '—' : status === 'idle' ? '✓' : '·' }}</span>
        <span v-if="status === 'waiting'" class="ball-alert">!</span>
      </div>
      <span class="ball-tip">{{ status === 'offline' ? '离线' : status === 'waiting' ? '需介入' : status === 'running' ? '运行中' : status === 'failed' ? '失败' : '空闲' }}</span>
    </template>
  </main>
</template>
