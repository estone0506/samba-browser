import type { SambaApi } from '../../../preload/renderer'

declare global {
  interface Window {
    samba: SambaApi
  }
}

export {}
