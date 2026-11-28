import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentId, SESSION_STATES } from '../src/shared/domain.ts'
import { agentLabel, workspaceOpenArgs, workspaceOpenHint, workspaceOpenNotice } from '../src/shared/agents.ts'
import { Language, setLanguage } from '../src/shared/i18n.ts'
import { petArt, type IdleMood } from '../src/renderer/src/lib/pet-art.ts'
import type { Pose } from '../src/renderer/src/lib/pets.ts'
import LaunchSessionForm from '../src/renderer/src/components/LaunchSessionForm.tsx'
import { AgentIcon } from '../src/renderer/src/components/icons.tsx'
import { launchPrompt } from '../server/launch.ts'
import { scanOpenTargets } from '../server/open-with.ts'

test('All Antigravity poses and idle moods have independent large, compact and paused assets', () => {
  const poses = SESSION_STATES.filter((state): state is Pose => state !== 'unknown')
  const moods: IdleMood[] = ['awake', 'yawning', 'dozing', 'collapsing', 'sleeping']
  for (const state of poses) for (const compact of [false, true]) for (const mood of moods) {
    const art = petArt('antigravity', state, { compact, mood })
    assert.equal(art.channel, 'img')
    if (art.channel !== 'img') continue
    assert.match(art.src, /^pets\/antigravity-/)
    const path = join(process.cwd(), 'src/renderer/public', art.src)
    assert.ok(existsSync(path), path)
    const source = readFileSync(path, 'utf8')
    assert.match(source, /<svg /)
    assert.doesNotMatch(source, /<script\b/)
    const still = readFileSync(path.replace('/pets/', '/pets/still/'), 'utf8')
    assert.match(still, /animation:none!important/)
  }
})

test('Every supported agent has a brand label, and Antigravity uses the official SVG', () => {
  for (const id of Object.values(AgentId)) assert.notEqual(agentLabel(id), id)
  const markup = renderToStaticMarkup(createElement(AgentIcon, { agent: 'antigravity', size: 18 }))
  assert.match(markup, /src="agents\/antigravity\.svg"/)
  assert.ok(existsSync('src/renderer/public/agents/antigravity.svg'))
  assert.ok(existsSync('src/renderer/public/agents/antigravity.png'))
})

test('The App handoff does not falsely claim automatic workspace selection', () => {
  assert.deepEqual(workspaceOpenArgs('antigravity', '/repo/a b'), ['-a', 'Antigravity'])
  assert.deepEqual(workspaceOpenArgs('cursor', '/repo/a b'), ['-a', 'Cursor', '/repo/a b'])
  assert.deepEqual(workspaceOpenArgs('unknown', '/repo'), [])
  assert.match(workspaceOpenHint({ agent: 'antigravity', session: 'conversation', cwd: '/repo/a b' }), /conversation/)
  const prompt = launchPrompt({ agent: 'antigravity', requirementId: 'req-x', worktreeId: 'wt-x', worktreePath: '/repo/a b', requirementWorktreePaths: ['/repo/a b'] })
  assert.match(prompt, /\/repo\/a b/)
  assert.match(prompt, /ANTIGRAVITY_CONVERSATION_ID/)
  assert.match(prompt, /--agent antigravity/)
})

test('Prefill feedback asks the user to review and send in each language', () => {
  for (const lang of [Language.English, Language.Chinese]) {
    setLanguage(lang)
    const markup = renderToStaticMarkup(createElement(LaunchSessionForm, {
      requirementId: 'req-x', worktrees: [], providers: [{ id: 'antigravity', label: 'Antigravity', requiresWorktree: true }],
      worktreeId: '', agent: 'antigravity', loading: false, providerError: '', requestError: '', busy: false,
      result: { agent: 'antigravity', url: '', opened: true, promptCopied: false, prompt: 'Recoverable handoff prompt', worktreePath: '/repo/a b' },
      onWorktreeChange: () => {}, onAgentChange: () => {}, onLaunch: () => {},
    }))
    assert.match(markup, /\/repo\/a b/)
    assert.match(markup, lang === Language.English ? /check that the selected Antigravity project/ : /确认 Antigravity 当前项目的目录/)
    assert.match(markup, lang === Language.English ? /View the full prompt/ : /看提示词原文/)
    for (const navigation of ['debugUnavailable', 'notOpened'] as const) {
      const notice = workspaceOpenNotice({ navigation, manualWorkspaceSelection: true, path: '/missing', workspaceExists: false })
      assert.match(notice, /\/missing/)
      assert.match(notice, lang === Language.English ? /unavailable/ : /不可用/)
    }
    assert.match(markup, lang === Language.English ? /Review the prefilled prompt/ : /确认预填的提示词/)
  }
  setLanguage(Language.Chinese)
})

test('The App is not advertised as a file editor when it has no open-file handler', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'easy-flow-agy-open-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'Antigravity.app'))
  assert.deepEqual(scanOpenTargets([dir]), [])
})
