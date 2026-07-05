import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { contentFontFamily, DEFAULT_APPEARANCE, type EditorAppearance } from './editor'

type LoadState = 'loading' | 'ready' | 'deleted' | 'error'
type SaveDot = 'synced' | 'saving' | 'error'

// Matches a GFM task-list marker at the start of a line: "- [ ]", "* [x]",
// "+ [X]", any leading indent. Deliberately the same shape remark-gfm itself
// recognizes, so "the Nth checkbox in the rendered tree" and "the Nth match
// of this regex in the raw source" always agree — see findTaskCheckboxes.
const TASK_MARKER_RE = /^(\s*[-*+]\s)\[( |x|X)\]/gm

// Same hashtag pattern as editor.tsx's hashtagMatcher (CodeMirror side),
// kept identical so a tag looks/behaves the same whether you're looking at
// the sticker or the main panel's editor.
const HASHTAG_RE = /#[^\s#,;!?()[\]{}"'`]+/g

interface TaskCheckbox {
  /** Offset of the single character between "[" and "]" in the source. */
  charFrom: number
  charTo: number
  checked: boolean
}

/** Scans raw markdown for every task-list checkbox, in document order. This
 *  order is what ties a rendered <input> (counted in render order, which
 *  for a single, non-streaming parse is the same as source order — remark
 *  never reorders sibling or nested nodes) back to a precise byte offset in
 *  the source text.
 *
 *  Known limitation: like remark-gfm itself, this doesn't understand fenced
 *  code blocks or blockquotes specially, so a literal "- [ ] foo" inside a
 *  ```code block``` would be double-counted here without being rendered as
 *  a real checkbox (code blocks aren't parsed as task lists by remark-gfm
 *  either, so no interactive checkbox would exist for it — the indices
 *  would only diverge if a document mixes literal task-marker-shaped text
 *  inside code with real task lists elsewhere, an edge case rare enough not
 *  to justify a full markdown-aware scanner here). */
function findTaskCheckboxes(source: string): TaskCheckbox[] {
  const boxes: TaskCheckbox[] = []
  TASK_MARKER_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TASK_MARKER_RE.exec(source))) {
    const bracketStart = match.index + match[1].length // index of '['
    const charFrom = bracketStart + 1 // the space/x/X between [ and ]
    boxes.push({ charFrom, charTo: charFrom + 1, checked: match[2].toLowerCase() === 'x' })
  }
  return boxes
}

/** Flips the `idx`-th task checkbox (0-based, document order) in `source`.
 *  Returns the new source, or null if there's no checkbox at that index
 *  (defensive — should never happen since idx always comes from counting
 *  the same document during render). */
function toggleCheckboxAt(source: string, idx: number): string | null {
  const boxes = findTaskCheckboxes(source)
  const box = boxes[idx]
  if (!box) return null
  const replacement = box.checked ? ' ' : 'x'
  return source.slice(0, box.charFrom) + replacement + source.slice(box.charTo)
}

// Self-test examples (exercised ad hoc during development — this project
// has no test runner yet):
//
//   findTaskCheckboxes('- [ ] a\n- [x] b') ->
//     [{charFrom:3,...,checked:false}, {charFrom:11,...,checked:true}]
//   toggleCheckboxAt('- [ ] a\n- [x] b', 1) -> '- [ ] a\n- [ ] b'
//
// Nested list, order must follow source top-to-bottom regardless of
// nesting depth:
//   '- [ ] parent\n  - [ ] child\n- [x] sibling'
//   idx 0 = parent, idx 1 = child, idx 2 = sibling — matches both the
//   regex scan order (line-by-line) and remark's render order (a list
//   item's own checkbox renders before it descends into nested children,
//   which in turn render before the next sibling item).

/** Splits a string on #hashtag runs and wraps matches in a colored span.
 *  Deliberately only handles string leaf nodes — nested inline elements
 *  (bold/italic/code produced by their own renderers) are left untouched,
 *  matching the main panel's existing "good enough" tag-coloring scope
 *  rather than writing a full recursive AST walker for one cosmetic
 *  feature. */
function renderTextWithTags(children: React.ReactNode): React.ReactNode {
  const nodes = Array.isArray(children) ? children : [children]
  return nodes.map((node, i) => {
    if (typeof node !== 'string') return node
    const parts = node.split(HASHTAG_RE)
    const matches = node.match(HASHTAG_RE)
    if (!matches) return node
    const out: React.ReactNode[] = []
    parts.forEach((part, j) => {
      if (part) out.push(part)
      if (j < matches.length) {
        out.push(
          <span className="cm-hashtag" key={`${i}-${j}`}>
            {matches[j]}
          </span>
        )
      }
    })
    return out
  })
}

/** A pinned memo living in its own always-on-top glass window, rendered as
 *  a read-only markdown card (checkboxes clickable + synced, links open in
 *  the default browser, #tags colored) — never a text editor. To change
 *  the words themselves, "⤢" hands off to the main panel. */
export default function StickerView({ memoName }: { memoName: string }): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [dot, setDot] = useState<SaveDot>('synced')
  const [saveError, setSaveError] = useState('')
  const [content, setContent] = useState('')
  const [appearance, setAppearance] = useState<EditorAppearance>(DEFAULT_APPEARANCE)

  // Mirrors `content` synchronously (state updates are async/batched; a
  // checkbox click needs the *current* source text right now, not
  // whatever `content` closed over at the last render).
  const contentRef = useRef('')
  const setContentBoth = useCallback((text: string) => {
    contentRef.current = text
    setContent(text)
  }, [])

  const savingRef = useRef(false)
  const pendingRef = useRef<{ text: string; prevText: string } | null>(null)

  // Drains one save at a time: if further toggles arrive while a PATCH is
  // in flight, they're coalesced into `pendingRef` and picked up by the
  // same in-progress call via the loop below (a plain loop rather than
  // self-recursion, so there's only ever one live async call per sticker).
  const persist = useCallback(
    async (text: string, prevText: string): Promise<void> => {
      if (savingRef.current) {
        // Coalesce rapid clicks: only the newest target text matters, but
        // keep the *earliest* prevText so a full rollback still lands on
        // truly-last-known-good content if every queued save fails.
        pendingRef.current = { text, prevText: pendingRef.current?.prevText ?? prevText }
        return
      }
      savingRef.current = true
      let curText = text
      let curPrev = prevText
      for (;;) {
        setDot('saving')
        const res = await window.memoglass.saveStickerContent(memoName, curText)
        if (res.ok) {
          setDot('synced')
          setSaveError('')
        } else {
          setDot('error')
          setSaveError(res.error ?? '保存失败')
          // Only roll back if nothing newer has landed locally in the
          // meantime (e.g. another checkbox toggled while this save was in
          // flight) — otherwise we'd stomp a more recent local edit.
          if (contentRef.current === curText) {
            setContentBoth(curPrev)
          }
        }
        if (!pendingRef.current) break
        curText = pendingRef.current.text
        curPrev = pendingRef.current.prevText
        pendingRef.current = null
      }
      savingRef.current = false
    },
    [memoName, setContentBoth]
  )

  const toggleCheckbox = useCallback(
    (idx: number) => {
      const prev = contentRef.current
      const next = toggleCheckboxAt(prev, idx)
      if (next == null) return
      setContentBoth(next)
      void persist(next, prev)
    },
    [persist, setContentBoth]
  )

  useEffect(() => {
    let cancelled = false
    window.memoglass.getMemo(memoName).then((res) => {
      if (cancelled) return
      if (res.ok && res.memo) {
        setContentBoth(res.memo.content)
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

  useEffect(() => {
    window.memoglass.getAppearance().then(setAppearance)
    return window.memoglass.onAppearanceChanged(setAppearance)
  }, [])

  const editInPanel = useCallback(() => {
    window.memoglass.editInPanel(memoName)
  }, [memoName])

  const close = useCallback(() => window.memoglass.closeSticker(), [])

  const openLink = useCallback((href: string | undefined) => {
    if (!href) return
    void window.memoglass.openExternal(href)
  }, [])

  // Fresh per render so checkbox indices always count in the current
  // document's order (react-markdown does a single synchronous parse+render
  // pass, so this closure variable behaves exactly like a document-order
  // counter — no state/ref needed, and no stale-count risk across renders).
  //
  //
  // The two disables below cover this whole block: `react/prop-types`
  // because these props are already fully typed via react-markdown's
  // `Components` return type (the rule isn't TS-aware of that here), and
  // `no-unused-vars` because `node` is destructured only to exclude it
  // from the DOM-bound `...rest` spread (ExtraProps.node isn't a valid
  // HTML attribute).
  /* eslint-disable react/prop-types, @typescript-eslint/no-unused-vars */
  const components = useMemo<Components>(() => {
    let checkboxIndex = 0
    return {
      input(props) {
        const { type, checked, node: _node, ...rest } = props
        if (type !== 'checkbox') return <input type={type} {...rest} />
        const idx = checkboxIndex++
        return (
          <input
            type="checkbox"
            className="sticker-task-checkbox"
            checked={!!checked}
            onChange={() => toggleCheckbox(idx)}
          />
        )
      },
      a({ href, children, node: _node, ...rest }) {
        return (
          <a
            {...rest}
            href={href}
            onClick={(e) => {
              e.preventDefault()
              openLink(href)
            }}
          >
            {children}
          </a>
        )
      },
      p({ children, node: _node, ...rest }) {
        return <p {...rest}>{renderTextWithTags(children)}</p>
      },
      li({ children, node: _node, ...rest }) {
        return <li {...rest}>{renderTextWithTags(children)}</li>
      }
    }
    // checkboxIndex is intentionally re-created (via the outer useMemo
    // dependency on `content`) every time the underlying document changes,
    // so a toggle never counts against a stale tree.
    // `content` isn't read directly in the body above, but it's the
    // correct dependency: it's what forces `checkboxIndex` to reset to 0
    // whenever the document (and therefore the set/order of rendered
    // checkboxes) actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, openLink, toggleCheckbox])
  /* eslint-enable react/prop-types, @typescript-eslint/no-unused-vars */

  const dotTitle =
    dot === 'error' ? saveError || '保存失败' : dot === 'saving' ? '保存中…' : '已同步'

  const isEmpty = loadState === 'ready' && content.trim() === ''

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

      {loadState === 'ready' && (
        <div className="sticker-content">
          {isEmpty ? (
            <div className="sticker-empty">(空)</div>
          ) : (
            <div className="sticker-md" style={{ fontFamily: contentFontFamily(appearance) }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}

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
