import { useCallback, useEffect, useRef, useState } from 'react'
import { useGlassEditor } from './editor'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type View = 'editor' | 'setup'

const TAG_RE = /#([^\s#,;!?()[\]{}"'`]+)/g

function extractTags(text: string): string[] {
  const tags = new Set<string>()
  for (const m of text.matchAll(TAG_RE)) tags.add(m[1])
  return [...tags].slice(0, 4)
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

async function fileToAttachment(file: File): Promise<AttachmentItem> {
  const dataB64 = await fileToBase64(file)
  const mimeType = file.type || 'application/octet-stream'
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
  const saveStateRef = useRef(saveState)
  saveStateRef.current = saveState
  const dragDepthRef = useRef(0)

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
      if (!trimmed && !hasAttachments) {
        window.memoglass.hidePanel()
        return
      }
      if (saveStateRef.current === 'saving') return
      setSaveState('saving')
      const res = await window.memoglass.saveMemo({
        content: trimmed,
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
          setSaveState('idle')
          window.memoglass.hidePanel()
        }, 450)
      } else {
        setSaveState('error')
        setErrorMsg(res.error ?? '保存失败')
      }
    },
    [attachments]
  )

  const { containerRef, handle } = useGlassEditor({
    onSave: doSave,
    onEscape: () => window.memoglass.hidePanel(),
    onChange: (t) => {
      setContent(t)
      if (saveStateRef.current === 'error') setSaveState('idle')
    }
  })

  // Focus editor every time the panel appears; check config on mount
  useEffect(() => {
    window.memoglass.getConfig().then((cfg) => {
      setSource(cfg.source)
      if (!cfg.configured) setView('setup')
    })
    const off = window.memoglass.onShown(() => {
      setTimeout(() => handle.focus(), 30)
    })
    handle.focus()
    return off
  }, [])

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

  return (
    <div
      className={`card${dragActive ? ' drop-active' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="drag-strip" />

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
          {tags.map((t) => (
            <span className="tag-pill" key={t}>
              #{t}
            </span>
          ))}
        </div>
        <div className="right-cluster">
          {saveState === 'error' && <span className="error-text">{errorMsg}</span>}
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
