import { onMounted, onUnmounted } from 'vue'
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalPosition } from '@tauri-apps/api/dpi'

/**
 * Snap the window to the nearest work-area edge after a drag.
 * All values are physical pixels: Tauri window positions and monitor
 * work areas both use physical pixels, so no DPI conversion is applied.
 */
export function useBallSnap(margin = 12) {
  let unlisten: (() => void) | undefined
  let timer: number | undefined

  async function snap() {
    try {
      const win = getCurrentWindow()
      const pos = await win.outerPosition()
      const size = await win.outerSize()
      const monitor = await currentMonitor()
      if (!monitor) return
      const areaPos = monitor.workArea?.position ?? monitor.position
      const areaSize = monitor.workArea?.size ?? monitor.size
      const left = areaPos.x
      const top = areaPos.y
      const right = left + areaSize.width
      const bottom = top + areaSize.height

      let x = pos.x
      let y = pos.y
      if (x <= left + margin) x = left
      else if (x + size.width >= right - margin) x = right - size.width
      if (y <= top + margin) y = top
      else if (y + size.height >= bottom - margin) y = bottom - size.height

      if (x !== pos.x || y !== pos.y) {
        await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
      }
    } catch (error) {
      console.warn('[snap] failed', error)
    }
  }

  onMounted(async () => {
    try {
      unlisten = await getCurrentWindow().onMoved(() => {
        if (timer) window.clearTimeout(timer)
        timer = window.setTimeout(snap, 300)
      })
    } catch (error) {
      console.warn('[snap] onMoved failed', error)
    }
  })

  onUnmounted(() => {
    if (timer) window.clearTimeout(timer)
    unlisten?.()
  })

  return { snap }
}
