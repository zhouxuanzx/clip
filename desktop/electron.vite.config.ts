import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(import.meta.dirname, 'shared')
const rendererSrc = resolve(import.meta.dirname, 'renderer/src')

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'main/index.ts') } },
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'preload/index.ts') } },
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    root: resolve(import.meta.dirname, 'renderer'),
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'renderer/index.html') } },
    resolve: { alias: { '@shared': shared, '@renderer': rendererSrc } },
    plugins: [react(), tailwindcss()]
  }
})
