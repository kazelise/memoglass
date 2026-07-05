import { contextBridge, ipcRenderer } from 'electron'

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
  }
}

contextBridge.exposeInMainWorld('memoglass', api)

export type MemoglassApi = typeof api
