import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface ResolvedConfig {
  serverUrl: string
  token: string
  source: 'user' | 'dev' | 'none'
}

export interface AppearanceConfig {
  fontFamily: string
  /** Separate CJK fallback: latin glyphs hit fontFamily, CJK glyphs fall
   *  through to this ('system' = no explicit CJK override). */
  cjkFontFamily: string
  fontSize: number
  lineHeight: number
}

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  fontFamily: 'system',
  cjkFontFamily: 'system',
  fontSize: 15,
  lineHeight: 1.65
}

export interface PanelSize {
  width: number
  height: number
}

export const DEFAULT_PANEL_SIZE: PanelSize = {
  width: 640,
  height: 320
}

export interface StickerBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface StickerRecord {
  name: string // memo resource name, e.g. "memos/xxx"
  bounds: StickerBounds
}

interface StoredConfig {
  serverUrl?: string
  tokenB64?: string // safeStorage-encrypted token, base64
  appearance?: Partial<AppearanceConfig>
  panelSize?: Partial<PanelSize>
  shortcut?: string // custom global-shortcut accelerator, e.g. 'Alt+Space'
  stickers?: StickerRecord[] // desktop sticker windows currently pinned open
}

const configPath = (): string => join(app.getPath('userData'), 'config.json')
const DEV_PAT_FILE = join(homedir(), '.memoglass-dev', 'test-pat.txt')
const DEV_SERVER = 'http://localhost:5231'

/** Read the whole config file as-is (tolerant of missing/partial fields), so
 *  callers can merge in the one field they care about without clobbering the
 *  rest of the file. */
function readRawConfig(): StoredConfig {
  try {
    if (!existsSync(configPath())) return {}
    return JSON.parse(readFileSync(configPath(), 'utf-8')) as StoredConfig
  } catch {
    return {}
  }
}

function writeRawConfig(next: StoredConfig): void {
  writeFileSync(configPath(), JSON.stringify(next), { mode: 0o600 })
}

function readStored(): { serverUrl: string; tokenB64: string } | null {
  const raw = readRawConfig()
  if (!raw.serverUrl || !raw.tokenB64) return null
  return { serverUrl: raw.serverUrl, tokenB64: raw.tokenB64 }
}

/** User config first; fall back to the local dev PAT file so development
 *  needs zero onboarding. */
export function resolveConfig(): ResolvedConfig {
  const stored = readStored()
  if (stored) {
    try {
      const token = safeStorage.decryptString(Buffer.from(stored.tokenB64, 'base64'))
      return { serverUrl: stored.serverUrl, token, source: 'user' }
    } catch {
      // fall through: encryption key changed or corrupted file
    }
  }
  if (existsSync(DEV_PAT_FILE)) {
    const token = readFileSync(DEV_PAT_FILE, 'utf-8').trim()
    if (token) return { serverUrl: DEV_SERVER, token, source: 'dev' }
  }
  return { serverUrl: '', token: '', source: 'none' }
}

export function saveConfig(serverUrl: string, token: string): void {
  const tokenB64 = safeStorage.encryptString(token).toString('base64')
  const existing = readRawConfig()
  writeRawConfig({ ...existing, serverUrl: serverUrl.replace(/\/+$/, ''), tokenB64 })
}

/** Updates just the server URL, keeping whatever token is already stored
 *  (used when the user edits the URL without re-entering their PAT). */
export function updateServerUrl(serverUrl: string): void {
  const existing = readRawConfig()
  writeRawConfig({ ...existing, serverUrl: serverUrl.replace(/\/+$/, '') })
}

export function getAppearance(): AppearanceConfig {
  const a = readRawConfig().appearance ?? {}
  return {
    fontFamily: typeof a.fontFamily === 'string' ? a.fontFamily : DEFAULT_APPEARANCE.fontFamily,
    cjkFontFamily:
      typeof a.cjkFontFamily === 'string' ? a.cjkFontFamily : DEFAULT_APPEARANCE.cjkFontFamily,
    fontSize: typeof a.fontSize === 'number' ? a.fontSize : DEFAULT_APPEARANCE.fontSize,
    lineHeight: typeof a.lineHeight === 'number' ? a.lineHeight : DEFAULT_APPEARANCE.lineHeight
  }
}

export function setAppearance(appearance: AppearanceConfig): void {
  const existing = readRawConfig()
  writeRawConfig({ ...existing, appearance })
}

export function getPanelSize(): PanelSize {
  const p = readRawConfig().panelSize ?? {}
  return {
    width: typeof p.width === 'number' && p.width > 0 ? p.width : DEFAULT_PANEL_SIZE.width,
    height: typeof p.height === 'number' && p.height > 0 ? p.height : DEFAULT_PANEL_SIZE.height
  }
}

export function setPanelSize(size: PanelSize): void {
  const existing = readRawConfig()
  writeRawConfig({ ...existing, panelSize: size })
}

/** The user's custom global-shortcut accelerator, if any (undefined = use
 *  the built-in default candidates in main/index.ts). */
export function getShortcut(): string | undefined {
  const raw = readRawConfig().shortcut
  return typeof raw === 'string' && raw.trim() ? raw : undefined
}

export function setShortcut(accelerator: string): void {
  const existing = readRawConfig()
  writeRawConfig({ ...existing, shortcut: accelerator })
}

export function clearShortcut(): void {
  const existing = readRawConfig()
  writeRawConfig({ ...existing, shortcut: undefined })
}

/** Sanitizes whatever's on disk into a well-shaped array, dropping any
 *  entry that doesn't look like a valid record (defensive against a
 *  hand-edited or partially-written config.json). */
function normalizeStickers(raw: unknown): StickerRecord[] {
  if (!Array.isArray(raw)) return []
  const out: StickerRecord[] = []
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as StickerRecord).name === 'string' &&
      (item as StickerRecord).bounds &&
      typeof (item as StickerRecord).bounds.x === 'number' &&
      typeof (item as StickerRecord).bounds.y === 'number' &&
      typeof (item as StickerRecord).bounds.width === 'number' &&
      typeof (item as StickerRecord).bounds.height === 'number'
    ) {
      out.push(item as StickerRecord)
    }
  }
  return out
}

/** Every sticker window that should reappear on next launch. */
export function getStickers(): StickerRecord[] {
  return normalizeStickers(readRawConfig().stickers)
}

/** Upserts one sticker's persisted position/size (called on create and on
 *  debounced move/resize). */
export function setStickerBounds(name: string, bounds: StickerBounds): void {
  const existing = readRawConfig()
  const list = normalizeStickers(existing.stickers)
  const idx = list.findIndex((s) => s.name === name)
  if (idx >= 0) list[idx] = { name, bounds }
  else list.push({ name, bounds })
  writeRawConfig({ ...existing, stickers: list })
}

/** Drops a sticker from the persisted set — called when its window closes,
 *  so a sticker the user explicitly closed doesn't come back on restart. */
export function removeSticker(name: string): void {
  const existing = readRawConfig()
  const list = normalizeStickers(existing.stickers).filter((s) => s.name !== name)
  writeRawConfig({ ...existing, stickers: list })
}
