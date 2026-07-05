import './assets/main.css'

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import SettingsView from './SettingsView'
import StickerView from './StickerView'

// The panel, settings window, and sticker windows all share one renderer
// bundle; the main process tells them apart via a URL hash (production:
// loadFile(..., { hash }) yields '#settings'/'#sticker?...'; dev:
// loadURL(... + '#/settings') yields '#/settings'/'#/sticker?...').
const hash = location.hash
const isSettings = hash === '#/settings' || hash === '#settings'
const stickerMatch = hash.match(/^#\/?sticker\?(.*)$/)

function render(): React.JSX.Element {
  if (isSettings) return <SettingsView />
  if (stickerMatch) {
    const params = new URLSearchParams(stickerMatch[1])
    const memoName = params.get('name') ?? ''
    return <StickerView memoName={memoName} />
  }
  return <App />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{render()}</React.StrictMode>
)
