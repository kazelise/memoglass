# memoglass

A Spotlight-style floating capture panel for self-hosted [Memos](https://usememos.com/), for macOS.

Hit a hotkey, jot something down, get back to what you were doing. No window to find, no tab to switch to — just a glass panel that appears wherever your cursor is and disappears the moment you're done.

<!-- screenshot -->

## Features

- **⌥Space anywhere** — a translucent NSPanel appears centered on your active screen, without stealing focus or showing up in the Dock/Cmd-Tab
- **Markdown editor** with live preview styling, `#tag` autocomplete, and list/task continuation
- **⌘P memo switcher** to jump into and edit any recent memo without leaving the panel
- **Drag-and-drop attachments** (images, files) with inline previews
- **Comments** on memos, right from the panel
- **Offline queue** — if the server's unreachable when you save, the memo is queued locally and retried automatically once it's back
- **Context-aware capture** — knows which app (and, for browsers, which tab/URL) was frontmost when you invoked it
- **Menu bar residency** — lives in the tray, with an optional "launch at login"
- **Configurable appearance** (font, size, line height) and global shortcut, via a small settings window
- **Multiple vibrancy materials** to match your desktop (HUD, sidebar, popover, ...)

## Install

Grab the `.dmg` from [Releases](../../releases).

Builds are **unsigned** (no Apple Developer certificate). macOS Gatekeeper will refuse to open the app with a plain double-click. Either:

- Right-click the app in `/Applications` → **Open** → **Open** again in the dialog, or
- Run: `xattr -cr /Applications/memoglass.app`

## Setup

On first launch, open the tray icon menu → **设置…** (Settings) and enter:

- Your Memos server URL (e.g. `https://memos.example.com`)
- A [Personal Access Token](https://www.usememos.com/docs) for that server

Tested against Memos **v0.27–v0.29**.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌥Space` | Show / hide the panel |
| `⌘↩` | Save memo |
| `⌘P` | Open memo switcher |
| `⌘B` | Bold selection |
| `⌘I` | Italic selection |
| `Esc` | Dismiss panel / switcher |

The global shortcut is configurable in Settings.

## Development

```bash
npm install
npm run dev
```

Build a `.dmg`:

```bash
npm run build:mac
```

## License

MIT
