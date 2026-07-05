import { useCallback, useEffect, useRef, useState } from 'react'
import { useGlassEditor } from './editor'
import type { AppContext, CommentItem, MemoListItem } from '../../preload/index'

type SaveState = 'idle' | 'saving' | 'saved' | 'queued' | 'error'
type View = 'editor' | 'setup' | 'switcher'

interface EditTarget {
  name: string
  updateTime: string
}

const TAG_RE = /#([^\s#,;!?()[\]{}"'`]+)/g

function extractTags(text: string): string[] {
  const tags = new Set<string>()
  for (const m of text.matchAll(TAG_RE)) tags.add(m[1])
  return [...tags].slice(0, 4)
}

/** Recent-memo cache for the ⌘P switcher: module-level so it survives view
 *  swaps and lets the switcher render instantly on open (before the
 *  background refresh lands). */
let memoListCache: MemoListItem[] = []

async function refreshMemoList(): Promise<MemoListItem[]> {
  try {
    const res = await window.memoglass.listMemos()
    if (res.ok && res.memos) {
      memoListCache = res.memos
    }
  } catch {
    // keep whatever we had; the switcher will just show stale data
  }
  return memoListCache
}

/** First non-blank line, with leading markdown markers stripped, for the
 *  switcher's one-line preview. */
function stripMarkdown(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? ''
  return firstLine
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s*)?/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/^\s*>\s*/, '')
    .trim()
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Chinese relative-time label for the switcher's second line. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const now = Date.now()
  const diffSec = Math.max(0, Math.floor((now - then) / 1000))
  if (diffSec < 60) return '刚刚'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 小时前`
  const d = new Date(then)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return '昨天'
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** Whitespace-tokenized AND filter over memo content, case-insensitive. */
function filterMemos(list: MemoListItem[], query: string): MemoListItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const base =
    words.length === 0
      ? list
      : list.filter((m) => {
          const text = m.content.toLowerCase()
          return words.every((w) => text.includes(w))
        })
  return base.slice(0, 50)
}

interface AttachmentItem {
  id: string
  filename: string
  mimeType: string
  dataB64: string // '' for server-origin items — they're not re-uploaded
  previewUrl: string | null // local: objectURL; server: data: URL once fetched, else null
  origin: 'local' | 'server'
  serverName?: string // "attachments/xxx" — only set for origin === 'server'
}

let attachmentSeq = 0
function nextAttachmentId(): string {
  attachmentSeq += 1
  return `att-${Date.now()}-${attachmentSeq}`
}

/** Reads a File as base64 (no "data:...;base64," prefix — the main process
 *  wants raw base64 to forward straight to Memos). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('unexpected FileReader result'))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

// Files dragged from apps like CleanShot arrive via file promises with an
// empty `type`; infer from the extension so images still get thumbnails.
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mkv: 'video/x-matroska'
}

function inferMime(file: File): string {
  if (file.type) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? 'application/octet-stream'
}

/** Server-reported attachment `type` is sometimes blank or a generic
 *  'application/octet-stream' (some upload paths / proxies don't set it
 *  correctly) — fall back to the filename extension so a saved video/image
 *  still gets recognized as such instead of falling through to the plain
 *  file icon. */
function inferMimeFromFilename(filename: string, type: string): string {
  if (type && type !== 'application/octet-stream') return type
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? type ?? 'application/octet-stream'
}

async function fileToAttachment(file: File): Promise<AttachmentItem> {
  const dataB64 = await fileToBase64(file)
  const mimeType = inferMime(file)
  // Images get a real thumbnail; videos get a playable preview too (not just
  // the ▶ icon) — both are just local blob URLs, cheap and instant since the
  // bytes are already on disk. Nothing else gets a preview.
  const previewUrl =
    mimeType.startsWith('image/') || mimeType.startsWith('video/')
      ? URL.createObjectURL(file)
      : null
  return {
    id: nextAttachmentId(),
    filename: file.name || 'file',
    mimeType,
    dataB64,
    previewUrl,
    origin: 'local'
  }
}

/** Only local items own an objectURL that needs releasing — server items'
 *  previewUrl (when set) is a `data:` URL fetched over IPC, nothing to
 *  revoke. */
function revokePreview(item: AttachmentItem): void {
  if (item.origin === 'local' && item.previewUrl) URL.revokeObjectURL(item.previewUrl)
}

/** Max size (bytes) we'll bother asking the main process to fetch a preview
 *  for — matches the server-side caps in fetchAttachmentData; keeping the
 *  same thresholds here just avoids a pointless round trip for attachments
 *  we already know will be skipped. */
const MAX_PREVIEW_FETCH_BYTES = 4 * 1024 * 1024
const MAX_VIDEO_PREVIEW_FETCH_BYTES = 40 * 1024 * 1024

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>('editor')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [content, setContent] = useState('')
  const [source, setSource] = useState('')
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [pinned, setPinned] = useState(false)
  const [context, setContext] = useState<AppContext | null>(null)
  const [contextEnabled, setContextEnabled] = useState(true)
  const [pendingCount, setPendingCount] = useState(0)
  // Server-origin attachments the user removed from the strip during this
  // edit session — not yet deleted, just staged; surfaced in the edit
  // banner so the (irreversible) cascade delete on save isn't a surprise.
  const [removedServerCount, setRemovedServerCount] = useState(0)
  // ---------- comments (edit mode only) ----------
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [comments, setComments] = useState<CommentItem[]>([])
  const [commentsError, setCommentsError] = useState('')
  const [commentInput, setCommentInput] = useState('')
  const [commentSending, setCommentSending] = useState(false)
  const [commentSendError, setCommentSendError] = useState('')
  // Guards against a slow listComments/addComment response landing after the
  // user has already switched to a different memo (or left edit mode) —
  // compared against on resolve so stale network replies never clobber a
  // newer memo's comment state.
  const activeCommentMemoRef = useRef<string | null>(null)
  const saveStateRef = useRef(saveState)
  saveStateRef.current = saveState
  const attachmentsRef = useRef<AttachmentItem[]>(attachments)
  attachmentsRef.current = attachments
  const dragDepthRef = useRef(0)

  // ---------- ⌘P switcher state ----------
  const [memoList, setMemoList] = useState<MemoListItem[]>(memoListCache)
  const [switcherQuery, setSwitcherQuery] = useState('')
  const [switcherIndex, setSwitcherIndex] = useState(0)
  const filtered = filterMemos(memoList, switcherQuery)
  // Clamp for *display/selection* without a setState-in-effect: the raw
  // switcherIndex only ever grows via arrow keys (already bounds-checked
  // there) or resets to 0 on new input, but the list can independently
  // shrink under it (background refresh landing while filtered), so we
  // derive a safe value at render time instead of syncing state to match.
  const safeSwitcherIndex = Math.min(switcherIndex, Math.max(filtered.length - 1, 0))
  const filteredRef = useRef(filtered)
  filteredRef.current = filtered
  const safeSwitcherIndexRef = useRef(safeSwitcherIndex)
  safeSwitcherIndexRef.current = safeSwitcherIndex
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (list.length === 0) return
    const items = await Promise.all(list.map(fileToAttachment))
    setAttachments((prev) => [...prev, ...items])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    const found = attachmentsRef.current.find((a) => a.id === id)
    if (found) {
      revokePreview(found)
      if (found.origin === 'server') setRemovedServerCount((c) => c + 1)
    }
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const resetComments = useCallback(() => {
    activeCommentMemoRef.current = null
    setCommentsOpen(false)
    setComments([])
    setCommentsError('')
    setCommentInput('')
    setCommentSending(false)
    setCommentSendError('')
  }, [])

  const sendComment = useCallback(async () => {
    if (!editTarget) return
    const text = commentInput.trim()
    if (!text || commentSending) return
    const memoName = editTarget.name
    setCommentSending(true)
    setCommentSendError('')
    const res = await window.memoglass.addComment(memoName, text)
    if (activeCommentMemoRef.current !== memoName) return // moved on meanwhile
    if (!res.ok) {
      setCommentSending(false)
      setCommentSendError(res.error ?? '发送失败')
      return
    }
    setCommentInput('')
    const listRes = await window.memoglass.listComments(memoName)
    if (activeCommentMemoRef.current !== memoName) return
    setCommentSending(false)
    if (listRes.ok && listRes.comments) {
      setComments(
        [...listRes.comments].sort(
          (a, b) => new Date(a.createTime).getTime() - new Date(b.createTime).getTime()
        )
      )
      setCommentsError('')
    }
    // If the refresh itself failed, the just-sent comment is still safely on
    // the server — leave the (now possibly stale) list as-is rather than
    // showing an error for what was actually a successful send.
  }, [editTarget, commentInput, commentSending])

  const doSave = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      const hasAttachments = attachments.length > 0

      if (editTarget) {
        if (!trimmed && !hasAttachments) {
          window.memoglass.hidePanel()
          return
        }
        if (saveStateRef.current === 'saving') return
        setSaveState('saving')
        const keepAttachmentNames = attachments
          .filter((a) => a.origin === 'server' && a.serverName)
          .map((a) => a.serverName as string)
        const newAttachments = attachments
          .filter((a) => a.origin === 'local')
          .map(({ filename, mimeType, dataB64 }) => ({ filename, mimeType, dataB64 }))
        const res = await window.memoglass.updateMemo(editTarget.name, trimmed, {
          keepAttachmentNames,
          newAttachments
        })
        if (res.ok) {
          setSaveState('saved')
          setTimeout(() => {
            handle.clear()
            setContent('')
            setEditTarget(null)
            setAttachments((prev) => {
              prev.forEach(revokePreview)
              return []
            })
            setRemovedServerCount(0)
            resetComments()
            setSaveState('idle')
            window.memoglass.hidePanel()
          }, 450)
        } else {
          setSaveState('error')
          setErrorMsg(res.error ?? '更新失败')
        }
        return
      }

      if (!trimmed && !hasAttachments) {
        window.memoglass.hidePanel()
        return
      }
      if (saveStateRef.current === 'saving') return
      setSaveState('saving')
      // Context link is a pure addendum — it never affects whether a save
      // is allowed (canSave stays keyed off trimmed/attachments only), it
      // just rides along on the content when present + enabled.
      const browserCtx = contextEnabled ? context?.browser : undefined
      const finalContent = browserCtx
        ? trimmed
          ? `${trimmed}\n\n[${browserCtx.title}](${browserCtx.url})`
          : `[${browserCtx.title}](${browserCtx.url})`
        : trimmed
      const res = await window.memoglass.saveMemo({
        content: finalContent,
        attachments: attachments.map(({ filename, mimeType, dataB64 }) => ({
          filename,
          mimeType,
          dataB64
        }))
      })
      if (res.ok) {
        // Offline queue: the memo is safely persisted locally and will sync
        // automatically, but it hasn't actually reached the server yet — a
        // distinct badge (vs. the checkmark) keeps that honest.
        setSaveState(res.queued ? 'queued' : 'saved')
        setTimeout(() => {
          handle.clear()
          setContent('')
          setAttachments((prev) => {
            prev.forEach(revokePreview)
            return []
          })
          setContext(null) // avoid stale context leaking into the next memo
          setSaveState('idle')
          window.memoglass.hidePanel()
        }, 450)
      } else {
        setSaveState('error')
        setErrorMsg(res.error ?? '保存失败')
      }
    },
    [attachments, editTarget, context, contextEnabled, resetComments]
  )

  const openSwitcher = useCallback(() => {
    setSwitcherQuery('')
    setSwitcherIndex(0)
    setMemoList(memoListCache)
    setView('switcher')
    void refreshMemoList().then(setMemoList)
  }, [])

  const { containerRef, handle } = useGlassEditor({
    onSave: doSave,
    onEscape: () => window.memoglass.hidePanel(),
    onChange: (t) => {
      setContent(t)
      if (saveStateRef.current === 'error') setSaveState('idle')
    },
    onSwitcher: openSwitcher
  })

  const startNew = useCallback(() => {
    handle.clear()
    setContent('')
    setEditTarget(null)
    setAttachments((prev) => {
      prev.forEach(revokePreview)
      return []
    })
    setRemovedServerCount(0)
    resetComments()
    setView('editor')
    setTimeout(() => handle.focus(), 30)
  }, [handle, resetComments])

  const cancelEdit = useCallback(() => {
    handle.clear()
    setContent('')
    setEditTarget(null)
    setAttachments((prev) => {
      prev.forEach(revokePreview)
      return []
    })
    setRemovedServerCount(0)
    resetComments()
    handle.focus()
  }, [handle, resetComments])

  const loadMemoIntoEditor = useCallback(
    (memo: MemoListItem) => {
      handle.setContent(memo.content)
      setContent(memo.content)
      setEditTarget({ name: memo.name, updateTime: memo.updateTime })
      const serverAttachments = memo.attachments ?? []
      setAttachments((prev) => {
        prev.forEach(revokePreview)
        return serverAttachments.map((a) => ({
          id: nextAttachmentId(),
          filename: a.filename,
          mimeType: inferMimeFromFilename(a.filename, a.type),
          dataB64: '',
          previewUrl: null,
          origin: 'server' as const,
          serverName: a.name
        }))
      })
      setRemovedServerCount(0)
      if (saveStateRef.current === 'error') setSaveState('idle')
      setView('editor')
      setTimeout(() => handle.focus(), 30)

      // Comments: reset to collapsed/empty for the newly-loaded memo, then
      // fetch its list in the background — never blocks entering edit mode.
      setCommentsOpen(false)
      setComments([])
      setCommentsError('')
      setCommentInput('')
      setCommentSending(false)
      setCommentSendError('')
      activeCommentMemoRef.current = memo.name
      window.memoglass.listComments(memo.name).then((res) => {
        if (activeCommentMemoRef.current !== memo.name) return // stale: moved on
        if (res.ok && res.comments) {
          setComments(
            [...res.comments].sort(
              (a, b) => new Date(a.createTime).getTime() - new Date(b.createTime).getTime()
            )
          )
        } else {
          setCommentsError(res.error ?? '加载失败')
        }
      })

      // Hydrate real thumbnails/players asynchronously, one IPC round trip
      // per attachment. Pre-filter client-side (type/size already known
      // from the list payload) to skip the obviously-not-going-to-work
      // cases without even asking main; main enforces the same caps
      // authoritatively against the real response headers regardless.
      for (const a of serverAttachments) {
        const mime = inferMimeFromFilename(a.filename, a.type)
        const isImage = mime.startsWith('image/')
        const isVideo = mime.startsWith('video/')
        if (!isImage && !isVideo) continue
        const limit = isImage ? MAX_PREVIEW_FETCH_BYTES : MAX_VIDEO_PREVIEW_FETCH_BYTES
        if (a.size > limit) continue
        window.memoglass.fetchAttachment(a.name, a.filename).then((res) => {
          if (!res.ok || !res.dataUrl) return // skip/failure: stays in icon state
          setAttachments((prev) =>
            prev.map((p) => (p.serverName === a.name ? { ...p, previewUrl: res.dataUrl! } : p))
          )
        })
      }
    },
    [handle]
  )

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev
      window.memoglass.setPinned(next)
      return next
    })
  }, [])

  // Global ⌘P fallback: the CodeMirror keymap only fires while the editor has
  // focus. This capture-phase listener makes the switcher reachable from any
  // focus state (fresh panel, bottom bar, attachment strip) and blocks
  // Chromium's default print handling.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        e.stopPropagation()
        if (view === 'editor') openSwitcher()
        else if (view === 'switcher') setView('editor')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [view, openSwitcher])

  // Focus editor every time the panel appears; check config on mount
  useEffect(() => {
    window.memoglass.getConfig().then((cfg) => {
      setSource(cfg.source)
      if (!cfg.configured) setView('setup')
    })
    const off = window.memoglass.onShown(() => {
      setTimeout(() => handle.focus(), 30)
      // Pre-warm the switcher cache on every panel show, so ⌘P opens instantly.
      void refreshMemoList().then(setMemoList)
    })
    // Fired once per panel show, a beat after 'panel:shown' (context capture
    // is async) — re-enable by default each time so a stale toggle from a
    // previous memo never silently suppresses the new context.
    const offContext = window.memoglass.onContextUpdate((ctx) => {
      setContext(ctx)
      setContextEnabled(true)
    })
    // The settings window's "服务器" tab saved a new URL/token — re-check
    // config (updates the dev badge / source) and leave the first-run setup
    // screen if it was still showing.
    const offConfig = window.memoglass.onConfigChanged(() => {
      window.memoglass.getConfig().then((cfg) => {
        setSource(cfg.source)
        setView((v) => (v === 'setup' ? 'editor' : v))
      })
      void refreshMemoList().then(setMemoList)
    })
    handle.focus()
    return () => {
      off()
      offContext()
      offConfig()
    }
  }, [])

  // Offline queue indicator: seed from the current count on mount, then
  // stay live via push events (enqueue/dequeue happen entirely in main).
  useEffect(() => {
    window.memoglass.getQueueCount().then(setPendingCount)
    const offQueue = window.memoglass.onQueueChanged(setPendingCount)
    const offQueueFailed = window.memoglass.onQueueItemFailed((error) => {
      // Poison-pill drop: the item was undeliverable (server rejected it)
      // and got removed from the queue rather than retried forever.
      console.warn('[memoglass] a queued memo could not be delivered and was dropped:', error)
    })
    return () => {
      offQueue()
      offQueueFailed()
    }
  }, [])

  // ---------- ⌘P switcher keyboard nav ----------
  useEffect(() => {
    if (view !== 'switcher') return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSwitcherIndex((i) => Math.min(i + 1, Math.max(filteredRef.current.length - 1, 0)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSwitcherIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const target = filteredRef.current[safeSwitcherIndexRef.current]
        if (target) loadMemoIntoEditor(target)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setView('editor')
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setView('editor')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, loadMemoIntoEditor])

  // Keep selected row in view as the user arrows through the list.
  useEffect(() => {
    if (view !== 'switcher') return
    itemRefs.current[safeSwitcherIndex]?.scrollIntoView({ block: 'nearest' })
  }, [safeSwitcherIndex, view])

  if (view === 'setup') {
    return <SetupView onDone={() => setView('editor')} />
  }

  const tags = extractTags(content)
  const canSave = (content.trim().length > 0 || attachments.length > 0) && saveState !== 'saving'
  const videoAttachments = attachments.filter(
    (a) => a.mimeType.startsWith('video/') && a.previewUrl
  )

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragDepthRef.current += 1
    setDragActive(true)
  }
  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault() // required to allow drop
  }
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
  }
  const onEditorPaste = (e: React.ClipboardEvent<HTMLDivElement>): void => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault() // screenshot/file paste: don't let CM insert anything odd
      addFiles(files)
    }
  }

  // NOTE: the editor DOM node (`.editor-wrap`) must stay mounted for the
  // lifetime of the app — CodeMirror's EditorView is created once and
  // attached to it imperatively. The switcher is therefore rendered as an
  // overlay on top of the (still-live, still-holding-your-draft) editor
  // rather than swapping it out of the tree.
  return (
    <div
      className={`card${dragActive ? ' drop-active' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="drag-strip" />

      {editTarget && view === 'editor' && (
        <div className="edit-banner">
          <span>
            正在编辑 · {formatRelative(editTarget.updateTime)} <kbd>⌘↩</kbd> 保存更新
            {removedServerCount > 0 && (
              <span className="edit-banner-warn">（保存将删除 {removedServerCount} 个附件）</span>
            )}
          </span>
          <button className="edit-banner-cancel" onClick={cancelEdit}>
            取消
          </button>
        </div>
      )}

      <div
        className="editor-wrap"
        ref={containerRef}
        onClick={() => handle.focus()}
        onPaste={onEditorPaste}
      />

      {attachments.length > 0 && (
        <div className="attachment-strip">
          {attachments.map((a) => (
            <AttachmentChip key={a.id} item={a} onRemove={() => removeAttachment(a.id)} />
          ))}
        </div>
      )}

      {/* Video attachments get a real inline player here — the strip chip
       *  above is just an identity/remove control (▶ icon), too small to
       *  usefully host native <video> controls. Only renders once a preview
       *  URL is available (hydrated from the server, or a local blob URL
       *  for a not-yet-saved attachment); oversized server videos that got
       *  skipped upstream simply never reach this list. */}
      {videoAttachments.length > 0 && (
        <div className="attachment-video-previews">
          {videoAttachments.map((a) => (
            <video
              key={a.id}
              className="attachment-video-preview"
              src={a.previewUrl!}
              controls
              preload="metadata"
            />
          ))}
        </div>
      )}

      {editTarget && view === 'editor' && (
        <CommentsSection
          open={commentsOpen}
          onToggle={() => setCommentsOpen((v) => !v)}
          comments={comments}
          loadError={commentsError}
          inputValue={commentInput}
          onInputChange={setCommentInput}
          onSubmit={sendComment}
          sending={commentSending}
          sendError={commentSendError}
        />
      )}

      <div className="bottom-bar">
        <div className="tags">
          {context?.browser && !editTarget && (
            <button
              type="button"
              className={`context-chip${contextEnabled ? ' enabled' : ' disabled'}`}
              title={context.browser.url}
              onClick={() => setContextEnabled((v) => !v)}
            >
              🌐 {truncate(context.browser.title || context.browser.url, 24)}
            </button>
          )}
          {tags.map((t) => (
            <span className="tag-pill" key={t}>
              #{t}
            </span>
          ))}
        </div>
        <div className="right-cluster">
          {saveState === 'error' && <span className="error-text">{errorMsg}</span>}
          {pendingCount > 0 && (
            <button
              type="button"
              className="queue-pill"
              title="待同步 · 点击立即重试"
              onClick={() => {
                window.memoglass.flushQueue().then(setPendingCount)
              }}
            >
              ☁ {pendingCount}
            </button>
          )}
          <button
            className={`icon-btn pin-btn${pinned ? ' active' : ''}`}
            title={pinned ? '取消钉住' : '钉住面板'}
            onClick={togglePin}
          >
            📌
          </button>
          <button className="icon-btn" title="设置" onClick={() => window.memoglass.openSettings()}>
            ⚙
          </button>
          {source === 'dev' && <span className="dev-badge">dev</span>}
          {content.length > 0 && <span className="char-count">{content.length}</span>}
          <button
            className={`save-btn ${canSave ? 'enabled' : ''}`}
            onClick={() => doSave(handle.getContent())}
            disabled={!canSave}
          >
            {saveState === 'saving' ? '保存中…' : 'Save'}
            <kbd>⌘↩</kbd>
          </button>
        </div>
      </div>

      {saveState === 'saved' && (
        <div className="saved-overlay">
          <div className="saved-check">✓</div>
        </div>
      )}

      {saveState === 'queued' && (
        <div className="saved-overlay">
          <div className="saved-check queued-badge">
            ☁<span className="queued-label">已离线暂存</span>
          </div>
        </div>
      )}

      {view === 'switcher' && (
        <div className="switcher-overlay">
          <div className="switcher-search-row">
            <input
              className="switcher-search-input"
              autoFocus
              placeholder="搜索最近笔记…"
              value={switcherQuery}
              onChange={(e) => {
                setSwitcherQuery(e.target.value)
                setSwitcherIndex(0)
              }}
            />
            <button className="switcher-new-btn" onClick={startNew}>
              ＋ 新建
            </button>
          </div>
          <div className="switcher-list">
            {filtered.length === 0 && <div className="switcher-empty">没有匹配的笔记</div>}
            {filtered.map((memo, i) => {
              const preview = truncate(stripMarkdown(memo.content) || '（空白笔记）', 60)
              const memoTags = (memo.tags ?? []).slice(0, 2)
              return (
                <div
                  key={memo.name}
                  ref={(el) => {
                    itemRefs.current[i] = el
                  }}
                  className={`switcher-item${i === safeSwitcherIndex ? ' selected' : ''}`}
                  onMouseEnter={() => setSwitcherIndex(i)}
                  onClick={() => loadMemoIntoEditor(memo)}
                >
                  <div className="switcher-item-line1">{preview}</div>
                  <div className="switcher-item-line2">
                    <span className="switcher-item-time">{formatRelative(memo.updateTime)}</span>
                    {memoTags.map((t) => (
                      <span className="tag-pill switcher-item-tag" key={t}>
                        #{t}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function AttachmentChip({
  item,
  onRemove
}: {
  item: AttachmentItem
  onRemove: () => void
}): React.JSX.Element {
  const isVideo = item.mimeType.startsWith('video/')

  return (
    <div className="attachment-chip">
      {/* Video previewUrls power the full player below the strip, not this
       *  thumbnail slot — an <img> can't render video bytes, so videos
       *  always keep the icon tile here as an identity/remove handle. */}
      {item.previewUrl && !isVideo ? (
        <img src={item.previewUrl} alt={item.filename} className="attachment-thumb" />
      ) : (
        <div className="attachment-icon-tile">
          <span className="attachment-icon">{isVideo ? '▶' : '📄'}</span>
          <span className="attachment-name">{item.filename}</span>
        </div>
      )}
      <button className="attachment-remove" onClick={onRemove} aria-label={`移除 ${item.filename}`}>
        ×
      </button>
    </div>
  )
}

function CommentsSection({
  open,
  onToggle,
  comments,
  loadError,
  inputValue,
  onInputChange,
  onSubmit,
  sending,
  sendError
}: {
  open: boolean
  onToggle: () => void
  comments: CommentItem[]
  loadError: string
  inputValue: string
  onInputChange: (v: string) => void
  onSubmit: () => void
  sending: boolean
  sendError: string
}): React.JSX.Element {
  const label = comments.length > 0 ? `${comments.length} 条评论` : '添加评论'

  // Enter (with or without ⌘) submits from here regardless of whether the
  // input is inside a modifier chord — the focused control decides what
  // gets submitted, so the comment box never lets a keystroke leak up to
  // CodeMirror's Mod-Enter save binding or any window-level shortcut
  // listener.
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      onSubmit()
    }
  }

  return (
    <div className="comments-section">
      <button type="button" className="comments-toggle" onClick={onToggle}>
        💬 {label}
      </button>
      {open && (
        <div className="comments-panel">
          {loadError ? (
            <div className="comments-load-error">评论加载失败</div>
          ) : (
            <div className="comments-list">
              {comments.length === 0 ? (
                <div className="comments-empty">暂无评论</div>
              ) : (
                comments.map((c) => (
                  <div className="comment-item" key={c.name}>
                    <div className="comment-content">{c.content}</div>
                    <div className="comment-time">{formatRelative(c.createTime)}</div>
                  </div>
                ))
              )}
            </div>
          )}
          <div className="comment-input-row">
            <input
              className="comment-input"
              placeholder="添加评论…"
              value={inputValue}
              disabled={sending}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={onInputKeyDown}
            />
          </div>
          {sendError && <span className="error-text comment-send-error">{sendError}</span>}
        </div>
      )}
    </div>
  )
}

function SetupView({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (): Promise<void> => {
    if (!url.trim() || !token.trim()) return
    setBusy(true)
    setErr('')
    const res = await window.memoglass.setConfig(url.trim(), token.trim())
    setBusy(false)
    if (res.ok) onDone()
    else setErr(res.error ?? '验证失败')
  }

  return (
    <div className="card setup">
      <div className="drag-strip" />
      <h2>连接 Memos</h2>
      <input
        placeholder="服务器地址，如 https://memos.example.com"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        spellCheck={false}
      />
      <input
        placeholder="Access Token (PAT)"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {err && <span className="error-text">{err}</span>}
      <button className="save-btn enabled" onClick={submit} disabled={busy}>
        {busy ? '验证中…' : '连接'}
      </button>
    </div>
  )
}
