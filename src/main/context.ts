import { execFile } from 'child_process'

export interface AppContext {
  appName: string
  bundleId: string
  browser?: { url: string; title: string }
}

/** Runs `cmd args…`, resolving to trimmed stdout or null on any failure/timeout.
 *  Never rejects — callers can just await + null-check. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      resolve(stdout)
    })
  })
}

/** `lsappinfo front` -> ASN token, e.g. "ASN:0x0-0x13917904:". No permission
 *  prompt required (unlike Accessibility-based frontmost detection). */
async function getFrontApp(): Promise<{ appName: string; bundleId: string } | null> {
  const asnOut = await run('lsappinfo', ['front'], 800)
  const asn = asnOut?.trim()
  if (!asn) return null

  // Real output looks like:
  //   "LSDisplayName"="Google Chrome"
  //   "CFBundleIdentifier"="com.google.Chrome"
  const infoOut = await run('lsappinfo', ['info', '-only', 'name', '-only', 'bundleid', asn], 800)
  if (!infoOut) return null

  const nameMatch = infoOut.match(/"LSDisplayName"\s*=\s*"([^"]*)"/)
  const bundleMatch = infoOut.match(/"CFBundleIdentifier"\s*=\s*"([^"]*)"/)
  if (!nameMatch || !bundleMatch) return null

  return { appName: nameMatch[1], bundleId: bundleMatch[1] }
}

// Chromium-family browsers all share the same "active tab of front window"
// AppleScript dictionary shape; Safari's dictionary differs slightly
// ("front document" instead of "active tab of front window").
const CHROMIUM_BUNDLE_IDS = new Set([
  'com.google.Chrome',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'com.vivaldi.Vivaldi',
  'company.thebrowser.Browser', // Arc
  'company.thebrowser.dia' // Dia (same vendor, Chrome-compatible dictionary)
])

/** Best-effort tab scrape via AppleScript. Silently returns undefined on any
 *  failure (unsupported app, no window, automation permission not yet
 *  granted, script error, timeout) — callers treat this as "no browser
 *  context available", never as a hard error. */
async function getBrowserTab(
  bundleId: string,
  appName: string
): Promise<{ url: string; title: string } | undefined> {
  let script: string
  if (bundleId === 'com.apple.Safari') {
    script =
      'tell application "Safari" to return (URL of front document) & "\n" & (name of front document)'
  } else if (CHROMIUM_BUNDLE_IDS.has(bundleId)) {
    script = `tell application "${appName}" to return (URL of active tab of front window) & "\n" & (title of active tab of front window)`
  } else {
    return undefined
  }

  const out = await run('osascript', ['-e', script], 1200)
  if (!out) return undefined

  const nl = out.indexOf('\n')
  if (nl < 0) return undefined
  const url = out.slice(0, nl).trim()
  const title = out.slice(nl + 1).trim()
  if (!/^https?:\/\//i.test(url)) return undefined // chrome://, about:blank, etc.

  return { url, title }
}

/** Captures a snapshot of "what the user is doing right now": the frontmost
 *  app, plus the active tab's url/title if that app is a known browser.
 *  Never throws — resolves null on any unexpected failure so callers can
 *  fire-and-forget this without a try/catch. */
export async function captureContext(): Promise<AppContext | null> {
  try {
    const front = await getFrontApp()
    if (!front) {
      console.log('[memoglass] context: no frontmost app resolved')
      return null
    }

    const ctx: AppContext = { appName: front.appName, bundleId: front.bundleId }
    const browser = await getBrowserTab(front.bundleId, front.appName)
    if (browser) ctx.browser = browser

    console.log('[memoglass] context:', JSON.stringify(ctx))
    return ctx
  } catch (err) {
    console.log('[memoglass] context: capture failed', err)
    return null
  }
}
