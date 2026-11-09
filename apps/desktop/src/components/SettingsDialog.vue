<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { AppSettings } from '../lib/settings'

const emit = defineEmits<{ close: [] }>()
const form = reactive<AppSettings>({
  dshHome: '',
  sourceMode: 'auto',
  staleMs: 90_000,
  maxTasks: 30,
  hideWhenIdle: false,
  notifications: true,
  hotkey: 'Ctrl+Alt+Shift+M',
})
const saving = ref(false)
const saved = ref(false)
const error = ref('')

onMounted(async () => {
  try {
    const current = await invoke<AppSettings>('get_settings')
    Object.assign(form, current)
  } catch (e) {
    error.value = String(e)
  }
})

async function save() {
  saving.value = true
  error.value = ''
  try {
    const next = await invoke<AppSettings>('set_settings', { settings: form })
    Object.assign(form, next)
    saved.value = true
    setTimeout(() => (saved.value = false), 1500)
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

function close() {
  emit('close')
}
</script>

<template>
  <div class="settings-mask" @click.self="close">
    <div class="settings">
      <header class="settings-head">
        <strong>设置</strong>
        <button class="icon-btn" data-no-drag @click="close">✕</button>
      </header>

      <div class="settings-body">
        <label class="field">
          <span>DSH Home</span>
          <input v-model="form.dshHome" placeholder="默认 %USERPROFILE%\.dsh" spellcheck="false" />
          <small>留空时自动读取 DSH_HOME 或用户目录下的 .dsh</small>
        </label>

        <label class="field">
          <span>数据源模式</span>
          <select v-model="form.sourceMode">
            <option value="auto">自动（插件优先，文件兜底）</option>
            <option value="plugin">仅插件桥</option>
            <option value="file">仅本地文件</option>
          </select>
        </label>

        <div class="field-row">
          <label class="field">
            <span>挂起阈值（毫秒）</span>
            <input v-model.number="form.staleMs" type="number" min="10000" step="5000" />
          </label>
          <label class="field">
            <span>最大任务数</span>
            <input v-model.number="form.maxTasks" type="number" min="5" max="100" />
          </label>
        </div>

        <label class="switch">
          <input v-model="form.hideWhenIdle" type="checkbox" />
          <span>空闲时隐藏悬浮球（托盘常驻）</span>
        </label>

        <label class="field">
          <span>全局热键</span>
          <input v-model="form.hotkey" spellcheck="false" />
          <small>修改后重启应用生效</small>
        </label>

        <p v-if="error" class="settings-error">{{ error }}</p>
      </div>

      <footer class="settings-foot">
        <span v-if="saved" class="saved">已保存</span>
        <button class="ghost-btn" data-no-drag @click="close">取消</button>
        <button class="primary-btn" data-no-drag :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </footer>
    </div>
  </div>
</template>
