import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage, screen, Tray } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import { join } from 'path'
import { resolveConfig, saveConfig } from './config'
import { createMemo, verifyCredentials } from './memos'

const PANEL_W = 640
const PANEL_H = 320
const SHORTCUTS = ['Alt+Space', 'Control+Alt+Space'] // first that registers wins

let panel: BrowserWindow | null = null
let tray: Tray | null = null
let activeShortcut = ''

// ---------- panel ----------

function createPanel(): void {
  panel = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    type: 'panel', // NSPanel: shows without activating our app (Spotlight feel)
    frame: false,
    show: false,
    vibrancy: 'hud',
    visualEffectState: 'active', // keep the glass alive even when unfocused
    roundedCorners: true,
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  panel.setAlwaysOnTop(true, 'screen-saver')
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Spotlight behavior: click elsewhere -> dismiss
  panel.on('blur', () => {
    if (panel?.webContents.isDevToolsOpened()) return
    hidePanel()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    panel.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    panel.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function positionOnActiveScreen(): void {
  if (!panel) return
  const cursor = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  panel.setBounds({
    x: Math.round(workArea.x + (workArea.width - PANEL_W) / 2),
    y: Math.round(workArea.y + workArea.height * 0.22),
    width: PANEL_W,
    height: PANEL_H
  })
}

function showPanel(): void {
  if (!panel) return
  positionOnActiveScreen()
  panel.show() // panel type -> does not activate the app
  panel.webContents.send('panel:shown')
}

function hidePanel(): void {
  panel?.hide()
}

function togglePanel(): void {
  if (panel?.isVisible()) hidePanel()
  else showPanel()
}

// ---------- tray ----------

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('✎') // text-only menu bar item; proper template icon later
  tray.setToolTip('memoglass')
  tray.on('click', togglePanel)
}

// ---------- shortcut ----------

function registerShortcut(): void {
  for (const acc of SHORTCUTS) {
    try {
      if (globalShortcut.register(acc, togglePanel)) {
        activeShortcut = acc
        console.log(`[memoglass] global shortcut: ${acc}`)
        return
      }
    } catch {
      // try next
    }
  }
  console.warn('[memoglass] no global shortcut could be registered')
}

// ---------- ipc ----------

function registerIpc(): void {
  ipcMain.handle('memo:save', async (_e, content: string) => {
    const cfg = resolveConfig()
    if (cfg.source === 'none') return { ok: false, error: '未配置服务器' }
    return createMemo(cfg.serverUrl, cfg.token, content)
  })

  ipcMain.handle('config:get', () => {
    const cfg = resolveConfig()
    return { serverUrl: cfg.serverUrl, configured: cfg.source !== 'none', source: cfg.source }
  })

  ipcMain.handle('config:set', async (_e, serverUrl: string, token: string) => {
    const check = await verifyCredentials(serverUrl, token)
    if (!check.ok) return check
    saveConfig(serverUrl, token)
    return { ok: true }
  })

  ipcMain.on('panel:hide', hidePanel)
}

// ---------- lifecycle ----------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showPanel)

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('dev.zhijie.memoglass')
    if (process.platform === 'darwin') app.dock?.hide() // accessory: no Dock icon, no Cmd-Tab

    registerIpc()
    createPanel()
    createTray()
    registerShortcut()
    console.log('[memoglass] ready; shortcut =', activeShortcut || 'NONE')
  })

  // Menu-bar app: never quit when windows are hidden/closed
  app.on('window-all-closed', () => {})

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
