import { BrowserWindow, screen, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { getStickers, removeSticker, setStickerBounds, type StickerBounds } from './config'

const STICKER_W = 300
const STICKER_H = 220
const MIN_STICKER_W = 220
const MIN_STICKER_H = 140
const CASCADE_STEP = 28
const CASCADE_MARGIN = 24
const PERSIST_DEBOUNCE_MS = 500

const stickers = new Map<string, BrowserWindow>()
// How many stickers we've cascaded on this run (not persisted — a fresh
// launch always restarts the cascade from the anchor corner).
let cascadeIndex = 0

function stickerHash(memoName: string): string {
  return `sticker?name=${encodeURIComponent(memoName)}`
}

/** Anchors new stickers to the top-right of whichever screen the cursor is
 *  on, then cascades each subsequent one down-and-left by (28, 28) so a
 *  burst of pins doesn't perfectly overlap. Wraps back to the anchor once
 *  the cascade would run off the bottom/left of the work area. */
function nextCascadeBounds(width: number, height: number): { x: number; y: number } {
  const cursor = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  const usableW = Math.max(workArea.width - width - CASCADE_MARGIN * 2, 0)
  const usableH = Math.max(workArea.height - height - CASCADE_MARGIN * 2, 0)
  const maxSteps = Math.max(1, Math.floor(Math.min(usableW, usableH) / CASCADE_STEP))
  const step = cascadeIndex % maxSteps
  cascadeIndex += 1
  return {
    x: Math.round(workArea.x + workArea.width - width - CASCADE_MARGIN - step * CASCADE_STEP),
    y: Math.round(workArea.y + CASCADE_MARGIN + step * CASCADE_STEP)
  }
}

function createStickerWindow(memoName: string, saved?: StickerBounds): void {
  const width = saved?.width ?? STICKER_W
  const height = saved?.height ?? STICKER_H

  const win = new BrowserWindow({
    width,
    height,
    type: 'panel', // NSPanel: doesn't steal focus, doesn't join Cmd-Tab
    frame: false,
    show: false,
    vibrancy: 'hud', // match the main panel's glass material
    visualEffectState: 'active',
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    minWidth: MIN_STICKER_W,
    minHeight: MIN_STICKER_H,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Deliberately NOT hiddenInMissionControl: a sticky note living on the
    // desktop is exactly the kind of thing Mission Control should surface.
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 'floating' sits below the main panel's 'screen-saver' level, so opening
  // the Spotlight panel never gets visually buried under a sticker.
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const pos = saved ? { x: saved.x, y: saved.y } : nextCascadeBounds(width, height)
  win.setBounds({ x: pos.x, y: pos.y, width, height })

  stickers.set(memoName, win)
  // Persist immediately so a fresh sticker survives a quit before it's ever
  // been moved/resized.
  setStickerBounds(memoName, { x: pos.x, y: pos.y, width, height })

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const schedulePersist = (): void => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      if (win.isDestroyed()) return
      setStickerBounds(memoName, win.getBounds())
    }, PERSIST_DEBOUNCE_MS)
  }
  win.on('moved', schedulePersist)
  win.on('resized', schedulePersist)

  win.on('closed', () => {
    if (persistTimer) clearTimeout(persistTimer)
    stickers.delete(memoName)
    removeSticker(memoName)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/${stickerHash(memoName)}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: stickerHash(memoName) })
  }

  win.once('ready-to-show', () => win.show())
}

/** Opens a sticker for `memoName`, or focuses its window if one's already
 *  open — pinning the same memo twice should never spawn a duplicate. */
export function openSticker(memoName: string): void {
  const existing = stickers.get(memoName)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }
  const saved = getStickers().find((s) => s.name === memoName)
  createStickerWindow(memoName, saved?.bounds)
}

/** Closes and removes the sticker window that owns `webContents` (used by
 *  the sticker's own "×" button, which only knows about itself, not its
 *  memo name). */
export function closeStickerByWebContents(webContents: WebContents): void {
  const win = BrowserWindow.fromWebContents(webContents)
  win?.close()
}

export function closeAllStickers(): void {
  for (const win of [...stickers.values()]) {
    if (!win.isDestroyed()) win.close()
  }
}

export function hasOpenStickers(): boolean {
  return stickers.size > 0
}

/** Re-opens every sticker that was still pinned open when the app last
 *  quit. Called once at app-ready; the renderer side re-fetches each
 *  memo's live content itself, main only needs to restore the windows. */
export function restoreStickers(): void {
  for (const record of getStickers()) {
    createStickerWindow(record.name, record.bounds)
  }
}
