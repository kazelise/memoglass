import { useCallback, useEffect, useRef, useState } from 'react'
import { useStickerEditor } from './editor'

type LoadState = 'loading' | 'ready' | 'deleted' | 'error'
type SaveDot = 'synced' | 'pending' | 'saving' | 'error'

const AUTOSAVE_DEBOUNCE_MS = 1500

/** A pinned memo living in its own always-on-top glass window: mini
 *  markdown editor (checkbox toggling + tag coloring, no completion/⌘P),
 *  autosave-on-change, and a hover toolbar to escape back to the main
 *  panel or unpin. Deliberately does not attempt live sync with the main
 *  panel editing the same memo — see the completion report's "known
 *  limitations". */
export default function StickerView({ memoName }: { memoName: string }): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [dot, setDot] = useState<SaveDot>('synced')
  const [saveError, setSaveError] = useState('')

  const latestContentRef = useRef('')
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const pendingRef = useRef(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True until the initial server content has been programmatically loaded
  // into the editor — without this, EditorView's updateListener treats that
  // initial setContent() as a "user edit" and immediately schedules a
  // pointless no-op save.
  const suppressChangeRef = useRef(true)

  const flushSave = useCallback(async (): Promise<void> => {
    if (!dirtyRef.current) return
    if (savingRef.current) {
      pendingRef.current = true
      return
    }
    savingRef.current = true
    dirtyRef.current = false
    setDot('saving')
    const text = latestContentRef.current
    const res = await window.memoglass.saveStickerContent(memoName, text)
    savingRef.current = false
    if (res.ok) {
      setDot('synced')
      setSaveError('')
    } else {
      // Content stays local + in latestContentRef; the next edit (or the
      // pending-retry below, once one lands) will try again. Nothing is
      // ever lost, just not-yet-synced.
      setDot('error')
      setSaveError(res.error ?? '保存失败')
      dirtyRef.current = true
    }
    if (pendingRef.current) {
      pendingRef.current = false
      void flushSave()
    }
  }, [memoName])

  const { containerRef, handle } = useStickerEditor({
    onChange: (text) => {
      if (suppressChangeRef.current) return
      latestContentRef.current = text
      dirtyRef.current = true
      setDot('pending')
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => void flushSave(), AUTOSAVE_DEBOUNCE_MS)
    }
  })

  useEffect(() => {
    let cancelled = false
    window.memoglass.getMemo(memoName).then((res) => {
      if (cancelled) return
      if (res.ok && res.memo) {
        handle.setContent(res.memo.content)
        latestContentRef.current = res.memo.content
        suppressChangeRef.current = false
        setLoadState('ready')
      } else if (res.notFound) {
        setLoadState('deleted')
      } else {
        setLoadState('error')
        setLoadError(res.error ?? '加载失败')
      }
    })
    return () => {
      cancelled = true
    }
    // memoName is fixed for the lifetime of a sticker window (one memo per
    // window) — no need to re-run on a value that never changes post-mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    []
  )

  const editInPanel = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    // Flush any unsaved edit before handing off, so "open in main panel"
    // never shows a stale version of what's on screen right now.
    void flushSave().then(() => window.memoglass.editInPanel(memoName))
  }, [flushSave, memoName])

  const close = useCallback(() => window.memoglass.closeSticker(), [])

  const dotTitle =
    dot === 'error'
      ? saveError || '保存失败'
      : dot === 'saving'
        ? '保存中…'
        : dot === 'pending'
          ? '待保存'
          : '已同步'

  return (
    <div className="sticker-card">
      <div className="sticker-toolbar">
        <div className="sticker-toolbar-drag" />
        {loadState !== 'deleted' && (
          <button
            type="button"
            className="sticker-toolbar-btn"
            title="在主面板打开"
            onClick={editInPanel}
          >
            ⤢
          </button>
        )}
        <button
          type="button"
          className="sticker-toolbar-btn sticker-close-btn"
          title="关闭便签"
          onClick={close}
        >
          ×
        </button>
      </div>

      <div
        className="sticker-editor-wrap"
        ref={containerRef}
        onClick={() => handle.focus()}
        style={{ visibility: loadState === 'deleted' ? 'hidden' : 'visible' }}
      />

      {loadState === 'loading' && <div className="sticker-overlay-msg">加载中…</div>}
      {loadState === 'deleted' && <div className="sticker-overlay-msg">原笔记已被删除</div>}
      {loadState === 'error' && (
        <div className="sticker-overlay-msg sticker-error-msg">{loadError}</div>
      )}

      {loadState !== 'deleted' && (
        <div className={`sticker-status-dot sticker-status-${dot}`} title={dotTitle} />
      )}
    </div>
  )
}
