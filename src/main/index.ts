import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray
} from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import { join } from 'path'
import {
  type AppearanceConfig,
  getAppearance,
  resolveConfig,
  saveConfig,
  setAppearance
} from './config'
import { createMemo, verifyCredentials } from './memos'
import { getTags, mergeSavedContent, scheduleBackgroundRefresh } from './tags'

const PANEL_W = 640
const PANEL_H = 320
const SHORTCUTS = ['Alt+Space', 'Control+Alt+Space'] // first that registers wins

let panel: BrowserWindow | null = null
let tray: Tray | null = null
let settingsWindow: BrowserWindow | null = null
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

// ---------- settings window ----------

function createSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.show()
    settingsWindow.focus()
    app.focus({ steal: true })
    return
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 340,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/settings`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'settings' })
  }

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show()
    app.focus({ steal: true }) // accessory app: menu-bar clicks don't activate us
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

// ---------- tray ----------

// Vibrancy materials for live A/B testing via the tray menu; the winner gets
// hard-coded once picked.
const MATERIALS = ['hud', 'popover', 'under-window', 'sidebar', 'menu', 'window'] as const
let currentMaterial: (typeof MATERIALS)[number] = 'hud'

// 1x1 transparent PNG: nativeImage.createEmpty() renders as a fully blank
// (invisible, unclickable-looking) tray item on recent macOS. A real,
// non-empty image keeps the item alive so setTitle's text actually shows.
const TRAY_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
)

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '打开 memoglass', click: showPanel },
    { type: 'separator' },
    { label: '设置…', click: createSettingsWindow },
    { type: 'separator' },
    {
      label: `玻璃材质（当前 ${currentMaterial}）`,
      submenu: MATERIALS.map((m) => ({
        label: m,
        type: 'radio' as const,
        checked: m === currentMaterial,
        click: (): void => {
          currentMaterial = m
          panel?.setVibrancy(m)
          showPanel()
        }
      }))
    },
    { type: 'separator' },
    { label: '退出', role: 'quit' }
  ])
}

function createTray(): void {
  tray = new Tray(TRAY_ICON)
  tray.setTitle('✎')
  tray.setToolTip('memoglass')
  tray.on('click', togglePanel)
  tray.on('right-click', () => tray?.popUpContextMenu(trayMenu()))
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
    const result = await createMemo(cfg.serverUrl, cfg.token, content)
    if (result.ok) {
      mergeSavedContent(content)
      scheduleBackgroundRefresh(3000)
    }
    return result
  })

  ipcMain.handle('tags:list', () => getTags())

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

  ipcMain.handle('appearance:get', () => getAppearance())

  ipcMain.handle('appearance:set', (_e, appearance: AppearanceConfig) => {
    setAppearance(appearance)
    panel?.webContents.send('appearance:changed', appearance)
    return appearance
  })
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
    scheduleBackgroundRefresh()
    console.log('[memoglass] ready; shortcut =', activeShortcut || 'NONE')
  })

  // Menu-bar app: never quit when windows are hidden/closed
  app.on('window-all-closed', () => {})

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
