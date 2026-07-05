import { contextBridge, ipcRenderer } from 'electron'

export interface AppearanceConfig {
  fontFamily: string
  fontSize: number
  lineHeight: number
}

const api = {
  saveMemo: (content: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('memo:save', content),
  getConfig: (): Promise<{ serverUrl: string; configured: boolean; source: string }> =>
    ipcRenderer.invoke('config:get'),
  setConfig: (serverUrl: string, token: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:set', serverUrl, token),
  hidePanel: (): void => ipcRenderer.send('panel:hide'),
  listTags: (): Promise<{ name: string; count: number }[]> => ipcRenderer.invoke('tags:list'),
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
  }
}

contextBridge.exposeInMainWorld('memoglass', api)

export type MemoglassApi = typeof api
