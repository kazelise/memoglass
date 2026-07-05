import { useEffect, useState } from 'react'
import { acceleratorToSymbol, keyEventToAccelerator } from './shortcutUtil'

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
const DEFAULT_SHORTCUT = 'Alt+Space'

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

type Tab = 'appearance' | 'server' | 'shortcut'

const TABS: { id: Tab; label: string }[] = [
  { id: 'appearance', label: '外观' },
  { id: 'server', label: '服务器' },
  { id: 'shortcut', label: '快捷键' }
]

export default function SettingsView(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('appearance')

  return (
    <div className="settings-view">
      <div className="drag-strip" />
      <div className="settings-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`settings-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        className="settings-tab-body"
        style={{ display: tab === 'appearance' ? 'flex' : 'none' }}
      >
        <AppearanceTab />
      </div>
      <div className="settings-tab-body" style={{ display: tab === 'server' ? 'flex' : 'none' }}>
        <ServerTab />
      </div>
      <div className="settings-tab-body" style={{ display: tab === 'shortcut' ? 'flex' : 'none' }}>
        <ShortcutTab />
      </div>
    </div>
  )
}

// ---------- 外观 ----------

function AppearanceTab(): React.JSX.Element {
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

  if (!loaded) return <div className="settings-tab-body" />

  const selectValue = customMode ? CUSTOM_VALUE : appearance.fontFamily

  return (
    <>
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
    </>
  )
}

// ---------- 服务器 ----------

const SOURCE_LABEL: Record<string, string> = {
  user: '手动配置',
  dev: '开发回退',
  none: '未配置'
}

function ServerTab(): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [currentUrl, setCurrentUrl] = useState('')
  const [source, setSource] = useState('none')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const refresh = (): void => {
    window.memoglass.getConfig().then((cfg) => {
      setCurrentUrl(cfg.serverUrl)
      setSource(cfg.source)
      setUrl(cfg.serverUrl)
      setLoaded(true)
    })
  }

  useEffect(refresh, [])

  const submit = async (): Promise<void> => {
    const trimmedUrl = url.trim()
    const trimmedToken = token.trim()
    if (!trimmedUrl) return
    setBusy(true)
    setResult(null)
    const res = trimmedToken
      ? await window.memoglass.setConfig(trimmedUrl, trimmedToken)
      : await window.memoglass.setServerUrl(trimmedUrl)
    setBusy(false)
    if (res.ok) {
      setResult({ ok: true, message: '已连接 ✓' })
      setToken('')
      refresh()
    } else {
      setResult({ ok: false, message: res.error ?? '验证失败' })
    }
  }

  if (!loaded) return <div className="settings-tab-body" />

  return (
    <>
      <div className="settings-row settings-status-row">
        <label>当前</label>
        <div className="settings-field">
          <span className="settings-current-url">{currentUrl || '（未配置）'}</span>
          <span className={`settings-source-badge settings-source-${source}`}>
            {SOURCE_LABEL[source] ?? source}
          </span>
        </div>
      </div>

      <div className="settings-row">
        <label>地址</label>
        <div className="settings-field">
          <input
            className="settings-text-input"
            placeholder="https://memos.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="settings-row">
        <label>Token</label>
        <div className="settings-field">
          <input
            className="settings-text-input"
            type="password"
            placeholder="留空保持不变"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
      </div>

      <div className="settings-row settings-actions-row">
        <label />
        <div className="settings-field settings-actions-field">
          <button className="save-btn enabled" onClick={submit} disabled={busy || !url.trim()}>
            {busy ? '验证中…' : '测试并保存'}
          </button>
          {result && (
            <span className={result.ok ? 'settings-success-text' : 'error-text'}>
              {result.message}
            </span>
          )}
        </div>
      </div>
    </>
  )
}

// ---------- 快捷键 ----------

function ShortcutTab(): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [accelerator, setAccelerator] = useState(DEFAULT_SHORTCUT)
  const [recording, setRecording] = useState(false)
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const refresh = (): void => {
    window.memoglass.getShortcut().then((s) => {
      setAccelerator(s.accelerator || DEFAULT_SHORTCUT)
      setLoaded(true)
    })
  }

  useEffect(refresh, [])

  const apply = async (acc: string): Promise<void> => {
    setBusy(true)
    setResult(null)
    const res = await window.memoglass.setShortcut(acc)
    setBusy(false)
    if (res.ok) {
      setAccelerator(acc)
      setResult({ ok: true, message: '已生效 ✓' })
    } else {
      setResult({ ok: false, message: res.error ?? '设置失败' })
    }
  }

  // Recording session: captures the next valid modifier+key combo on
  // keydown (showing a live preview) and commits it on keyup. Escape
  // cancels without changing anything.
  useEffect(() => {
    if (!recording) return

    let pending: string | null = null

    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      if (e.code === 'Escape') {
        setRecording(false)
        setPreview('')
        pending = null
        return
      }
      const acc = keyEventToAccelerator(e)
      if (acc) {
        pending = acc
        setPreview(acc)
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (pending) {
        const acc = pending
        pending = null
        setRecording(false)
        setPreview('')
        void apply(acc)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [recording])

  if (!loaded) return <div className="settings-tab-body" />

  return (
    <>
      <div className="settings-row">
        <label>热键</label>
        <div className="settings-field">
          <button
            type="button"
            className={`shortcut-recorder${recording ? ' recording' : ''}`}
            onClick={() => {
              setResult(null)
              setPreview('')
              setRecording((v) => !v)
            }}
          >
            {recording ? preview || '按下新快捷键…' : acceleratorToSymbol(accelerator)}
          </button>
          {recording && <span className="settings-hint-inline">Esc 取消</span>}
          {!recording && (
            <button
              type="button"
              className="shortcut-reset-btn"
              disabled={busy || accelerator === DEFAULT_SHORTCUT}
              onClick={() => void apply(DEFAULT_SHORTCUT)}
            >
              恢复默认
            </button>
          )}
        </div>
      </div>

      {result && (
        <div className="settings-row">
          <label />
          <div className="settings-field">
            <span className={result.ok ? 'settings-success-text' : 'error-text'}>
              {result.message}
            </span>
          </div>
        </div>
      )}

      <p className="settings-hint">全局唤起/隐藏面板</p>
    </>
  )
}
