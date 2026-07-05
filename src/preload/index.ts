import { contextBridge, ipcRenderer } from 'electron'

export interface AppearanceConfig {
  fontFamily: string
  fontSize: number
  lineHeight: number
}

export interface AttachmentUpload {
  filename: string
  mimeType: string
  dataB64: string
}

export interface SaveMemoPayload {
  content: string
  attachments: AttachmentUpload[]
}

export interface MemoListItem {
  name: string
  content: string
  updateTime: string
  tags?: string[]
  pinned?: boolean
}

export interface ListMemosResult {
  ok: boolean
  error?: string
  memos?: MemoListItem[]
}

export interface AppContext {
  appName: string
  bundleId: string
  browser?: { url: string; title: string }
}

const api = {
  saveMemo: (payload: SaveMemoPayload): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('memo:save', payload),
  getConfig: (): Promise<{ serverUrl: string; configured: boolean; source: string }> =>
    ipcRenderer.invoke('config:get'),
  setConfig: (serverUrl: string, token: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:set', serverUrl, token),
  hidePanel: (): void => ipcRenderer.send('panel:hide'),
  openSettings: (): void => ipcRenderer.send('settings:open'),
  listTags: (): Promise<{ name: string; count: number }[]> => ipcRenderer.invoke('tags:list'),
  listMemos: (): Promise<ListMemosResult> => ipcRenderer.invoke('memos:list'),
  updateMemo: (name: string, content: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('memo:update', name, content),
  setPinned: (pinned: boolean): void => ipcRenderer.send('panel:setPinned', pinned),
  onShown: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('panel:shown', listener)
    return () => ipcRenderer.removeListener('panel:shown', listener)
  },
  getAppearance: (): Promise<AppearanceConfig> => ipcRenderer.invoke('appearance:get'),
  setAppearance: (appearance: AppearanceConfig): Promise<AppearanceConfig> =>
    ipcRenderer.invoke('appearance:set', appearance),
  onAppearanceChanged: (cb: (appearance: AppearanceConfig) => void): (() => void) => {
    const listener = (_e: unknown, appearance: AppearanceConfig): void => cb(appearance)
    ipcRenderer.on('appearance:changed', listener)
    return () => ipcRenderer.removeListener('appearance:changed', listener)
  },
  onContextUpdate: (cb: (ctx: AppContext | null) => void): (() => void) => {
    const listener = (_e: unknown, ctx: AppContext | null): void => cb(ctx)
    ipcRenderer.on('context:update', listener)
    return () => ipcRenderer.removeListener('context:update', listener)
  }
}

contextBridge.exposeInMainWorld('memoglass', api)

export type MemoglassApi = typeof api
