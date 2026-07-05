import { useEffect, useState } from 'react'

interface AppearanceConfig {
  fontFamily: string
  fontSize: number
  lineHeight: number
}

const DEFAULT_APPEARANCE: AppearanceConfig = {
  fontFamily: 'system',
  fontSize: 15,
  lineHeight: 1.65
}

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'System', value: 'system' },
  { label: 'LXGW WenKai', value: 'LXGW WenKai' },
  { label: 'PingFang SC', value: 'PingFang SC' },
  { label: 'Songti SC', value: 'Songti SC' },
  { label: 'Kaiti SC', value: 'Kaiti SC' },
  { label: 'SF Mono', value: 'SF Mono' },
  { label: 'Menlo', value: 'Menlo' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono' }
]

const CUSTOM_VALUE = '__custom__'

const FONT_STACK_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif'

function isFontAvailable(name: string): boolean {
  if (name === 'system') return true
  try {
    return document.fonts.check(`12px "${name}"`)
  } catch {
    return true // detection failed for some reason; don't block the option on it
  }
}

function previewFontFamily(fontFamily: string): string {
  return fontFamily === 'system' ? FONT_STACK_FALLBACK : `"${fontFamily}", ${FONT_STACK_FALLBACK}`
}

export default function SettingsView(): React.JSX.Element {
  const [appearance, setAppearanceState] = useState<AppearanceConfig>(DEFAULT_APPEARANCE)
  const [loaded, setLoaded] = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [customText, setCustomText] = useState('')

  useEffect(() => {
    window.memoglass.getAppearance().then((a) => {
      setAppearanceState(a)
      const known = FONT_OPTIONS.some((f) => f.value === a.fontFamily)
      if (!known) {
        setCustomMode(true)
        setCustomText(a.fontFamily)
      }
      setLoaded(true)
    })
    const off = window.memoglass.onAppearanceChanged((a) => setAppearanceState(a))
    return off
  }, [])

  const apply = (next: AppearanceConfig): void => {
    setAppearanceState(next)
    window.memoglass.setAppearance(next)
  }

  if (!loaded) return <div className="settings-view" />

  const selectValue = customMode ? CUSTOM_VALUE : appearance.fontFamily

  return (
    <div className="settings-view">
      <div className="drag-strip" />
      <h2>外观</h2>

      <div className="settings-row">
        <label>字体</label>
        <div className="settings-field">
          <select
            value={selectValue}
            onChange={(e) => {
              const v = e.target.value
              if (v === CUSTOM_VALUE) {
                setCustomMode(true)
                return
              }
              setCustomMode(false)
              apply({ ...appearance, fontFamily: v })
            }}
          >
            {FONT_OPTIONS.map((f) => {
              const available = isFontAvailable(f.value)
              return (
                <option key={f.value} value={f.value} disabled={!available}>
                  {f.label}
                  {available ? '' : '（未安装）'}
                </option>
              )
            })}
            <option value={CUSTOM_VALUE}>自定义…</option>
          </select>
          {customMode && (
            <input
              className="settings-custom-font"
              placeholder="字体名称"
              value={customText}
              onChange={(e) => {
                setCustomText(e.target.value)
                apply({ ...appearance, fontFamily: e.target.value || 'system' })
              }}
            />
          )}
        </div>
      </div>

      <div className="settings-row">
        <label>字号</label>
        <div className="settings-field">
          <input
            type="range"
            min={13}
            max={20}
            step={0.5}
            value={appearance.fontSize}
            onChange={(e) => apply({ ...appearance, fontSize: Number(e.target.value) })}
          />
          <span className="settings-value">{appearance.fontSize}px</span>
        </div>
      </div>

      <div className="settings-row">
        <label>行高</label>
        <div className="settings-field">
          <input
            type="range"
            min={1.4}
            max={2.0}
            step={0.05}
            value={appearance.lineHeight}
            onChange={(e) => apply({ ...appearance, lineHeight: Number(e.target.value) })}
          />
          <span className="settings-value">{appearance.lineHeight.toFixed(2)}</span>
        </div>
      </div>

      <div
        className="settings-preview"
        style={{
          fontFamily: previewFontFamily(appearance.fontFamily),
          fontSize: `${appearance.fontSize}px`,
          lineHeight: appearance.lineHeight
        }}
      >
        字体预览 AaBb 123 #标签
      </div>
    </div>
  )
}
