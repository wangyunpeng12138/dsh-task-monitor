<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TaskSnapshot } from '@dsh-monitor/protocol'
import { basename, formatDuration, PHASE_COLOR, PHASE_LABEL, progressStyle, taskElapsed } from '../lib/format'

const props = defineProps<{
  task: TaskSnapshot
  now: number
  compact?: boolean
}>()

const expanded = ref(false)
const elapsed = computed(() => formatDuration(taskElapsed(props.task, props.now)))
const percent = computed(() => props.task.progress.percent)
const todos = computed(() => props.task.todos?.items ?? [])
const visibleTodos = computed(() => (expanded.value ? todos.value : todos.value.slice(0, 3)))
const hasDetail = computed(() => todos.value.length > 0 || (props.task.jobs?.recent.length ?? 0) > 0)

function toggle() {
  if (props.compact || !hasDetail.value) return
  expanded.value = !expanded.value
}
</script>

<template>
  <article class="task-card" :class="[`phase-${task.phase}`, { compact, expanded }]" @click="toggle">
    <div class="task-head">
      <span class="phase-dot" :style="{ backgroundColor: PHASE_COLOR[task.phase] }" />
      <span class="task-title" :title="task.title">{{ task.title || '未命名任务' }}</span>
      <span class="task-phase">{{ PHASE_LABEL[task.phase] }}</span>
      <span class="task-elapsed">{{ elapsed }}</span>
    </div>

    <div class="task-meta">
      <span class="task-cwd" :title="task.cwd">{{ basename(task.cwd) || '—' }}</span>
      <span v-if="task.origin === 'subagent'" class="tag">子代理</span>
      <span v-if="task.goal" class="tag tag-goal" :title="task.goal.objective">
        目标{{ task.goal.round ? ` · 第 ${task.goal.round} 轮` : '' }}
      </span>
      <span v-if="task.jobs?.running" class="tag tag-job">{{ task.jobs.running }} 个后台任务</span>
    </div>

    <div v-if="task.waiting" class="task-waiting">
      <span class="waiting-mark">⚠</span>
      <span class="waiting-text">{{ task.waiting.kind === 'approval' ? '等待审批' : '等待回答' }}：{{ task.waiting.summary || '请回到 DSH 处理' }}</span>
    </div>

    <div class="task-progress">
      <div class="progress-track" :class="{ indeterminate: percent === undefined }">
        <div class="progress-fill" :style="progressStyle(task)" />
      </div>
      <span class="progress-label">{{ task.progress.label }}</span>
      <span v-if="percent !== undefined" class="progress-percent">{{ percent }}%</span>
    </div>

    <div v-if="task.error" class="task-error">{{ task.error }}</div>

    <div v-if="expanded && todos.length" class="todo-list">
      <div v-for="(todo, index) in visibleTodos" :key="`${index}-${todo.content}`" class="todo-row" :class="`todo-${todo.status}`">
        <span class="todo-mark">{{ todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○' }}</span>
        <span class="todo-text">{{ todo.content }}</span>
      </div>
      <button v-if="todos.length > 3" class="link-btn" @click.stop="expanded = !expanded">
        {{ expanded ? '收起' : `展开全部 ${todos.length} 项` }}
      </button>
    </div>

    <div v-if="expanded && task.jobs?.recent.length" class="job-list">
      <div v-for="job in task.jobs.recent.slice(0, 4)" :key="job.id" class="job-row">
        <span class="job-kind">{{ job.kind }}</span>
        <span class="job-label" :title="job.label">{{ job.label }}</span>
        <span class="job-time">{{ formatDuration(job.elapsedMs) }}</span>
      </div>
    </div>
  </article>
</template>
