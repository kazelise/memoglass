/** Tag aggregation for hashtag autocomplete.
 *
 *  Memos v0.29.1 has no dedicated tag-aggregation endpoint (probed
 *  /api/v1/memos/-/tags, /api/v1/tags, /api/v1/memo-tags, /api/v1/users/:id/tags
 *  — all 404). So we paginate GET /api/v1/memos and aggregate the `tags`
 *  field each memo already returns (falling back to regex extraction from
 *  `content` for any older server that omits it). */

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { resolveConfig } from './config'

export interface TagInfo {
  name: string
  count: number
}

interface TagCache {
  tags: TagInfo[]
  fetchedAt: number
}

interface MemosListMemo {
  content?: string
  tags?: string[]
}

interface MemosListResponse {
  memos?: MemosListMemo[]
  nextPageToken?: string
}

const TIMEOUT_MS = 8000
const MAX_PAGES = 5
const PAGE_SIZE = 200
const TAG_RE = /#([^\s#,;!?()[\]{}"'`]+)/g

const cachePath = (): string => join(app.getPath('userData'), 'tags.json')

let memoryCache: TagCache = { tags: [], fetchedAt: 0 }
let loadedFromDisk = false
let refreshing: Promise<TagInfo[]> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function loadDiskCache(): void {
  if (loadedFromDisk) return
  loadedFromDisk = true
  try {
    if (existsSync(cachePath())) {
      const raw = JSON.parse(readFileSync(cachePath(), 'utf-8')) as TagCache
      if (Array.isArray(raw.tags)) memoryCache = raw
    }
  } catch {
    // ignore corrupt cache
  }
}

function persist(): void {
  try {
    writeFileSync(cachePath(), JSON.stringify(memoryCache))
  } catch {
    // best effort; cache is non-critical
  }
}

function extractTagsFromContent(content: string): string[] {
  const found: string[] = []
  for (const m of content.matchAll(TAG_RE)) found.push(m[1])
  return found
}

async function fetchOnePage(
  serverUrl: string,
  token: string,
  pageToken: string
): Promise<MemosListResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const qs = new URLSearchParams({ pageSize: String(PAGE_SIZE) })
    if (pageToken) qs.set('pageToken', pageToken)
    const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/v1/memos?${qs.toString()}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as MemosListResponse
  } finally {
    clearTimeout(timer)
  }
}

async function fetchAllTags(): Promise<TagInfo[]> {
  const cfg = resolveConfig()
  if (cfg.source === 'none') return []

  const counts = new Map<string, number>()
  let pageToken = ''
  for (let page = 0; page < MAX_PAGES; page++) {
    let resp: MemosListResponse
    try {
      resp = await fetchOnePage(cfg.serverUrl, cfg.token, pageToken)
    } catch (e) {
      console.warn('[memoglass] tags fetch failed:', e instanceof Error ? e.message : e)
      break
    }
    for (const memo of resp.memos ?? []) {
      const tags =
        memo.tags && memo.tags.length > 0 ? memo.tags : extractTagsFromContent(memo.content ?? '')
      for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    if (!resp.nextPageToken) break
    pageToken = resp.nextPageToken
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

/** Kick off (or join) a real fetch, updating the in-memory + disk cache. */
async function refreshNow(): Promise<TagInfo[]> {
  if (refreshing) return refreshing
  refreshing = fetchAllTags()
    .then((tags) => {
      if (tags.length > 0 || memoryCache.tags.length === 0) {
        memoryCache = { tags, fetchedAt: Date.now() }
        persist()
      }
      return memoryCache.tags
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

/** Returns the cached tag list, doing a blocking fetch only if the cache is
 *  completely empty (first run). Otherwise returns immediately and lets
 *  callers rely on the background refresh to keep things fresh. */
export async function getTags(): Promise<TagInfo[]> {
  loadDiskCache()
  if (memoryCache.tags.length === 0) {
    await refreshNow()
  }
  return memoryCache.tags
}

/** Fire-and-forget background refresh, debounced so rapid callers (e.g.
 *  app-ready + a save happening moments later) coalesce into one request. */
export function scheduleBackgroundRefresh(delayMs = 0): void {
  loadDiskCache()
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void refreshNow()
  }, delayMs)
}

/** Optimistically fold the tags found in a just-saved memo into the cache
 *  so autocomplete sees them before the next background refresh lands. */
export function mergeSavedContent(content: string): void {
  loadDiskCache()
  const found = extractTagsFromContent(content)
  if (found.length === 0) return
  const byName = new Map(memoryCache.tags.map((t) => [t.name, t.count]))
  for (const name of found) byName.set(name, (byName.get(name) ?? 0) + 1)
  memoryCache = {
    tags: [...byName.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    fetchedAt: memoryCache.fetchedAt
  }
  persist()
}
