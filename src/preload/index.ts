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

export interface MemoAttachment {
  name: string // "attachments/xxx"
  filename: string
  type: string
  size: number
}

export interface MemoListItem {
  name: string
  content: string
  updateTime: string
  tags?: string[]
  pinned?: boolean
  attachments?: MemoAttachment[]
}

export interface UpdateMemoPayload {
  keepAttachmentNames: string[]
  newAttachments: AttachmentUpload[]
}

export interface FetchAttachmentResult {
  ok: boolean
  dataUrl?: string
  error?: string
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
  saveMemo: (
    payload: SaveMemoPayload
  ): Promise<{ ok: boolean; error?: string; queued?: boolean; pendingCount?: number }> =>
    ipcRenderer.invoke('memo:save', payload),
  getConfig: (): Promise<{ serverUrl: string; configured: boolean; source: string }> =>
    ipcRenderer.invoke('config:get'),
  setConfig: (serverUrl: string, token: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:set', serverUrl, token),
  setServerUrl: (serverUrl: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:setServerUrl', serverUrl),
  onConfigChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('config:changed', listener)
    return () => ipcRenderer.removeListener('config:changed', listener)
  },
  getShortcut: (): Promise<{ accelerator: string; isCustom: boolean }> =>
    ipcRenderer.invoke('shortcut:get'),
  setShortcut: (accelerator: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shortcut:set', accelerator),
  hidePanel: (): void => ipcRenderer.send('panel:hide'),
  openSettings: (): void => ipcRenderer.send('settings:open'),
  listTags: (): Promise<{ name: string; count: number }[]> => ipcRenderer.invoke('tags:list'),
  listMemos: (): Promise<ListMemosResult> => ipcRenderer.invoke('memos:list'),
  updateMemo: (
    name: string,
    content: string,
    payload: UpdateMemoPayload
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('memo:update', name, content, payload),
  fetchAttachment: (name: string, filename: string): Promise<FetchAttachmentResult> =>
    ipcRenderer.invoke('attachment:fetch', name, filename),
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
  },
  getQueueCount: (): Promise<number> => ipcRenderer.invoke('queue:count'),
  flushQueue: (): Promise<number> => ipcRenderer.invoke('queue:flush'),
  onQueueChanged: (cb: (count: number) => void): (() => void) => {
    const listener = (_e: unknown, payload: { count: number }): void => cb(payload.count)
    ipcRenderer.on('queue:changed', listener)
    return () => ipcRenderer.removeListener('queue:changed', listener)
  },
  onQueueItemFailed: (cb: (error: string) => void): (() => void) => {
    const listener = (_e: unknown, payload: { error: string }): void => cb(payload.error)
    ipcRenderer.on('queue:item-failed', listener)
    return () => ipcRenderer.removeListener('queue:item-failed', listener)
  }
}

contextBridge.exposeInMainWorld('memoglass', api)

export type MemoglassApi = typeof api
