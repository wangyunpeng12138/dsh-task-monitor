<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useMonitorState, openDsh } from '../composables/useMonitorState'
import { formatClock, sortTasks } from '../lib/format'
import TaskCard from '../components/TaskCard.vue'
import SettingsDialog from '../components/SettingsDialog.vue'

const { state, tasks, aggregate } = useMonitorState()

async function onHeaderPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  const target = event.target as HTMLElement | null
  if (target?.closest('[data-no-drag]')) return
  try {
    await getCurrentWindow().startDragging()
  } catch (error) {
    console.warn('[panel] startDragging failed', error)
  }
}

const now = ref(Date.now())
const settingsOpen = ref(false)
let timer: number | undefined
onMounted(() => {
  timer = window.setInterval(() => (now.value = Date.now()), 1000)
})
onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})

const ordered = computed(() => sortTasks(tasks.value))
const waiting = computed(() => ordered.value.filter((t) => t.phase === 'waiting'))
const running = computed(() =>
  ordered.value.filter((t) => t.phase === 'running' || t.phase === 'blocked' || t.phase === 'interrupted' || t.phase === 'stale'),
)
const failed = computed(() => ordered.value.filter((t) => t.phase === 'failed'))
const recent = computed(() =>
  ordered.value.filter((t) => t.phase === 'completed' || t.phase === 'aborted' || t.phase === 'unknown').slice(0, 8),
)

const sourceLabel = computed(() => {
  if (state.value.health.source === 'plugin') return '实时'
  if (state.value.health.source === 'file') return '兼容'
  return '离线'
})
const sourceClass = computed(() => `source-${state.value.health.source}`)
const updated = computed(() => formatClock(state.value.generatedAt))
const hasTasks = computed(() => tasks.value.length > 0)
const offline = computed(() => state.value.health.source === 'offline')

async function toBall() {
  await invoke('hide_panel_command')
}
async function hideToTray() {
  await invoke('hide_to_tray_command')
}
async function refresh() {
  await invoke('refresh_now')
}
</script>

<template>
  <div class="panel">
    <header class="panel-header" @pointerdown="onHeaderPointerDown" @dblclick="openDsh">
      <div class="brand">
        <span class="brand-mark" />
        <div class="brand-text">
          <strong>DSH 任务监控</strong>
          <span class="brand-sub" :class="sourceClass">● {{ sourceLabel }}</span>
        </div>
      </div>
      <div class="header-actions" data-no-drag>
        <button class="icon-btn" title="刷新" @click="refresh">⟳</button>
        <button class="icon-btn" title="设置" @click="settingsOpen = true">⚙</button>
        <button class="icon-btn" title="切换为悬浮球" @click="toBall">◎</button>
        <button class="icon-btn" title="隐藏到托盘" @click="hideToTray">✕</button>
      </div>
    </header>

    <div class="summary">
      <div class="summary-item is-running"><b>{{ aggregate.running }}</b><span>运行</span></div>
      <div class="summary-item is-waiting"><b>{{ aggregate.waiting }}</b><span>待介入</span></div>
      <div class="summary-item is-failed"><b>{{ aggregate.failed }}</b><span>失败</span></div>
      <div class="summary-item"><b>{{ aggregate.total }}</b><span>总数</span></div>
    </div>

    <div class="panel-body">
      <div v-if="!hasTasks" class="empty">
        <div class="empty-glyph">{{ offline ? '◌' : '✓' }}</div>
        <h3>{{ offline ? '等待 DSH' : '当前没有任务' }}</h3>
        <p v-if="offline">DSH 未启动，或本机没有可读取的会话数据。</p>
        <p v-else>在 DSH 中开始一个任务，这里会自动出现进度。</p>
        <button class="ghost-btn" @click="openDsh">打开 DSH</button>
      </div>

      <section v-if="waiting.length" class="group">
        <h4 class="group-title is-waiting">需介入 <span>{{ waiting.length }}</span></h4>
        <TaskCard v-for="task in waiting" :key="task.id" :task="task" :now="now" />
      </section>

      <section v-if="running.length" class="group">
        <h4 class="group-title is-running">运行中 <span>{{ running.length }}</span></h4>
        <TaskCard v-for="task in running" :key="task.id" :task="task" :now="now" />
      </section>

      <section v-if="failed.length" class="group">
        <h4 class="group-title is-failed">失败 <span>{{ failed.length }}</span></h4>
        <TaskCard v-for="task in failed" :key="task.id" :task="task" :now="now" />
      </section>

      <section v-if="recent.length" class="group">
        <h4 class="group-title">最近完成 <span>{{ recent.length }}</span></h4>
        <TaskCard v-for="task in recent" :key="task.id" :task="task" :now="now" compact />
      </section>
    </div>

    <footer class="panel-footer">
      <span class="footer-source" :class="sourceClass">
        {{ state.health.source === 'plugin' ? '插件实时通道' : state.health.source === 'file' ? '本地文件兼容模式' : '未连接' }}
      </span>
      <span class="footer-time">{{ updated }}</span>
      <span v-if="state.health.message" class="footer-message">{{ state.health.message }}</span>
    </footer>

    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>
