import type { MemoglassApi } from './index'

declare global {
  interface Window {
    memoglass: MemoglassApi
  }
}

export {}
