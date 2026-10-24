/**
 * 详情页「所见即所得」渲染层的回归。
 *
 * 渲染规则是纯函数（渲染层），输入是 md 与选区、输出是装饰集，所以这里直接断言
 * 哪些记号被收起来、哪些样式挂在哪些字上，不必起服务、也不必碰 DOM。
 * 断言的是装饰集本身——widget 长什么样由 CSS 决定，这里只管它替换掉了哪段原文。
 *
 * 运行：pnpm test
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { focusEffect, liveDecorations, livePreview } from '../src/renderer/src/lib/markdown-live.ts'

interface Spec {
  class?: string
  widget?: unknown
}

/**
 * 与编辑器同款的 state：语言 + 渲染扩展。focusEffect 就是编辑器在 focusin 时发的那个，
 * 默认按「已经聚焦」喂，照编辑器里的样子走。
 */
function stateOf(doc: string, anchor: number, isFocused = true): EditorState {
  const base = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ base: markdownLanguage }), livePreview],
  })
  return isFocused ? base.update({ effects: focusEffect.of(true) }).state : base
}

function specOf(value: unknown): Spec {
  return ((value as { spec?: Spec }).spec ?? {}) as Spec
}

// 被收起来的记号（不带 widget 的 replace）
function hiddenText(state: EditorState): string[] {
  const out: string[] = []
  liveDecorations(state).between(0, state.doc.length, (from, to, v) => {
    const spec = specOf(v)
    if (from < to && !spec.class && !('widget' in spec)) out.push(state.sliceDoc(from, to))
  })
  return out
}

// 被替换成 widget 的原文（方框、圆点、分割线）
function widgetText(state: EditorState): string[] {
  const out: string[] = []
  liveDecorations(state).between(0, state.doc.length, (from, to, v) => {
    if ('widget' in specOf(v)) out.push(state.sliceDoc(from, to))
  })
  return out
}

// 挂了某个 mark 样式的字
function markedText(state: EditorState, cls: string): string[] {
  const out: string[] = []
  liveDecorations(state).between(0, state.doc.length, (from, to, v) => {
    if (specOf(v).class === cls && from < to) out.push(state.sliceDoc(from, to))
  })
  return out
}

// 挂了某个行样式的行号
function markedLines(state: EditorState, cls: string): number[] {
  const out: number[] = []
  liveDecorations(state).between(0, state.doc.length, (from, _to, v) => {
    if (specOf(v).class === cls) out.push(state.doc.lineAt(from).number)
  })
  return out
}

describe('记号收起：光标不在的行显渲染结果', () => {
  const doc = '# 标题\n\n正文 **粗** 与 `码`\n'

  test('标题号、强调号、行内反引号都收起来', () => {
    assert.deepEqual(hiddenText(stateOf(doc, doc.length)), ['#', '**', '**', '`', '`'])
  })

  test('光标所在的那一行显原文，同一行的记号不收', () => {
    // 光标停在标题行：这一行的 `#` 留着，别的行照旧收
    assert.deepEqual(hiddenText(stateOf(doc, 2)), ['**', '**', '`', '`'])
  })

  test('焦点不在编辑器里：整篇都按渲染结果画', () => {
    // 刚打开一篇时光标停在第 1 行，但那不是「人在这一行改」，不该露出 `#`
    assert.deepEqual(hiddenText(stateOf(doc, 2, false)), ['#', '**', '**', '`', '`'])
  })

  test('渲染出来的字带样式：加粗、行内码、标题行', () => {
    const state = stateOf(doc, doc.length)
    assert.deepEqual(markedText(state, 'cm-md-strong'), ['**粗**'])
    assert.deepEqual(markedText(state, 'cm-md-code'), ['`码`'])
    assert.deepEqual(markedLines(state, 'cm-md-h1'), [1])
  })
})

describe('链接与图片', () => {
  const link = '[链](https://a.b)\n'

  test('渲染态只留文字，链接地址收起来', () => {
    assert.deepEqual(hiddenText(stateOf(link, link.length)), ['[', ']', '(', 'https://a.b', ')'])
    assert.deepEqual(markedText(stateOf(link, link.length), 'cm-md-link'), ['[链](https://a.b)'])
  })

  test('图片同理：`![`、`](` 与地址都收起来，只留说明文字', () => {
    const img = '![图](a.png)\n'
    assert.deepEqual(hiddenText(stateOf(img, img.length)), ['![', ']', '(', 'a.png', ')'])
  })

  test('自动链接自己就是文字，留着', () => {
    const state = stateOf('见 https://a.b\n', 11)
    assert.deepEqual(hiddenText(state), [])
    assert.deepEqual(markedText(state, 'cm-md-link'), ['https://a.b'])
  })
})

describe('列表与任务项', () => {
  test('无序列表的 `-` 换成圆点', () => {
    assert.deepEqual(widgetText(stateOf('- 甲\n- 乙\n', 8)), ['-', '-'])
  })

  test('任务项的方框也是替换出来的，两个状态都认', () => {
    const doc = '- [ ] 甲\n- [x] 乙\n'
    // 两个圆点 + 两个方框，都是替换出来的
    assert.deepEqual(widgetText(stateOf(doc, doc.length)), ['-', '[ ]', '-', '[x]'])
  })

  test('有序列表的编号是内容，不收', () => {
    const state = stateOf('1. 甲\n2. 乙\n', 10)
    assert.deepEqual(hiddenText(state), [])
    assert.deepEqual(markedText(state, 'cm-md-ordered'), ['1.', '2.'])
  })

  test('光标停在任务项那一行：圆点与方框都让位给原文', () => {
    assert.deepEqual(widgetText(stateOf('- [ ] 甲\n- [x] 乙\n', 4)), ['-', '[x]'])
  })
})

describe('代码块与分割线', () => {
  const doc = '```js\nconst x = 1\n```\n'

  test('围栏留着但压暗，代码本体按等宽排', () => {
    const state = stateOf(doc, doc.length)
    assert.deepEqual(hiddenText(state), [])
    assert.deepEqual(markedText(state, 'cm-md-fence'), ['```', 'js', '```'])
    // 整块一个等宽样式，块里每一行再各自带一层
    assert.deepEqual(markedText(state, 'cm-md-code'), ['```js\nconst x = 1\n```', 'const x = 1'])
    assert.deepEqual(markedLines(state, 'cm-md-codeblock'), [1, 2, 3])
  })

  test('分割线整行换成一条横线', () => {
    assert.deepEqual(widgetText(stateOf('甲\n\n---\n\n乙\n', 10)), ['---'])
  })

  test('光标停在分割线上：退回原文', () => {
    assert.deepEqual(widgetText(stateOf('甲\n\n---\n\n乙\n', 5)), [])
  })
})

describe('表格与引用', () => {
  const doc = '| a | b |\n| - | - |\n| 1 | 2 |\n'

  test('表头加粗、分隔符压暗、表格行不进 md 记号的黑名单', () => {
    const state = stateOf(doc, doc.length)
    assert.deepEqual(hiddenText(state), [])
    assert.deepEqual(markedLines(state, 'cm-md-thead'), [1])
    // 表头一行三个竖线；分隔行整行是一个节点；数据行再三个
    assert.deepEqual(markedText(state, 'cm-md-delim'), ['|', '|', '|', '| - | - |', '|', '|', '|'])
  })

  test('引用的 `>` 收起来，整行按引用排版', () => {
    const state = stateOf('> 引用\n\n正文\n', 8)
    assert.deepEqual(hiddenText(state), ['>'])
    assert.deepEqual(markedLines(state, 'cm-md-quote'), [1])
  })
})

describe('正文本身不被改写', () => {
  test('装饰集只描述长相，md 原文一个字都不动', () => {
    const doc = '# 标题\n\n- [ ] 甲\n\n> 乙 **丙**\n'
    const state = stateOf(doc, doc.length)
    liveDecorations(state)
    assert.equal(state.doc.toString(), doc)
  })
})
