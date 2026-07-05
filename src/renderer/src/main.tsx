import './assets/main.css'

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import SettingsView from './SettingsView'

// The panel and the settings window share one renderer bundle; the main
// process tells them apart via a URL hash (production: loadFile(..., { hash })
// yields '#settings'; dev: loadURL(... + '#/settings') yields '#/settings').
const isSettings = location.hash === '#/settings' || location.hash === '#settings'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isSettings ? <SettingsView /> : <App />}</React.StrictMode>
)
