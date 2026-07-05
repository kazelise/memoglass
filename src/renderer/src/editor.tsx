import { useEffect, useRef } from 'react'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  MatchDecorator,
  placeholder,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { EditorSelection, EditorState, Prec, RangeSetBuilder } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'

/** Markdown highlighting tuned for text sitting on dark HUD glass. */
const glassHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700', color: 'rgba(255,255,255,0.96)' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', opacity: '0.6' },
  {
    tag: tags.monospace,
    fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
    fontSize: '13px',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderRadius: '4px',
    padding: '1px 4px'
  },
  { tag: [tags.link, tags.url], color: '#8ec9a0', textDecoration: 'underline' },
  { tag: tags.quote, color: 'rgba(255,255,255,0.55)', fontStyle: 'italic' },
  { tag: tags.processingInstruction, color: 'rgba(255,255,255,0.40)' },
  { tag: tags.meta, color: 'rgba(255,255,255,0.40)' },
  { tag: tags.contentSeparator, color: 'rgba(255,255,255,0.35)' },
  // List bullets/numbers and task-list markers ("- [ ]"/"- [x]") aren't
  // explicitly styled elsewhere; both default to tags.list/tags.atom which
  // fall back to the base .cm-content color (rgba(255,255,255,0.92)) when
  // unmatched — already readable on the glass background, kept explicit
  // here so the mapping doesn't silently drift if the grammar changes.
  { tag: tags.list, color: 'rgba(255,255,255,0.92)' },
  { tag: tags.atom, color: 'rgba(255,255,255,0.92)' }
])

const glassTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      color: 'rgba(255,255,255,0.92)',
      fontSize: '15px',
      height: '100%'
    },
    '.cm-content': {
      caretColor: '#fff',
      lineHeight: '1.65',
      padding: '0',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif'
    },
    '.cm-line': { padding: '0 2px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: '#fff', borderLeftWidth: '2px' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(107,168,122,0.35) !important'
    },
    '.cm-placeholder': { color: 'rgba(255,255,255,0.35)' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' }
  },
  { dark: true }
)

// ---------- hashtag autocomplete ----------

interface TagInfo {
  name: string
  count: number
}

/** Populated lazily from the main process; kept as module state (not React
 *  state) since it only feeds a CodeMirror completion source. */
let tagCache: TagInfo[] = []

function refreshTagCache(): void {
  window.memoglass
    .listTags()
    .then((list) => {
      tagCache = list
    })
    .catch(() => {
      // keep whatever we had; not worth surfacing to the user
    })
}

function hashtagCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/#[^\s#]*/)
  if (!word) return null
  if (word.from === word.to && !context.explicit) return null

  return {
    from: word.from + 1, // '#' stays in the document, only complete the name after it
    options: tagCache.map((t, i) => ({
      label: t.name,
      apply: `${t.name} `,
      // Ranked by usage frequency (tagCache already comes count-desc from
      // main); boost nudges CM's fuzzy-match ranking without needing exact
      // score math per candidate.
      boost: tagCache.length - i
    })),
    validFor: /^[^\s#]*$/
  }
}

// ---------- hashtag coloring ----------

const hashtagMatcher = new MatchDecorator({
  regexp: /#[^\s#,;!?()[\]{}"'`]+/g,
  decoration: () => Decoration.mark({ class: 'cm-hashtag' })
})

const hashtagColorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = hashtagMatcher.createDeco(view)
    }
    update(update: ViewUpdate): void {
      this.decorations = hashtagMatcher.updateDeco(update, this.decorations)
    }
  },
  { decorations: (v) => v.decorations }
)

// ---------- task checkbox: decoration + click-to-toggle ----------

const TASK_MARKER_RE = /^(\s*[-*+]\s)\[( |x|X)\]/

function buildTaskMarkerDeco(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      const match = TASK_MARKER_RE.exec(line.text)
      if (match) {
        const bracketStart = line.from + match[1].length
        builder.add(bracketStart, bracketStart + 3, Decoration.mark({ class: 'cm-taskmarker' }))
      }
      if (line.to >= to) break
      pos = line.to + 1
    }
  }
  return builder.finish()
}

const taskMarkerPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildTaskMarkerDeco(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildTaskMarkerDeco(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)

const taskCheckboxHandlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos == null) return false
    const line = view.state.doc.lineAt(pos)
    const match = TASK_MARKER_RE.exec(line.text)
    if (!match) return false
    const bracketStart = line.from + match[1].length
    const bracketEnd = bracketStart + 3 // "[ ]" / "[x]"
    if (pos < bracketStart || pos > bracketEnd) return false

    const checked = match[2].toLowerCase() === 'x'
    view.dispatch({
      changes: { from: bracketStart + 1, to: bracketStart + 2, insert: checked ? ' ' : 'x' }
    })
    event.preventDefault()
    return true
  }
})

// ---------- bold / italic ----------

function toggleWrap(view: EditorView, marker: string): boolean {
  const { state } = view
  const changes = state.changeByRange((range) => {
    if (range.empty) {
      const insert = marker + marker
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + marker.length)
      }
    }

    const selected = state.sliceDoc(range.from, range.to)
    const before = state.sliceDoc(Math.max(0, range.from - marker.length), range.from)
    const after = state.sliceDoc(range.to, range.to + marker.length)

    if (before === marker && after === marker) {
      // Already wrapped from the outside: strip the surrounding markers.
      return {
        changes: [
          { from: range.from - marker.length, to: range.from },
          { from: range.to, to: range.to + marker.length }
        ],
        range: EditorSelection.range(range.from - marker.length, range.to - marker.length)
      }
    }

    if (
      selected.length >= marker.length * 2 &&
      selected.startsWith(marker) &&
      selected.endsWith(marker)
    ) {
      // Selection itself includes the markers: strip from the inside.
      const inner = selected.slice(marker.length, selected.length - marker.length)
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length)
      }
    }

    return {
      changes: { from: range.from, to: range.to, insert: `${marker}${selected}${marker}` },
      range: EditorSelection.range(range.from + marker.length, range.to + marker.length)
    }
  })
  view.dispatch(changes)
  return true
}

const formattingKeymap = Prec.high(
  keymap.of([
    { key: 'Mod-b', run: (v) => toggleWrap(v, '**') },
    { key: 'Mod-i', run: (v) => toggleWrap(v, '*') }
  ])
)

interface EditorProps {
  onSave: (content: string) => void
  onEscape: () => void
  onChange: (content: string) => void
}

export interface EditorHandle {
  focus: () => void
  clear: () => void
  getContent: () => string
}

export function useGlassEditor({ onSave, onEscape, onChange }: EditorProps): {
  containerRef: React.RefObject<HTMLDivElement | null>
  handle: EditorHandle
} {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Keep latest callbacks without rebuilding the editor
  const cbRef = useRef({ onSave, onEscape, onChange })
  cbRef.current = { onSave, onEscape, onChange }

  useEffect(() => {
    if (!containerRef.current) return

    refreshTagCache()
    const offShown = window.memoglass.onShown(() => refreshTagCache())

    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          history(),
          markdown({ base: markdownLanguage }), // addKeymap defaults true → Enter continues lists/tasks (incl. exit-on-empty-item)
          syntaxHighlighting(glassHighlight),
          glassTheme,
          placeholder('随手记点什么… 支持 Markdown 和 #标签'),
          EditorView.lineWrapping,
          hashtagColorPlugin,
          taskMarkerPlugin,
          taskCheckboxHandlers,
          autocompletion({
            override: [hashtagCompletionSource],
            icons: false,
            activateOnTyping: true
          }),
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: (v) => {
                  cbRef.current.onSave(v.state.doc.toString())
                  return true
                }
              },
              {
                key: 'Escape',
                run: () => {
                  cbRef.current.onEscape()
                  return true
                }
              }
            ])
          ),
          formattingKeymap,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbRef.current.onChange(u.state.doc.toString())
          })
        ]
      }),
      parent: containerRef.current
    })
    viewRef.current = view
    return () => {
      offShown()
      view.destroy()
      viewRef.current = null
    }
  }, [])

  const handle: EditorHandle = {
    focus: () => viewRef.current?.focus(),
    clear: () => {
      const v = viewRef.current
      if (!v) return
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' } })
    },
    getContent: () => viewRef.current?.state.doc.toString() ?? ''
  }

  return { containerRef, handle }
}
