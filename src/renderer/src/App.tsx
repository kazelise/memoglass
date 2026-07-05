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

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>('editor')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [content, setContent] = useState('')
  const [source, setSource] = useState('')
  const saveStateRef = useRef(saveState)
  saveStateRef.current = saveState

  const doSave = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || saveStateRef.current === 'saving') {
      if (!trimmed) window.memoglass.hidePanel()
      return
    }
    setSaveState('saving')
    const res = await window.memoglass.saveMemo(trimmed)
    if (res.ok) {
      setSaveState('saved')
      setTimeout(() => {
        handle.clear()
        setContent('')
        setSaveState('idle')
        window.memoglass.hidePanel()
      }, 450)
    } else {
      setSaveState('error')
      setErrorMsg(res.error ?? '保存失败')
    }
  }, [])

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

  return (
    <div className="card">
      <div className="drag-strip" />

      <div className="editor-wrap" ref={containerRef} onClick={() => handle.focus()} />

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
            className={`save-btn ${content.trim() ? 'enabled' : ''}`}
            onClick={() => doSave(handle.getContent())}
            disabled={!content.trim() || saveState === 'saving'}
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
