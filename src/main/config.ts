import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface ResolvedConfig {
  serverUrl: string
  token: string
  source: 'user' | 'dev' | 'none'
}

interface StoredConfig {
  serverUrl: string
  tokenB64: string // safeStorage-encrypted token, base64
}

const configPath = (): string => join(app.getPath('userData'), 'config.json')
const DEV_PAT_FILE = join(homedir(), '.memoglass-dev', 'test-pat.txt')
const DEV_SERVER = 'http://localhost:5231'

function readStored(): StoredConfig | null {
  try {
    if (!existsSync(configPath())) return null
    const raw = JSON.parse(readFileSync(configPath(), 'utf-8')) as StoredConfig
    if (!raw.serverUrl || !raw.tokenB64) return null
    return raw
  } catch {
    return null
  }
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
  const stored: StoredConfig = { serverUrl: serverUrl.replace(/\/+$/, ''), tokenB64 }
  writeFileSync(configPath(), JSON.stringify(stored), { mode: 0o600 })
}
