import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  type NativeImage,
  screen,
  shell,
  Tray
} from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import { join } from 'path'
import {
  type AppearanceConfig,
  getAppearance,
  getPanelSize,
  getShortcut,
  resolveConfig,
  saveConfig,
  setAppearance,
  setPanelSize,
  setShortcut,
  updateServerUrl
} from './config'
import { captureContext } from './context'
import {
  createComment,
  createMemo,
  fetchAttachmentData,
  getMemo,
  listComments,
  listMemos,
  updateMemo,
  updateMemoWithAttachments,
  uploadAttachment,
  verifyCredentials
} from './memos'
import {
  closeAllStickers,
  closeStickerByWebContents,
  hasOpenStickers,
  openSticker,
  restoreStickers
} from './stickers'
import {
  enqueue,
  flushQueue,
  getQueueCount,
  setQueueListeners,
  startAutoRetry,
  type QueuedAttachment
} from './queue'
import { getTags, mergeSavedContent, scheduleBackgroundRefresh } from './tags'

const MIN_PANEL_W = 480
const MIN_PANEL_H = 240
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
  const { width, height } = getPanelSize()
  panel = new BrowserWindow({
    width,
    height,
    type: 'panel', // NSPanel: shows without activating our app (Spotlight feel)
    frame: false,
    show: false,
    vibrancy: 'hud',
    visualEffectState: 'active', // keep the glass alive even when unfocused
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    minWidth: MIN_PANEL_W,
    minHeight: MIN_PANEL_H,
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

  // Persist user resizes so the next show (even a fresh app launch) keeps
  // the chosen size. 'resized' only fires for manual/user-driven resizes on
  // macOS (setBounds/setSize from code doesn't trigger it unless animated),
  // so this never fights with positionOnActiveScreen()'s own setBounds call.
  panel.on('resized', () => {
    if (!panel) return
    const { width: w, height: h } = panel.getBounds()
    setPanelSize({ width: w, height: h })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    panel.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    panel.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function positionOnActiveScreen(): void {
  if (!panel) return
  const { width, height } = getPanelSize()
  const cursor = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  panel.setBounds({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height * 0.22),
    width,
    height
  })
}

function showPanel(): void {
  if (!panel) return
  positionOnActiveScreen()
  panel.show() // panel type -> does not activate the app
  panel.webContents.send('panel:shown')
  // Non-blocking: the panel opens immediately, context arrives a beat later.
  // Frontmost app is captured *now* because the panel is a nonactivating
  // NSPanel — the real app the user was using is still frontmost.
  captureContext().then((ctx) => {
    panel?.webContents.send('context:update', ctx)
  })
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
    height: 420,
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
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: '打开 memoglass', click: showPanel },
    { type: 'separator' },
    { label: '设置…', click: createSettingsWindow },
    {
      label: '关闭所有便签',
      enabled: hasOpenStickers(),
      click: closeAllStickers
    },
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
    }
  ]

  // Only meaningful in a packaged app — in dev mode this would point macOS
  // at the bare `electron` binary, which is useless as a login item.
  if (app.isPackaged) {
    template.push(
      { type: 'separator' },
      {
        label: '登录时启动',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (menuItem): void => {
          app.setLoginItemSettings({ openAtLogin: menuItem.checked })
        }
      }
    )
  }

  template.push({ type: 'separator' }, { label: '退出', role: 'quit' })

  return Menu.buildFromTemplate(template)
}

function createTray(): void {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('memoglass')
  tray.on('click', togglePanel)
  tray.on('right-click', () => tray?.popUpContextMenu(trayMenu()))
}

// ---------- shortcut ----------

function registerShortcut(): void {
  const custom = getShortcut()
  // A user-configured shortcut is tried first; if it's since been claimed by
  // another app (or is simply unset), we fall back to the built-in defaults.
  const candidates = custom ? [custom, ...SHORTCUTS.filter((s) => s !== custom)] : SHORTCUTS
  for (const acc of candidates) {
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

/** Attempts to swap the active global shortcut for `accelerator`. Rolls
 *  back to the previous shortcut if the new one can't be registered (e.g.
 *  claimed by another app), so the panel never ends up with zero shortcut. */
function applyShortcut(accelerator: string): { ok: boolean; error?: string } {
  const previous = activeShortcut
  if (previous) globalShortcut.unregister(previous)
  let registered = false
  try {
    registered = globalShortcut.register(accelerator, togglePanel)
  } catch {
    registered = false
  }
  if (!registered) {
    if (previous) {
      try {
        globalShortcut.register(previous, togglePanel)
      } catch {
        // best-effort rollback
      }
    }
    return { ok: false, error: '快捷键被占用' }
  }
  activeShortcut = accelerator
  setShortcut(accelerator)
  return { ok: true }
}

function broadcastConfigChanged(): void {
  panel?.webContents.send('config:changed')
  scheduleBackgroundRefresh(500)
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
          if (uploaded.networkError) {
            const pendingCount = enqueue(content, attachments as QueuedAttachment[])
            return { ok: true, queued: true, pendingCount }
          }
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
        return result
      }
      if (result.networkError) {
        const pendingCount = enqueue(content, attachments as QueuedAttachment[])
        return { ok: true, queued: true, pendingCount }
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

  ipcMain.handle(
    'memo:update',
    async (
      _e,
      name: string,
      content: string,
      payload: { keepAttachmentNames: string[]; newAttachments: AttachmentUpload[] }
    ) => {
      const cfg = resolveConfig()
      if (cfg.source === 'none') return { ok: false, error: '未配置服务器' }

      const { keepAttachmentNames, newAttachments } = payload

      for (const file of newAttachments) {
        const bytes = Buffer.byteLength(file.dataB64, 'base64')
        if (bytes > MAX_ATTACHMENT_BYTES) {
          return { ok: false, error: `文件过大：${file.filename}` }
        }
      }

      const uploadedNames: string[] = []
      for (const file of newAttachments) {
        const uploaded = await uploadAttachment(cfg.serverUrl, cfg.token, file)
        if (!uploaded.ok || !uploaded.name) {
          // Editing an existing memo never queues offline — unlike the
          // create path there's no local "draft" concept to fall back to,
          // and silently pretending success would desync the editor state
          // from what the server actually has.
          return {
            ok: false,
            error: `附件上传失败（${file.filename}）：${uploaded.error ?? '未知错误'}`
          }
        }
        uploadedNames.push(uploaded.name)
      }

      const allAttachmentNames = [...keepAttachmentNames, ...uploadedNames]
      const result = await updateMemoWithAttachments(
        cfg.serverUrl,
        cfg.token,
        name,
        content,
        allAttachmentNames
      )
      if (result.ok) {
        mergeSavedContent(content)
        scheduleBackgroundRefresh(3000)
      }
      return result
    }
  )

  ipcMain.handle('attachment:fetch', async (_e, name: string, filename: string) => {
    const cfg = resolveConfig()
    if (cfg.source === 'none') return { ok: false, error: '未配置服务器' }
    return fetchAttachmentData(cfg.serverUrl, cfg.token, name, filename)
  })

  ipcMain.handle('comments:list', async (_e, memoName: string) => {
    const cfg = resolveConfig()
    if (cfg.source === 'none') return { ok: false, error: '未配置服务器' }
    return listComments(cfg.serverUrl, cfg.token, memoName)
  })

  ipcMain.handle('comments:add', async (_e, memoName: string, content: string) => {
    const cfg = resolveConfig()
    if (cfg.source === 'none') return { ok: false, error: '未配置服务器' }
    return createComment(cfg.serverUrl, cfg.token, memoName, content)
  })

  ipcMain.on('panel:setPinned', (_e, pinned: boolean) => {
    isPinned = pinned
  })

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('config:get', () => {
    const cfg = resolveConfig()
    return { serverUrl: cfg.serverUrl, configured: cfg.source !== 'none', source: cfg.source }
  })

  ipcMain.handle('config:set', async (_e, serverUrl: string, token: string) => {
    const check = await verifyCredentials(serverUrl, token)
    if (!check.ok) return check
    saveConfig(serverUrl, token)
    broadcastConfigChanged()
    return { ok: true }
  })

  // Token-preserving URL edit: verifies the new URL against the already-
  // stored token so the user isn't forced to re-enter their PAT just to
  // fix a typo'd hostname.
  ipcMain.handle('config:setServerUrl', async (_e, serverUrl: string) => {
    const cfg = resolveConfig()
    if (cfg.source === 'none') return { ok: false, error: '尚未配置 Token，请先填写完整凭据' }
    const check = await verifyCredentials(serverUrl, cfg.token)
    if (!check.ok) return check
    updateServerUrl(serverUrl)
    broadcastConfigChanged()
    return { ok: true }
  })

  ipcMain.handle('shortcut:get', () => ({
    accelerator: activeShortcut,
    isCustom: activeShortcut === getShortcut()
  }))

  ipcMain.handle('shortcut:set', (_e, accelerator: string) => applyShortcut(accelerator))

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

  ipcMain.handle('queue:count', () => getQueueCount())

  ipcMain.handle('queue:flush', async () => flushQueue())

  // ---------- stickers ----------

  ipcMain.handle('memo:get', async (_e, name: string) => {
    const cfg = resolveConfig()
    if (cfg.source === 'none') return { ok: false, error: '未配置服务器' }
    return getMemo(cfg.serverUrl, cfg.token, name)
  })

  // Content-only autosave for stickers: a plain `updateMask=content` PATCH
  // never touches the attachments field server-side, so — unlike the main
  // panel's edit path — there's no need to fetch/re-send the memo's
  // existing attachment list just to avoid clobbering it.
  ipcMain.handle('sticker:save-content', async (_e, name: string, content: string) => {
    const cfg = resolveConfig()
    if (cfg.source === 'none') return { ok: false, error: '未配置服务器' }
    const result = await updateMemo(cfg.serverUrl, cfg.token, name, content)
    if (result.ok) {
      mergeSavedContent(content)
      scheduleBackgroundRefresh(3000)
    }
    return result
  })

  // A sticker's rendered markdown may contain links; only ever hand http(s)
  // URLs to the OS default-browser opener — anything else (file://, custom
  // schemes a malicious memo could smuggle in) is silently dropped.
  ipcMain.handle('shell:open-external', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
      return { ok: true }
    }
    return { ok: false, error: 'blocked non-http(s) url' }
  })

  ipcMain.on('sticker:open', (_e, memoName: string) => openSticker(memoName))

  ipcMain.on('sticker:close-self', (e) => closeStickerByWebContents(e.sender))

  // "在主面板打开": bring the Spotlight panel to front and hand it the memo
  // name to load — the renderer assembles a MemoListItem (from its cache or
  // a memo:get round trip) and drives the existing loadMemoIntoEditor flow.
  ipcMain.on('sticker:edit-in-panel', (_e, memoName: string) => {
    showPanel()
    panel?.webContents.send('panel:load-memo', memoName)
  })
}

// ---------- lifecycle ----------

// Dev and packaged builds otherwise share userData ("memoglass"), which makes
// the single-instance lock mutually exclusive and mixes configs. Isolate dev.
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showPanel)

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('dev.zhijie.memoglass')

    setQueueListeners({
      onChanged: (count) => panel?.webContents.send('queue:changed', { count }),
      onItemFailed: (error) => panel?.webContents.send('queue:item-failed', { error })
    })

    registerIpc()
    // Create the tray BEFORE flipping to accessory: switching the activation
    // policy (dock.hide) while a status item is being created can eat the
    // item permanently on macOS (known Electron quirk).
    createTray()
    createPanel()
    registerShortcut()
    scheduleBackgroundRefresh()
    restoreStickers()

    const pendingCount = getQueueCount()
    if (pendingCount > 0) {
      console.log(`[memoglass] ${pendingCount} pending memo(s) from a previous session; retrying`)
      void flushQueue()
    }
    startAutoRetry()

    // Two ways to become an accessory app (no Dock icon, no Cmd-Tab entry):
    // packaged builds set LSUIElement in Info.plist (see electron-builder.yml
    // mac.extendInfo), so the app is accessory from the very first frame and
    // never needs this at all. In dev (`electron-vite dev`, running the
    // plain Electron binary with no custom Info.plist) we instead flip the
    // activation policy at runtime via app.dock.hide() — delayed and run
    // after createTray() because switching policy while a status item is
    // still being created can make macOS eat it permanently.
    if (!app.isPackaged && process.platform === 'darwin') {
      setTimeout(() => {
        app.dock?.hide()
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
    }

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
