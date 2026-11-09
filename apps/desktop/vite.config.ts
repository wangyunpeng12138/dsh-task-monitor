import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Tauri expects a fixed dev port and does not want clearScreen noise.
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'chrome105',
    minify: 'esbuild',
    sourcemap: true,
  },
})
