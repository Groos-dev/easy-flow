import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { openAntigravityConversation, selectAntigravityConversation } from '../server/antigravity-navigation.ts'

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const firstId = '00000000-0000-4000-8000-000000000001'
const secondId = '00000000-0000-4000-8000-000000000002'

test('legacy and invalid Antigravity IDs use manual selection', async () => {
  for (const id of ['old-identifier', '../settings', '', firstId + '?other=1']) {
    assert.equal(await openAntigravityConversation(id), 'notOpened')
  }
})

test('CDP uses the matching window, handles collapsed sessions and verifies the rendered ID', { skip: !existsSync(chrome) }, async t => {
  const browser = await chromium.launch({ executablePath: chrome })
  t.after(() => browser.close())
  const context = await browser.newContext()
  const origin = 'https://hub.test'
  const view = (id: string) => `<main data-testid="conversation-view" data-cascade-id="${id}">Conversation</main>`
  await context.route(origin + '/**', route => route.fulfill({
    contentType: 'text/html',
    body: view(route.request().url() === origin + '/c/' + secondId ? secondId : firstId),
  }))
  // Model the Hub's same-document router, and keep an unsent field mounted.
  await context.addInitScript(({ id }) => {
    const replace = history.replaceState.bind(history)
    history.replaceState = (state, title, url) => {
      replace(state, title, url)
      if (location.pathname === '/c/' + id) document.querySelector('main')?.setAttribute('data-cascade-id', id)
    }
  }, { id: secondId })
  const first = await context.newPage()
  const second = await context.newPage()
  await first.goto(origin)
  await second.goto(origin + '/c/' + secondId)
  assert.equal(await selectAntigravityConversation([first, second], secondId), true)
  assert.equal(first.url(), origin + '/')
  await second.close()
  assert.equal(await selectAntigravityConversation([first], secondId), true)
  assert.equal(first.url(), origin + '/c/' + secondId)
  // A matching route alone must never acknowledge a Pet click.
  await first.evaluate(() => { document.body.appendChild(document.createElement('textarea')).value = 'unsent' })
  const failures = await Promise.all([
    selectAntigravityConversation([first], '00000000-0000-4000-8000-000000000003'),
    selectAntigravityConversation([first], '00000000-0000-4000-8000-000000000004'),
  ])
  assert.deepEqual(failures, [false, false])
  assert.equal(first.url(), origin + '/c/' + secondId)
  assert.equal(await first.locator('textarea').inputValue(), 'unsent')
})
