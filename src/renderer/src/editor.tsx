import { useEffect, useRef } from 'react'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

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
  { tag: tags.contentSeparator, color: 'rgba(255,255,255,0.35)' }
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
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif'
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

    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          history(),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(glassHighlight),
          glassTheme,
          placeholder('随手记点什么… 支持 Markdown 和 #标签'),
          EditorView.lineWrapping,
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
