/** 快捷键匹配、输入守卫与键位表自身的回归 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SHORTCUTS,
  isComposing,
  isEditableTarget,
  isPetTarget,
  matches,
  shortcut,
  shortcutLabel,
  type KeyEventLike,
} from '../src/renderer/src/lib/keys.ts'

function key(keyName: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key: keyName,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  }
}

describe('accelerator 匹配', () => {
  test('⌘K 命中，⌘⇧K 不误中', () => {
    assert.equal(matches(key('k', { metaKey: true }), 'CommandOrControl+K', 'darwin'), true)
    assert.equal(
      matches(key('k', { metaKey: true, shiftKey: true }), 'CommandOrControl+K', 'darwin'),
      false,
    )
    assert.equal(
      matches(
        key('K', { metaKey: true, shiftKey: true }),
        'CommandOrControl+Shift+K',
        'darwin',
      ),
      true,
    )
  })

  test('非 mac 上 CommandOrControl 落到 Ctrl', () => {
    assert.equal(matches(key('k', { ctrlKey: true }), 'CommandOrControl+K', 'win32'), true)
    assert.equal(matches(key('k', { metaKey: true }), 'CommandOrControl+K', 'win32'), false)
  })

  test('字母、方向键、Esc、空格与 + 都能认', () => {
    assert.equal(matches(key('j'), 'J', 'darwin'), true)
    assert.equal(matches(key('J'), 'J', 'darwin'), true)
    assert.equal(matches(key('ArrowDown'), 'ArrowDown', 'darwin'), true)
    assert.equal(matches(key('Escape'), 'Escape', 'darwin'), true)
    assert.equal(matches(key(' '), 'Space', 'darwin'), true)
    assert.equal(matches(key('+', { shiftKey: true }), '+', 'darwin'), true)
    assert.equal(matches(key('-'), '-', 'darwin'), true)
  })

  test('⌘⇧[ 在键盘上出的是 { 也能认', () => {
    assert.equal(
      matches(key('{', { metaKey: true, shiftKey: true }), 'CommandOrControl+Shift+[', 'darwin'),
      true,
    )
  })

  test('⌥⌘C 被 Option 改成 ç 时按物理键认', () => {
    assert.equal(
      matches(
        key('ç', { metaKey: true, altKey: true, code: 'KeyC' }),
        'CommandOrControl+Alt+C',
        'darwin',
      ),
      true,
    )
  })

  test('多按一个修饰键不算命中', () => {
    assert.equal(
      matches(
        key('k', { metaKey: true, ctrlKey: true }),
        'CommandOrControl+K',
        'darwin',
      ),
      false,
    )
  })
})

describe('输入守卫', () => {
  const target = (props: Record<string, unknown>) => props as unknown as EventTarget

  test('输入框、文本域、contenteditable、CodeMirror 都算可编辑', () => {
    assert.equal(isEditableTarget(target({ tagName: 'INPUT' })), true)
    assert.equal(isEditableTarget(target({ tagName: 'TEXTAREA' })), true)
    assert.equal(isEditableTarget(target({ tagName: 'DIV', isContentEditable: true })), true)
    assert.equal(
      isEditableTarget(target({ tagName: 'DIV', closest: (sel: string) => (sel.includes('.cm-editor') ? {} : null) })),
      true,
    )
  })

  test('普通卡片与按钮不算可编辑', () => {
    assert.equal(isEditableTarget(target({ tagName: 'DIV' })), false)
    assert.equal(isEditableTarget(target({ tagName: 'BUTTON' })), false)
    assert.equal(isEditableTarget(null), false)
  })

  test('输入法组合中的按键不算快捷键', () => {
    assert.equal(isComposing({ isComposing: true }), true)
    assert.equal(isComposing({ keyCode: 229 }), true)
    assert.equal(isComposing({ isComposing: false, keyCode: 74 }), false)
  })

  test('卡片里的 agent 头像认得出：看板单键要让位给它', () => {
    const inSlot = target({ tagName: 'DIV', closest: (sel: string) => (sel === '.slot' ? {} : null) })
    assert.equal(isPetTarget(inSlot), true)
    assert.equal(isPetTarget(target({ tagName: 'DIV', closest: () => null })), false)
    assert.equal(isPetTarget(null), false)
  })
})

describe('键位表', () => {
  test('同一上下文内没有重复组合键', () => {
    const seen = new Map<string, Set<string>>()
    for (const s of SHORTCUTS) {
      const keys = seen.get(s.context) ?? new Set<string>()
      for (const k of s.keys) {
        assert.equal(keys.has(k), false, `${s.context} 里 ${k} 重复了（${s.label}）`)
        keys.add(k)
      }
      seen.set(s.context, keys)
    }
  })

  test('id 唯一且可反查', () => {
    const ids = new Set<string>()
    for (const s of SHORTCUTS) {
      assert.ok(s.id.includes('.'), `${s.label} 的 id 没带上下文前缀`)
      assert.equal(ids.has(s.id), false, `id 重复：${s.id}`)
      ids.add(s.id)
    }
    assert.equal(shortcut(key('j'), 'board.next', 'darwin'), true)
    assert.equal(shortcut(key('k', { metaKey: true }), 'global.search', 'darwin'), true)
    assert.equal(shortcut(key('k', { metaKey: true }), 'board.next', 'darwin'), false)
    assert.equal(shortcut(key('j'), 'info.next', 'darwin'), true)
    assert.equal(shortcut(key('ArrowUp'), 'info.prev', 'darwin'), true)
    assert.equal(shortcut(key('j', { altKey: true }), 'info.next', 'darwin'), false)
    assert.equal(
      shortcut(key('{', { metaKey: true, shiftKey: true }), 'detail.tab-prev', 'darwin'),
      true,
    )
    assert.equal(shortcutLabel('board.next', 'darwin'), 'J / ↓')
    assert.equal(shortcutLabel('detail.tab-n', 'darwin'), '⌘1..9')
  })

  test('agent 头像那一组：Tab 停下、回车回会话、Esc 回卡片', () => {
    assert.equal(shortcut(key('Tab'), 'pet.focus', 'darwin'), true)
    assert.equal(shortcut(key('Enter'), 'pet.open', 'darwin'), true)
    assert.equal(shortcut(key('Escape'), 'pet.back', 'darwin'), true)
    // 头像自成一组：看板上同一个回车仍旧是「打开选中需求」
    assert.equal(shortcut(key('Enter'), 'board.open', 'darwin'), true)
  })

  test('每个动作都有键和文案', () => {
    for (const s of SHORTCUTS) {
      assert.ok(s.keys.length > 0, `${s.context} 有空键位`)
      assert.ok(s.label.trim().length > 0, `${s.context} 有空文案`)
    }
  })
})
