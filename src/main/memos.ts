/** Memos REST client, main-process only (no CORS, token never enters renderer).
 *  Targets API cluster C (v0.27–v0.29). */

const TIMEOUT_MS = 8000
const UPLOAD_TIMEOUT_MS = 60000 // attachments can be a few MB; give them room

interface MemosResult {
  ok: boolean
  error?: string
  /** True when the failure is transport-level (no response reached the
   *  server: DNS/connection-refused/timeout/etc.) rather than a server
   *  response (4xx/5xx). Callers on the save path use this to decide
   *  whether the memo is safe to queue for offline retry — a real HTTP
   *  error means the server *did* respond (bad config/data), so retrying
   *  blindly would just fail again. */
  networkError?: boolean
}

export interface UploadResult extends MemosResult {
  name?: string
}

/** Classifies a caught error as "network-class" (worth queuing for offline
 *  retry) vs. anything else. Node's `fetch` (undici) throws a `TypeError`
 *  ("fetch failed") whose `.cause` carries the real errno code
 *  (ECONNREFUSED/ENOTFOUND/EAI_AGAIN/...); our own timeout abort surfaces
 *  as `AbortError`. We check name/type first, then fall back to scanning
 *  the message and any `.cause.code` for the well-known codes, since some
 *  runtimes/environments may not preserve the exact shape. */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e.name === 'AbortError') return true // our own request-timeout abort
  if (e instanceof TypeError) return true // undici "fetch failed" / browser "Failed to fetch"
  const cause = (e as { cause?: unknown }).cause
  const code =
    (e as NodeJS.ErrnoException).code ??
    (cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined)
  const NETWORK_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT']
  if (code && NETWORK_CODES.includes(code)) return true
  const haystack = `${e.message} ${cause instanceof Error ? cause.message : ''}`
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(
    haystack
  )
}

async function request(
  serverUrl: string,
  token: string,
  path: string,
  init?: RequestInit,
  timeoutMs: number = TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
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

export interface AttachmentRef {
  name: string // e.g. "attachments/xxx", as returned by uploadAttachment
}

export async function createMemo(
  serverUrl: string,
  token: string,
  content: string,
  attachmentNames?: string[]
): Promise<MemosResult> {
  try {
    const body: {
      content: string
      visibility: string
      attachments?: AttachmentRef[]
    } = { content, visibility: 'PRIVATE' }
    if (attachmentNames && attachmentNames.length > 0) {
      body.attachments = attachmentNames.map((name) => ({ name }))
    }
    const res = await request(serverUrl, token, '/api/v1/memos', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 120)}` }
    }
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? '请求超时' : e.message) : String(e)
    return { ok: false, error: msg, networkError: isNetworkError(e) }
  }
}

/** Uploads one attachment (base64-encoded content) and returns its resource
 *  name ("attachments/xxx") for linking to a memo. */
export async function uploadAttachment(
  serverUrl: string,
  token: string,
  file: { filename: string; mimeType: string; dataB64: string }
): Promise<UploadResult> {
  try {
    const res = await request(
      serverUrl,
      token,
      '/api/v1/attachments',
      {
        method: 'POST',
        body: JSON.stringify({
          filename: file.filename,
          type: file.mimeType,
          content: file.dataB64
        })
      },
      UPLOAD_TIMEOUT_MS
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 120)}` }
    }
    const json = (await res.json().catch(() => null)) as { name?: string } | null
    if (!json?.name) return { ok: false, error: '服务器未返回附件 ID' }
    return { ok: true, name: json.name }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? '上传超时' : e.message) : String(e)
    return { ok: false, error: msg, networkError: isNetworkError(e) }
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

const LIST_TIMEOUT_MS = 10000

/** Attachment metadata as embedded in a memo's `attachments[]` (list/get
 *  endpoints) — not the full attachment entity, just enough to render a
 *  chip and fetch bytes later. */
export interface MemoAttachment {
  name: string // "attachments/xxx"
  filename: string
  type: string // MIME type
  size: number
}

export interface MemoListItem {
  name: string
  content: string
  updateTime: string
  tags?: string[]
  pinned?: boolean
  attachments?: MemoAttachment[]
}

export interface ListMemosResult extends MemosResult {
  memos?: MemoListItem[]
}

/** Raw shape of an attachment as embedded in the API's memo JSON — `size`
 *  comes back as a string (int64-safe encoding), everything else matches. */
interface RawMemoAttachment {
  name: string
  filename: string
  type: string
  size: string | number
}

interface RawMemoListItem extends Omit<MemoListItem, 'attachments'> {
  attachments?: RawMemoAttachment[]
}

/** Recent-memos list for the ⌘P switcher. */
export async function listMemos(
  serverUrl: string,
  token: string,
  pageSize = 50
): Promise<ListMemosResult> {
  try {
    const res = await request(
      serverUrl,
      token,
      `/api/v1/memos?pageSize=${pageSize}`,
      undefined,
      LIST_TIMEOUT_MS
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 120)}` }
    }
    const json = (await res.json().catch(() => null)) as { memos?: RawMemoListItem[] } | null
    if (!json?.memos) return { ok: false, error: '服务器返回格式异常' }
    const memos: MemoListItem[] = json.memos.map((m) => ({
      ...m,
      attachments: (m.attachments ?? []).map((a) => ({
        name: a.name,
        filename: a.filename,
        type: a.type,
        size: typeof a.size === 'string' ? Number(a.size) || 0 : a.size
      }))
    }))
    return { ok: true, memos }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? '请求超时' : e.message) : String(e)
    return { ok: false, error: msg }
  }
}

/** Patches an existing memo's content only. `name` already carries the
 *  "memos/xxx" resource prefix returned by the list endpoint. */
export async function updateMemo(
  serverUrl: string,
  token: string,
  name: string,
  content: string
): Promise<MemosResult> {
  try {
    const res = await request(serverUrl, token, `/api/v1/${name}?updateMask=content`, {
      method: 'PATCH',
      body: JSON.stringify({ content })
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

const ATTACHMENT_FETCH_TIMEOUT_MS = 15000
const MAX_INLINE_ATTACHMENT_BYTES = 4 * 1024 * 1024 // 4MB — bigger than this, show an icon instead

export interface FetchAttachmentResult {
  ok: boolean
  dataUrl?: string
  error?: string
}

/** Downloads one attachment's bytes and returns them as a `data:` URL for
 *  inline `<img>` preview. Gated to images under 4MB — checked against the
 *  response headers *before* the body is read, so a skip never actually
 *  pulls the full payload over the wire. Videos/big files/anything else
 *  come back as `{ ok:false, error:'skip' }`; callers fall back to an icon
 *  chip and treat this as a normal, non-error outcome. */
export async function fetchAttachmentData(
  serverUrl: string,
  token: string,
  attachmentName: string,
  filename: string
): Promise<FetchAttachmentResult> {
  try {
    const res = await request(
      serverUrl,
      token,
      `/file/${attachmentName}/${encodeURIComponent(filename)}`,
      undefined,
      ATTACHMENT_FETCH_TIMEOUT_MS
    )
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const contentType = res.headers.get('content-type') ?? ''
    const contentLengthHeader = res.headers.get('content-length')
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null
    if (
      !contentType.startsWith('image/') ||
      (contentLength !== null && contentLength > MAX_INLINE_ATTACHMENT_BYTES)
    ) {
      void res.body?.cancel().catch(() => {})
      return { ok: false, error: 'skip' }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_INLINE_ATTACHMENT_BYTES) {
      // content-length was missing or understated — enforce the cap anyway
      return { ok: false, error: 'skip' }
    }
    return { ok: true, dataUrl: `data:${contentType};base64,${buf.toString('base64')}` }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? '请求超时' : e.message) : String(e)
    return { ok: false, error: msg }
  }
}

/** Updates an existing memo's content AND its full attachment list in one
 *  go. Tries a single PATCH with a combined `updateMask=content,attachments`
 *  first (confirmed working against Memos v0.29.1); if that request itself
 *  fails (older server rejecting the combined mask, etc.) it falls back to
 *  two sequential PATCHes — attachments first, then content — so the two
 *  concerns stay independently retryable/diagnosable.
 *
 *  ⚠️ `attachmentNames` must be the *full* desired list: any existing
 *  attachment not included here is permanently deleted server-side. */
export async function updateMemoWithAttachments(
  serverUrl: string,
  token: string,
  name: string,
  content: string,
  attachmentNames: string[]
): Promise<MemosResult> {
  const attachments = attachmentNames.map((n) => ({ name: n }))

  try {
    const merged = await request(
      serverUrl,
      token,
      `/api/v1/${name}?updateMask=content,attachments`,
      {
        method: 'PATCH',
        body: JSON.stringify({ content, attachments })
      }
    )
    if (merged.ok) return { ok: true }
    // Non-2xx on the combined attempt: fall through to the two-step path
    // below rather than surfacing this error directly, in case it's just
    // this particular server build rejecting the combined mask.
  } catch (e) {
    if (isNetworkError(e)) {
      const msg = e instanceof Error && e.name === 'AbortError' ? '请求超时' : String(e)
      return { ok: false, error: msg, networkError: true }
    }
    // fall through to the two-step path for non-network errors too
  }

  try {
    const attRes = await request(serverUrl, token, `/api/v1/${name}?updateMask=attachments`, {
      method: 'PATCH',
      body: JSON.stringify({ attachments })
    })
    if (!attRes.ok) {
      const body = await attRes.text().catch(() => '')
      return { ok: false, error: `附件更新失败 HTTP ${attRes.status}: ${body.slice(0, 120)}` }
    }
    const contentRes = await request(serverUrl, token, `/api/v1/${name}?updateMask=content`, {
      method: 'PATCH',
      body: JSON.stringify({ content })
    })
    if (!contentRes.ok) {
      const body = await contentRes.text().catch(() => '')
      return { ok: false, error: `内容更新失败 HTTP ${contentRes.status}: ${body.slice(0, 120)}` }
    }
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? '请求超时' : e.message) : String(e)
    return { ok: false, error: msg, networkError: isNetworkError(e) }
  }
}
