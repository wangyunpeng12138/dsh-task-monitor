import { onMounted, onUnmounted, ref } from 'vue'
import type { Ref } from 'vue'
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi'

export type BallEdge = 'left' | 'right' | 'top' | 'bottom'

/** Logical size of the free-floating ball. */
const BALL = 72
/** Logical thickness of the docked edge bar. */
const BAR = 8
/** Distance (physical px) to the work-area edge that triggers docking. */
const SNAP_MARGIN = 20
/** Distance (physical px) past which a docked ball is released back to ball mode. */
const RELEASE_MARGIN = 28
/** No window movement for this long (ms) means the drag has ended. */
const DRAG_IDLE_MS = 350

/**
 * Dock the ball to the nearest work-area edge after a drag.
 *
 * When docked, the window shrinks to a slim bar hugging the edge so it no
 * longer occludes content; hovering the bar expands it back to the full
 * ball (still flush with the edge), and dragging it away releases it.
 *
 * All window positions/sizes from Tauri are physical pixels, so the logical
 * ball/bar sizes are converted with the monitor scale factor before use.
 */
export function useBallSnap() {
  const edge: Ref<BallEdge | null> = ref(null)
  const hovered = ref(false)

  let unlisten: (() => void) | undefined
  let timer: number | undefined
  let dragIdle: number | undefined
  let collapseTimer: number | undefined
  /** True while we apply our own size/position changes; ignore echoed onMoved. */
  let applying = false
  /** True from pointer-down on the ball until the native drag ends. */
  let dragging = false
  /** Last position we set ourselves; echoed onMoved events land here and are ignored. */
  let lastX = Number.NaN
  let lastY = Number.NaN
  /** Timestamps to tell real pointer leaves from WebView2 synthetic ones. */
  let lastMoveAt = 0
  let expandedAt = 0

  async function readArea() {
    const monitor = await currentMonitor()
    if (!monitor) return undefined
    const areaPos = monitor.workArea?.position ?? monitor.position
    const areaSize = monitor.workArea?.size ?? monitor.size
    return {
      scale: monitor.scaleFactor ?? 1,
      left: areaPos.x,
      top: areaPos.y,
      width: areaSize.width,
      height: areaSize.height,
    }
  }

  function isVertical(value: BallEdge) {
    return value === 'left' || value === 'right'
  }

  function detectEdge(
    pos: { x: number; y: number },
    size: { width: number; height: number },
    area: { left: number; top: number; width: number; height: number },
  ): BallEdge | null {
    const dist = {
      left: pos.x - area.left,
      right: area.left + area.width - (pos.x + size.width),
      top: pos.y - area.top,
      bottom: area.top + area.height - (pos.y + size.height),
    }
    let best: BallEdge | null = null
    let bestDist = SNAP_MARGIN
    for (const key of ['left', 'right', 'top', 'bottom'] as const) {
      if (dist[key] < bestDist) {
        bestDist = dist[key]
        best = key
      }
    }
    if (best) return best
    // Hysteresis: a docked ball only releases once dragged clearly away.
    const current = edge.value
    if (current && dist[current] < RELEASE_MARGIN) return current
    return null
  }

  /**
   * Resize/reposition the window for the given docking state.
   * Free ball keeps its center; a docked ball is flush with its edge and
   * expands (hover) outward from that edge without moving along it.
   */
  async function apply(next: BallEdge | null) {
    if (applying) return
    applying = true
    try {
      const win = getCurrentWindow()
      const area = await readArea()
      if (!area) return
      const pos = await win.outerPosition()
      const size = await win.outerSize()
      const asBar = next !== null && !hovered.value
      const logicalW = asBar && isVertical(next) ? BAR : BALL
      const logicalH = asBar && !isVertical(next) ? BAR : BALL
      const w = Math.round(logicalW * area.scale)
      const h = Math.round(logicalH * area.scale)

      // Default: keep the window centered where it currently is.
      let x = pos.x + Math.round((size.width - w) / 2)
      let y = pos.y + Math.round((size.height - h) / 2)
      // Docked: flush against the work-area edge.
      if (next === 'left') x = area.left
      else if (next === 'right') x = area.left + area.width - w
      else if (next === 'top') y = area.top
      else if (next === 'bottom') y = area.top + area.height - h

      const target = new PhysicalPosition(Math.round(x), Math.round(y))
      if (size.width !== w || size.height !== h) {
        await win.setSize(new LogicalSize(logicalW, logicalH))
      }
      if (target.x !== pos.x || target.y !== pos.y) {
        await win.setPosition(target)
      }
      lastX = target.x
      lastY = target.y
      edge.value = next
    } catch (error) {
      console.warn('[snap] apply failed', error)
    } finally {
      applying = false
    }
  }

  /**
   * Snap (or release) the window once, after the drag has finished.
   * `force` (drag end) skips the echo guard: the ball is often dropped back
   * where a previous apply left it (e.g. re-docking the same edge), which
   * would otherwise be mistaken for an echoed onMoved and skipped.
   */
  async function snap(force = false) {
    if (applying || dragging) return
    try {
      applying = true
      const win = getCurrentWindow()
      const area = await readArea()
      if (!area) {
        applying = false
        return
      }
      const pos = await win.outerPosition()
      const size = await win.outerSize()
      // Ignore echoes of our own setPosition (e.g. hover expand/collapse).
      if (!force && Math.abs(pos.x - lastX) <= 1 && Math.abs(pos.y - lastY) <= 1) {
        applying = false
        return
      }
      const next = detectEdge(pos, size, area)
      // Docking or releasing after a real drag: drop the hover flag so the
      // ball collapses to a bar immediately instead of waiting for the
      // pointer to leave (the pointer usually sits on the ball mid-drag).
      if (force || next !== edge.value) hovered.value = false
      applying = false
      await apply(next)
    } catch (error) {
      applying = false
      console.warn('[snap] failed', error)
    }
  }

  /** Cursor moved over the window: any pending collapse is cancelled. */
  function notePointerMove() {
    lastMoveAt = Date.now()
    if (collapseTimer) {
      window.clearTimeout(collapseTimer)
      collapseTimer = undefined
    }
  }

  /** Expand (hover) / collapse (leave) a docked ball without moving its dock. */
  async function setHovered(value: boolean) {
    if (dragging || hovered.value === value || !edge.value) return
    if (value) {
      if (collapseTimer) {
        window.clearTimeout(collapseTimer)
        collapseTimer = undefined
      }
      hovered.value = true
      expandedAt = Date.now()
      await apply(edge.value)
      return
    }
    // WebView2 emits a synthetic pointerleave when the window resizes under
    // a stationary cursor, which would loop expand<->collapse. A leave right
    // after an expand with no cursor movement in between is synthetic.
    if (Date.now() - expandedAt < 500 && lastMoveAt < expandedAt) return
    if (collapseTimer) window.clearTimeout(collapseTimer)
    collapseTimer = window.setTimeout(async () => {
      collapseTimer = undefined
      if (dragging || hovered.value || !edge.value) return
      hovered.value = false
      await apply(edge.value)
    }, 150)
  }

  /**
   * Begin a native drag of the ball. While dragging, no snapping or bar
   * reshaping happens at all; snapping runs once after the drag ends.
   */
  async function startDrag() {
    dragging = true
    if (dragIdle) window.clearTimeout(dragIdle)
    // The pointer is on the ball for the whole drag: stay expanded.
    hovered.value = true
    try {
      await getCurrentWindow().startDragging()
    } catch (error) {
      dragging = false
      console.warn('[snap] startDragging failed', error)
    }
  }

  function endDrag() {
    if (!dragging) return
    dragging = false
    if (dragIdle) {
      window.clearTimeout(dragIdle)
      dragIdle = undefined
    }
    snap(true)
  }

  function onPointerUp() {
    // WebView2 delivers the pointerup once the native move loop exits;
    // fall back to the movement-idle timer if it never arrives.
    window.setTimeout(endDrag, 60)
  }

  onMounted(async () => {
    window.addEventListener('pointerup', onPointerUp)
    try {
      unlisten = await getCurrentWindow().onMoved(() => {
        if (applying) return
        if (dragging) {
          // Mid-drag: don't snap, just note that the drag is still alive.
          if (dragIdle) window.clearTimeout(dragIdle)
          dragIdle = window.setTimeout(endDrag, DRAG_IDLE_MS)
          return
        }
        if (timer) window.clearTimeout(timer)
        timer = window.setTimeout(snap, 250)
      })
    } catch (error) {
      console.warn('[snap] onMoved failed', error)
    }
  })

  onUnmounted(() => {
    if (timer) window.clearTimeout(timer)
    if (dragIdle) window.clearTimeout(dragIdle)
    if (collapseTimer) window.clearTimeout(collapseTimer)
    window.removeEventListener('pointerup', onPointerUp)
    unlisten?.()
  })

  return { edge, hovered, setHovered, notePointerMove, startDrag, snap }
}
