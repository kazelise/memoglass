/** Memos REST client, main-process only (no CORS, token never enters renderer).
 *  Targets API cluster C (v0.27–v0.29). */

const TIMEOUT_MS = 8000

interface MemosResult {
  ok: boolean
  error?: string
}

async function request(
  serverUrl: string,
  token: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(`${serverUrl.replace(/\/+$/, '')}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init?.headers
      }
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function createMemo(
  serverUrl: string,
  token: string,
  content: string
): Promise<MemosResult> {
  try {
    const res = await request(serverUrl, token, '/api/v1/memos', {
      method: 'POST',
      body: JSON.stringify({ content, visibility: 'PRIVATE' })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 120)}` }
    }
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? '请求超时' : e.message) : String(e)
    return { ok: false, error: msg }
  }
}

/** Cheapest cluster-C-wide credential check: list one memo. */
export async function verifyCredentials(serverUrl: string, token: string): Promise<MemosResult> {
  try {
    const res = await request(serverUrl, token, '/api/v1/memos?pageSize=1')
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
