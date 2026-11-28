/// <reference lib="dom" />
// Antigravity App 2.36, macOS. Only operate on the local Hub of an opted-in App.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Page } from 'playwright-core'

const run = promisify(execFile)
const debugPort = '19242'
const timeout = 5000
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

async function listenerExecutable(port: string): Promise<string> {
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { timeout })
  const lines = stdout.trim().split('\n')
  const listeners = lines.filter(line => line.startsWith('n'))
  const owners = lines.filter(line => /^p\d+$/.test(line))
  if (owners.length !== 1 || listeners.length !== 1 || listeners[0] !== `n127.0.0.1:${port}`) return ''
  return (await run('/bin/ps', ['-p', owners[0].slice(1), '-o', 'comm='], { timeout })).stdout.trim()
}

export type AntigravityNavigation = 'opened' | 'debugUnavailable' | 'notOpened'

// The board and mini panel may click different Pets while a previous route
// is being verified. Finish its navigation or rollback before starting another.
let lastNavigation: Promise<void> = Promise.resolve()
export function selectAntigravityConversation(pages: Page[], id: string): Promise<boolean> {
  const next = lastNavigation.then(() => selectConversation(pages, id))
  lastNavigation = next.then(() => {}, () => {})
  return next
}

// Prefer a window already showing the session, then its sidebar row. For a
// collapsed project the Hub's /c route can load it without expanding the tree.
async function selectConversation(pages: Page[], id: string): Promise<boolean> {
  if (!uuid.test(id)) return false
  const view = `[data-testid="conversation-view"][data-cascade-id="${id}"]`
  const row = `[data-testid="conversation-row-sidebar"][data-cascade-id="${id}"]`
  for (const page of pages) {
    if (await page.locator(view).first().isVisible()) {
      await page.bringToFront()
      return true
    }
  }
  let target: Page | undefined
  for (const page of pages) {
    const item = page.locator(row).first()
    if (await item.isVisible()) {
      await item.click({ timeout })
      target = page
      break
    }
  }
  if (!target) {
    // A collapsed project has no row. Keep the live document (including drafts)
    // mounted. The Hub subscribes to same-document history replacements.
    target = pages.length === 1 ? pages[0] : undefined
    if (!target) return false
    const original = target.url()
    const requested = new URL(`/c/${id}`, original).href
    const replaceRoute = ({ from, to }: { from: string; to: string }) => {
      if (location.href !== from || location.origin !== new URL(to).origin) return false
      history.replaceState(history.state, '', to)
      return true
    }
    if (!await target.evaluate(replaceRoute, { from: original, to: requested })) return false
    try {
      await target.locator(view).first().waitFor({ state: 'visible', timeout })
    } catch {
      await target.evaluate(replaceRoute, { from: requested, to: original })
      return false
    }
  } else {
    await target.locator(view).first().waitFor({ state: 'visible', timeout })
  }
  await target.bringToFront()
  return true
}

export async function openAntigravityConversation(id: string): Promise<AntigravityNavigation> {
  if (!uuid.test(id)) return 'notOpened'
  const executable = await listenerExecutable(debugPort).catch(() => '')
  const suffix = '/Antigravity.app/Contents/MacOS/Antigravity'
  if (!executable.endsWith(suffix)) return 'debugUnavailable'
  const backend = executable.slice(0, -'MacOS/Antigravity'.length) + 'Resources/bin/language_server'
  const { chromium } = await import('playwright-core')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout, noDefaults: true }).catch(() => null)
  if (!browser) return 'debugUnavailable'
  try {
    const hubs: Page[] = []
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      const url = new URL(page.url())
      if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || !url.port) continue
      if (await listenerExecutable(url.port).catch(() => '') !== backend) continue
      // Skip standalone settings, artifact and tool windows on the same origin.
      if (await page.getByTestId('conversation-list-sidebar').count() || await page.getByTestId('conversation-view').count()
          || await page.getByTestId('new-conversation-button').count()) hubs.push(page)
    }
    return await selectAntigravityConversation(hubs, id) ? 'opened' : 'notOpened'
  } catch {
    return 'notOpened'
  } finally {
    // close() on a connectOverCDP attachment disconnects this client.
    await browser.close()
  }
}
