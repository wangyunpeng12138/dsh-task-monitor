export interface AppSettings {
  dshHome: string
  sourceMode: 'auto' | 'plugin' | 'file'
  staleMs: number
  maxTasks: number
  hideWhenIdle: boolean
  notifications: boolean
  hotkey: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  dshHome: '',
  sourceMode: 'auto',
  staleMs: 90_000,
  maxTasks: 30,
  hideWhenIdle: false,
  notifications: true,
  hotkey: 'Ctrl+Alt+Shift+M',
}
