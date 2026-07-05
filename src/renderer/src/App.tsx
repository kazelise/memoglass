import { useCallback, useEffect, useRef, useState } from 'react'
import { useGlassEditor } from './editor'
import type { AppContext, MemoListItem } from '../../preload/index'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
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
  dataB64: string
  previewUrl: string | null // objectURL, only set for images
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

async function fileToAttachment(file: File): Promise<AttachmentItem> {
  const dataB64 = await fileToBase64(file)
  const mimeType = inferMime(file)
  const previewUrl = mimeType.startsWith('image/') ? URL.createObjectURL(file) : null
  return {
    id: nextAttachmentId(),
    filename: file.name || 'file',
    mimeType,
    dataB64,
    previewUrl
  }
}

function revokePreview(item: AttachmentItem): void {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
}

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
  const saveStateRef = useRef(saveState)
  saveStateRef.current = saveState
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
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id)
      if (found) revokePreview(found)
      return prev.filter((a) => a.id !== id)
    })
  }, [])

  const doSave = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      const hasAttachments = attachments.length > 0

      if (editTarget) {
        if (!trimmed && !hasAttachments) {
          window.memoglass.hidePanel()
          return
        }
        if (hasAttachments) {
          setSaveState('error')
          setErrorMsg('编辑模式暂不支持新增附件')
          return
        }
        if (saveStateRef.current === 'saving') return
        setSaveState('saving')
        const res = await window.memoglass.updateMemo(editTarget.name, trimmed)
        if (res.ok) {
          setSaveState('saved')
          setTimeout(() => {
            handle.clear()
            setContent('')
            setEditTarget(null)
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
        setSaveState('saved')
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
    [attachments, editTarget, context, contextEnabled]
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
    setView('editor')
    setTimeout(() => handle.focus(), 30)
  }, [handle])

  const cancelEdit = useCallback(() => {
    handle.clear()
    setContent('')
    setEditTarget(null)
    setAttachments((prev) => {
      prev.forEach(revokePreview)
      return []
    })
    handle.focus()
  }, [handle])

  const loadMemoIntoEditor = useCallback(
    (memo: MemoListItem) => {
      handle.setContent(memo.content)
      setContent(memo.content)
      setEditTarget({ name: memo.name, updateTime: memo.updateTime })
      setAttachments((prev) => {
        prev.forEach(revokePreview)
        return []
      })
      if (saveStateRef.current === 'error') setSaveState('idle')
      setView('editor')
      setTimeout(() => handle.focus(), 30)
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
    handle.focus()
    return () => {
      off()
      offContext()
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
      {item.previewUrl ? (
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
