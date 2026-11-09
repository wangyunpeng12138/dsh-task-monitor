import { createApp } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import BallView from './views/BallView.vue'
import PanelView from './views/PanelView.vue'
import './styles.css'

function label(): string {
  try {
    return getCurrentWindow().label
  } catch {
    return 'panel'
  }
}

const view = label() === 'ball' ? BallView : PanelView
createApp(view).mount('#app')
