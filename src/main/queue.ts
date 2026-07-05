/** Offline save queue: when the network is down (server unreachable/DNS/
 *  timeout — see `isNetworkError` in memos.ts), a memo that fails to save
 *  is persisted here instead of being lost, and retried automatically once
 *  the network comes back. Server-side rejections (4xx/5xx — bad config,
 *  bad data) are NOT queued; those are the user's problem to fix, and
 *  blindly retrying them forever would just hide the error. */

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { resolveConfig } from './config'
import { createMemo, uploadAttachment } from './memos'
import { mergeSavedContent, scheduleBackgroundRefresh } from './tags'

export interface QueuedAttachment {
  filename: string
  mimeType: string
  dataB64: string
}

export interface QueuedMemo {
  id: string
  content: string
  attachments: QueuedAttachment[]
  createdAt: string
}

const RETRY_INTERVAL_MS = 30_000
const queuePath = (): string => join(app.getPath('userData'), 'pending.json')

let queue: QueuedMemo[] = []
let loaded = false
let seq = 0
let retrying = false
let retryTimer: ReturnType<typeof setInterval> | null = null

type ChangeListener = (count: number) => void
type ItemFailedListener = (error: string) => void
let onChanged: ChangeListener | null = null
let onItemFailed: ItemFailedListener | null = null

/** Wires up broadcast callbacks (main/index.ts owns the panel webContents,
 *  so it supplies the actual `send()` — keeps this module UI-agnostic and
 *  independently testable). */
export function setQueueListeners(handlers: {
  onChanged?: ChangeListener
  onItemFailed?: ItemFailedListener
}): void {
  onChanged = handlers.onChanged ?? null
  onItemFailed = handlers.onItemFailed ?? null
}

function loadQueue(): void {
  if (loaded) return
  loaded = true
  try {
    if (existsSync(queuePath())) {
      const raw = JSON.parse(readFileSync(queuePath(), 'utf-8')) as unknown
      if (Array.isArray(raw)) queue = raw as QueuedMemo[]
    }
  } catch {
    queue = []
  }
}

function persist(): void {
  try {
    writeFileSync(queuePath(), JSON.stringify(queue), { mode: 0o600 })
  } catch (e) {
    console.warn('[memoglass] failed to persist pending queue:', e)
  }
}

function notifyChanged(): void {
  onChanged?.(queue.length)
}

function removeItem(id: string): void {
  queue = queue.filter((q) => q.id !== id)
  persist()
  notifyChanged()
}

/** Enqueues a failed-to-save memo; returns the new queue length. */
export function enqueue(content: string, attachments: QueuedAttachment[]): number {
  loadQueue()
  seq += 1
  const item: QueuedMemo = {
    id: `${Date.now()}-${seq}`,
    content,
    attachments,
    createdAt: new Date().toISOString()
  }
  queue.push(item)
  persist()
  notifyChanged()
  return queue.length
}

export function getQueueCount(): number {
  loadQueue()
  return queue.length
}

/** Replays the queue in `createdAt` order, one item at a time, over the
 *  full upload-attachments → create-memo pipeline. A network-class failure
 *  stops the round immediately (remaining items are left queued for the
 *  next tick — no point burning cycles/battery hammering a dead server).
 *  A server-rejection (poison pill) is dropped so it can't block the queue
 *  forever, and the renderer is told via `onItemFailed`. Returns the queue
 *  length after the round. */
export async function retryQueue(): Promise<number> {
  loadQueue()
  if (retrying) return queue.length
  if (queue.length === 0) return 0
  retrying = true
  try {
    const cfg = resolveConfig()
    if (cfg.source === 'none') return queue.length

    const ordered = [...queue].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    for (const item of ordered) {
      // Item may have been removed by a concurrent flush; re-check.
      if (!queue.some((q) => q.id === item.id)) continue

      const attachmentNames: string[] = []
      let networkFailed = false
      let dropReason: string | null = null

      for (const file of item.attachments) {
        const uploaded = await uploadAttachment(cfg.serverUrl, cfg.token, file)
        if (!uploaded.ok || !uploaded.name) {
          if (uploaded.networkError) networkFailed = true
          else dropReason = `附件上传失败（${file.filename}）：${uploaded.error ?? '未知错误'}`
          break
        }
        attachmentNames.push(uploaded.name)
      }

      if (!networkFailed && !dropReason) {
        const result = await createMemo(cfg.serverUrl, cfg.token, item.content, attachmentNames)
        if (result.ok) {
          removeItem(item.id)
          mergeSavedContent(item.content)
          scheduleBackgroundRefresh(3000)
          continue
        }
        if (result.networkError) networkFailed = true
        else dropReason = result.error ?? '保存失败'
      }

      if (networkFailed) {
        // Stop this round; keep this item (and everything after it, since
        // it's the same dead server) for the next tick.
        break
      }

      // dropReason: a poison pill — the server actively rejected it, and
      // retrying an unchanged payload would just fail the same way forever.
      removeItem(item.id)
      console.warn(`[memoglass] dropping undeliverable pending memo ${item.id}: ${dropReason}`)
      onItemFailed?.(dropReason as string)
    }

    return queue.length
  } finally {
    retrying = false
  }
}

/** Manual "retry now" trigger (e.g. IPC from the renderer); returns the
 *  queue length after the round completes. */
export async function flushQueue(): Promise<number> {
  return retryQueue()
}

/** Starts the 30s background retry loop. Safe to call once at app-ready;
 *  guarded against duplicate timers. */
export function startAutoRetry(): void {
  if (retryTimer) return
  retryTimer = setInterval(() => {
    if (getQueueCount() === 0) return
    void retryQueue()
  }, RETRY_INTERVAL_MS)
}

export function stopAutoRetry(): void {
  if (retryTimer) {
    clearInterval(retryTimer)
    retryTimer = null
  }
}
