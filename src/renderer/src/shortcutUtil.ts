/** Global-shortcut recorder helpers: browser KeyboardEvent -> Electron
 *  `accelerator` string, and accelerator -> mac-style glyph display. */

const CODE_TO_KEYPART: Record<string, string> = {
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Enter: 'Return',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`'
}

const MODIFIER_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight'
])

/** Converts a KeyboardEvent into an Electron accelerator string, or `null`
 *  if the combination isn't acceptable as a global shortcut: a bare
 *  modifier keypress, or a non-modifier key with zero modifiers held
 *  (global shortcuts can't be single printable keys — that would steal
 *  every keystroke system-wide). */
export function keyEventToAccelerator(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) return null // still just holding a modifier

  const mods: string[] = []
  if (e.metaKey) mods.push('Command')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (mods.length === 0) return null // require >= 1 modifier

  let keyPart: string | null = null
  if (e.code in CODE_TO_KEYPART) {
    keyPart = CODE_TO_KEYPART[e.code]
  } else if (/^Key[A-Z]$/.test(e.code)) {
    keyPart = e.code.slice(3) // KeyA -> A
  } else if (/^Digit[0-9]$/.test(e.code)) {
    keyPart = e.code.slice(5) // Digit1 -> 1
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) {
    keyPart = e.code // F1..F24 already match Electron's key names
  }

  if (!keyPart) return null // unrecognized/unsupported physical key
  return [...mods, keyPart].join('+')
}

const PART_TO_SYMBOL: Record<string, string> = {
  Command: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Return: '↩',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥'
}

/** Renders an accelerator string ('Alt+Space') as compact mac symbols
 *  ('⌥Space') for display in the recorder button. */
export function acceleratorToSymbol(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => PART_TO_SYMBOL[part] ?? part)
    .join('')
}
