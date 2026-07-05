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
import { Compartment, EditorSelection, EditorState, Prec, RangeSetBuilder } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'

/** Adaptive palette: vibrancy glass follows the system appearance, so the
 *  editor colors must follow too. Light = warm ink (Warm Parchment lineage),
 *  dark = bright text on HUD glass. */
interface GlassPalette {
  text: string
  heading: string
  faint: string
  marker: string
  quote: string
  codeBg: string
  link: string
  cursor: string
  selection: string
  placeholder: string
}

const LIGHT: GlassPalette = {
  text: 'rgba(46,43,40,0.90)',
  heading: 'rgba(30,28,26,0.96)',
  faint: 'rgba(64,58,52,0.35)',
  marker: 'rgba(64,58,52,0.40)',
  quote: 'rgba(64,58,52,0.60)',
  codeBg: 'rgba(0,0,0,0.06)',
  link: '#356246',
  cursor: '#2e2b28',
  selection: 'rgba(74,124,89,0.22)',
  placeholder: 'rgba(64,58,52,0.35)'
}

const DARK: GlassPalette = {
  text: 'rgba(255,255,255,0.92)',
  heading: 'rgba(255,255,255,0.96)',
  faint: 'rgba(255,255,255,0.35)',
  marker: 'rgba(255,255,255,0.40)',
  quote: 'rgba(255,255,255,0.55)',
  codeBg: 'rgba(255,255,255,0.10)',
  link: '#8ec9a0',
  cursor: '#ffffff',
  selection: 'rgba(107,168,122,0.35)',
  placeholder: 'rgba(255,255,255,0.35)'
}

function makeHighlight(p: GlassPalette): HighlightStyle {
  return HighlightStyle.define([
    { tag: tags.heading, fontWeight: '700', color: p.heading },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through', opacity: '0.6' },
    {
      tag: tags.monospace,
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: '13px',
      backgroundColor: p.codeBg,
      borderRadius: '4px',
      padding: '1px 4px'
    },
    { tag: [tags.link, tags.url], color: p.link, textDecoration: 'underline' },
    { tag: tags.quote, color: p.quote, fontStyle: 'italic' },
    { tag: tags.processingInstruction, color: p.marker },
    { tag: tags.meta, color: p.marker },
    { tag: tags.contentSeparator, color: p.faint },
    { tag: tags.list, color: p.text },
    { tag: tags.atom, color: p.text }
  ])
}

/** Font/size/line-height, mirrors the shape of preload's AppearanceConfig
 *  (kept local to avoid a renderer -> preload type dependency). */
interface EditorAppearance {
  fontFamily: string
  cjkFontFamily: string
  fontSize: number
  lineHeight: number
}

const DEFAULT_APPEARANCE: EditorAppearance = {
  fontFamily: 'system',
  cjkFontFamily: 'system',
  fontSize: 15,
  lineHeight: 1.65
}

const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif'

/** Font stack with glyph-based fallback: latin glyphs resolve in the primary
 *  font; CJK glyphs (missing from most latin fonts) fall through to the CJK
 *  choice, then the system stack. */
function contentFontFamily(appearance: EditorAppearance): string {
  const parts: string[] = []
  if (appearance.fontFamily !== 'system') parts.push(`"${appearance.fontFamily}"`)
  if (appearance.cjkFontFamily !== 'system') parts.push(`"${appearance.cjkFontFamily}"`)
  parts.push(SYSTEM_FONT_STACK)
  return parts.join(', ')
}

function makeTheme(
  p: GlassPalette,
  dark: boolean,
  appearance: EditorAppearance
): ReturnType<typeof EditorView.theme> {
  return EditorView.theme(
    {
      '&': {
        backgroundColor: 'transparent',
        color: p.text,
        fontSize: `${appearance.fontSize}px`,
        height: '100%'
      },
      '.cm-content': {
        caretColor: p.cursor,
        lineHeight: String(appearance.lineHeight),
        padding: '0',
        fontFamily: contentFontFamily(appearance)
      },
      '.cm-line': { padding: '0 2px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-cursor': { borderLeftColor: p.cursor, borderLeftWidth: '2px' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: `${p.selection} !important`
      },
      '.cm-placeholder': { color: p.placeholder },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' }
    },
    { dark }
  )
}

const themeCompartment = new Compartment()

function glassAppearance(
  dark: boolean,
  appearance: EditorAppearance
): ReturnType<typeof EditorView.theme>[] {
  const p = dark ? DARK : LIGHT
  return [makeTheme(p, dark, appearance), syntaxHighlighting(makeHighlight(p))]
}

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
  onSwitcher: () => void
}

export interface EditorHandle {
  focus: () => void
  clear: () => void
  getContent: () => string
  setContent: (text: string) => void
}

export function useGlassEditor({ onSave, onEscape, onChange, onSwitcher }: EditorProps): {
  containerRef: React.RefObject<HTMLDivElement | null>
  handle: EditorHandle
} {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Keep latest callbacks without rebuilding the editor
  const cbRef = useRef({ onSave, onEscape, onChange, onSwitcher })
  cbRef.current = { onSave, onEscape, onChange, onSwitcher }

  useEffect(() => {
    if (!containerRef.current) return

    refreshTagCache()
    const offShown = window.memoglass.onShown(() => refreshTagCache())
    const darkMq = window.matchMedia('(prefers-color-scheme: dark)')

    // Both the OS appearance and the user's font/size/line-height settings can
    // change independently at runtime; track the latest of each so either
    // listener can reconfigure the theme with a complete, up-to-date pair.
    let currentDark = darkMq.matches
    let currentAppearance = DEFAULT_APPEARANCE

    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          history(),
          markdown({ base: markdownLanguage }), // addKeymap defaults true → Enter continues lists/tasks (incl. exit-on-empty-item)
          themeCompartment.of(glassAppearance(currentDark, currentAppearance)),
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
              },
              {
                key: 'Mod-p',
                run: () => {
                  cbRef.current.onSwitcher()
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

    const reconfigureTheme = (): void => {
      view.dispatch({
        effects: themeCompartment.reconfigure(glassAppearance(currentDark, currentAppearance))
      })
    }

    const onSchemeChange = (e: MediaQueryListEvent): void => {
      currentDark = e.matches
      reconfigureTheme()
    }
    darkMq.addEventListener('change', onSchemeChange)

    window.memoglass.getAppearance().then((a) => {
      currentAppearance = a
      reconfigureTheme()
    })
    const offAppearance = window.memoglass.onAppearanceChanged((a) => {
      currentAppearance = a
      reconfigureTheme()
    })

    return () => {
      offShown()
      offAppearance()
      darkMq.removeEventListener('change', onSchemeChange)
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
    getContent: () => viewRef.current?.state.doc.toString() ?? '',
    setContent: (text: string) => {
      const v = viewRef.current
      if (!v) return
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: text },
        selection: EditorSelection.cursor(text.length)
      })
    }
  }

  return { containerRef, handle }
}
