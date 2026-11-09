import { computed, onMounted, onUnmounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { emptyState, type MonitorState } from '@dsh-monitor/protocol'

/**
 * Reads the single MonitorState maintained by the Rust core.
 * Both windows share the same source of truth; no window polls DSH directly.
 */
export function useMonitorState() {
  const state = ref<MonitorState>(emptyState())
  const ready = ref(false)
  let unlisten: UnlistenFn | undefined

  onMounted(async () => {
    try {
      state.value = await invoke<MonitorState>('get_state')
      ready.value = true
    } catch (error) {
      console.warn('[monitor] get_state failed', error)
    }
    unlisten = await listen<MonitorState>('monitor://state', (event) => {
      state.value = event.payload
      ready.value = true
    })
  })

  onUnmounted(() => {
    unlisten?.()
  })

  const tasks = computed(() => state.value.tasks)
  const aggregate = computed(() => state.value.aggregate)

  return { state, tasks, aggregate, ready }
}

export async function togglePanel() {
  await invoke('toggle_panel_command')
}

export async function openDsh() {
  await invoke('open_dsh')
}
