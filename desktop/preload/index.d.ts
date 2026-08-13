import type { ClipApi } from '@shared/ipc'

declare global {
  interface Window {
    clip: ClipApi
  }
}

export {}
