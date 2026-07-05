import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  type NativeImage,
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
import { createMemo, listMemos, updateMemo, uploadAttachment, verifyCredentials } from './memos'
import { getTags, mergeSavedContent, scheduleBackgroundRefresh } from './tags'

const PANEL_W = 640
const PANEL_H = 320
const SHORTCUTS = ['Alt+Space', 'Control+Alt+Space'] // first that registers wins
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024 // 30MB per file

interface AttachmentUpload {
  filename: string
  mimeType: string
  dataB64: string
}

let panel: BrowserWindow | null = null
let tray: Tray | null = null
let settingsWindow: BrowserWindow | null = null
let activeShortcut = ''
// Pinned panels ignore the blur-to-dismiss behavior (Spotlight feel would
// otherwise close the switcher/editor the instant focus leaves the panel).
let isPinned = false

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
    if (isPinned) return // explicit pin overrides the click-away dismiss
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

// Hand-built 18x18 (+ 36x36 @2x) black-on-transparent "pencil" glyph PNG —
// see scripts/gen-tray-icon.mjs for the generator. A 1x1 transparent PNG
// plus setTitle() used to stand in here, but that renders as a fully blank,
// invisible tray item on recent macOS (especially with menu-bar managers
// like Ice); a real template image is what actually shows up.
const TRAY_ICON_18 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAJ0lEQVR42mNgGAW0BP8HhSH/qWnI/1FDqGfI/0FryMAHLlXzENkAAIxkI90Pdu+3AAAAAElFTkSuQmCC'
const TRAY_ICON_36 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAARklEQVR42u3WsQ0AIAzEwOy/tNkA0WGQLaW/4ovMVFXV9TBBdBhMEEwQHYYwGwxhwoQJ8xOGgwuj2AwvDTiQ8rfR/cSlbQH+4pZq1FWaGQAAAABJRU5ErkJggg=='

function createTrayIcon(): NativeImage {
  const image = nativeImage.createFromDataURL(TRAY_ICON_18)
  image.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_36 })
  image.setTemplateImage(true)
  return image
}

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
  tray = new Tray(createTrayIcon())
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
  ipcMain.handle(
    'memo:save',
    async (_e, payload: { content: string; attachments: AttachmentUpload[] }) => {
      const cfg = resolveConfig()
      if (cfg.source === 'none') return { ok: false, error: '未配置服务器' }

      const { content, attachments } = payload

      for (const file of attachments) {
        const bytes = Buffer.byteLength(file.dataB64, 'base64')
        if (bytes > MAX_ATTACHMENT_BYTES) {
          return { ok: false, error: `文件过大：${file.filename}` }
        }
      }

      const attachmentNames: string[] = []
      for (const file of attachments) {
        const uploaded = await uploadAttachment(cfg.serverUrl, cfg.token, file)
        if (!uploaded.ok || !uploaded.name) {
          return {
            ok: false,
            error: `附件上传失败（${file.filename}）：${uploaded.error ?? '未知错误'}`
          }
        }
        attachmentNames.push(uploaded.name)
      }

      const result = await createMemo(cfg.serverUrl, cfg.token, content, attachmentNames)
      if (result.ok) {
        mergeSavedContent(content)
        scheduleBackgroundRefresh(3000)
      }
      return result
    }
  )

  ipcMain.handle('tags:list', () => getTags())

  ipcMain.handle('memos:list', async () => {
    const cfg = resolveConfig()
    if (cfg.source === 'none') return { ok: false, error: '未配置服务器' }
    return listMemos(cfg.serverUrl, cfg.token)
  })

  ipcMain.handle('memo:update', async (_e, name: string, content: string) => {
    const cfg = resolveConfig()
    if (cfg.source === 'none') return { ok: false, error: '未配置服务器' }
    const result = await updateMemo(cfg.serverUrl, cfg.token, name, content)
    if (result.ok) {
      mergeSavedContent(content)
      scheduleBackgroundRefresh(3000)
    }
    return result
  })

  ipcMain.on('panel:setPinned', (_e, pinned: boolean) => {
    isPinned = pinned
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
  ipcMain.on('settings:open', () => {
    hidePanel()
    createSettingsWindow()
  })

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

    registerIpc()
    // Create the tray BEFORE flipping to accessory: switching the activation
    // policy (dock.hide) while a status item is being created can eat the
    // item permanently on macOS (known Electron quirk).
    createTray()
    createPanel()
    registerShortcut()
    scheduleBackgroundRefresh()

    setTimeout(() => {
      if (process.platform === 'darwin') app.dock?.hide() // accessory: no Dock icon, no Cmd-Tab
      // bounds with a real x/width = the system actually placed the icon
      const tb = tray?.getBounds()
      console.log(
        '[memoglass] tray after dock.hide — destroyed:',
        tray?.isDestroyed(),
        'bounds:',
        JSON.stringify(tb)
      )
      // Map the tray icon to a physical display so we can tell the user
      // exactly which screen's menu bar it landed on.
      for (const d of screen.getAllDisplays()) {
        const hit =
          tb &&
          tb.x >= d.bounds.x &&
          tb.x < d.bounds.x + d.bounds.width &&
          tb.y >= d.bounds.y - 40 &&
          tb.y < d.bounds.y + d.bounds.height
        console.log(
          `[memoglass] display ${d.id} bounds=${JSON.stringify(d.bounds)} internal=${d.internal}${hit ? '  <-- TRAY IS ON THIS SCREEN' : ''}`
        )
      }
    }, 600)

    console.log(
      '[memoglass] ready; shortcut =',
      activeShortcut || 'NONE',
      '| tray bounds:',
      JSON.stringify(tray?.getBounds())
    )
  })

  // Menu-bar app: never quit when windows are hidden/closed
  app.on('window-all-closed', () => {})

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
