import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

/**
 * 单栏所见即所得的渲染层：正文始终是那份 md 原文，这里只给语法树上的节点挂样式、
 * 把写出来的记号换成不占位的装饰。落盘写回去的还是同一串字符，不会被规范化重写。
 *
 * 规则只有一条：光标所在的行显原文，其余行显渲染结果。所以每次选区一变就要重算，
 * 而不是只在文档变化时算一次。没聚焦时整篇都按渲染结果画——刚打开一篇就露出第一行的
 * `#` 不是「所见即所得」。
 */

/** 编辑器有没有焦点。焦点不在里面时，谁也不知道光标在哪一行，索性全按渲染结果画 */
export const focusEffect = StateEffect.define<boolean>()

const focused = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(focusEffect)) return e.value
    return value
  },
})

const HIDDEN = Decoration.replace({})

// 装饰按类名复用：同一个类名的 mark / line 装饰只是引用不同，没必要每次新建
const markCache = new Map<string, Decoration>()
const lineCache = new Map<string, Decoration>()

function mark(cls: string): Decoration {
  let d = markCache.get(cls)
  if (!d) markCache.set(cls, (d = Decoration.mark({ class: cls })))
  return d
}

function line(cls: string): Decoration {
  let d = lineCache.get(cls)
  if (!d) lineCache.set(cls, (d = Decoration.line({ class: cls })))
  return d
}

/** 无序列表的圆点：markdown 写的是 `-`，渲染出来是个点 */
class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-md-bullet'
    el.textContent = '•'
    return el
  }
}

/** 任务项前面的方框。点一下直接改 md 里那个 `[ ]`，md 仍是唯一事实源 */
class TaskWidget extends WidgetType {
  constructor(
    readonly done: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super()
  }
  eq(other: TaskWidget) {
    return other.done === this.done && other.from === this.from && other.to === this.to
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    el.className = `cm-md-task${this.done ? ' done' : ''}`
    el.setAttribute('role', 'checkbox')
    el.setAttribute('aria-checked', String(this.done))
    el.onmousedown = (e) => {
      e.preventDefault()
      e.stopPropagation()
      view.dispatch({ changes: { from: this.from, to: this.to, insert: this.done ? '[ ]' : '[x]' } })
    }
    return el
  }
  /** 不拦的话点方框就只是移动光标，点不动 */
  ignoreEvent() {
    return false
  }
}

/** 分割线：`---` 这一行整行换成一条横线 */
class RuleWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-md-rule'
    return el
  }
}

/** 光标落在哪几行——那几行保持原文，是「就地改」的入口 */
function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>()
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    const last = state.doc.lineAt(r.to).number
    for (let n = first; n <= last; n++) set.add(n)
  }
  return set
}

/** 把 md 渲染成装饰集：只描述长什么样，不改内容 */
export function liveDecorations(state: EditorState): DecorationSet {
  const doc = state.doc
  const active = activeLines(state)
  const isFocused = state.field(focused, false)
  const out: Range<Decoration>[] = []

  const lineOf = (pos: number) => doc.lineAt(pos).number
  /** 显原文的行就是「活跃」的；记号只在不活跃的行上收起来 */
  const quiet = (from: number) => !isFocused || !active.has(lineOf(from))
  const paintLines = (cls: string, from: number, to: number) => {
    const last = lineOf(Math.max(from, to - 1))
    for (let n = lineOf(from); n <= last; n++) out.push(line(cls).range(doc.line(n).from))
  }
  const hide = (from: number, to: number) => out.push(HIDDEN.range(from, to))

  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter: (n) => {
      const { name, from, to } = n
      if (from === to) return
      const parent = n.node.parent?.name ?? ''
      // 列表记号挂在 ListItem 上，再上一层才分得出是有序还是无序
      const grandparent = n.node.parent?.parent?.name ?? ''
      switch (name) {
        case 'ATXHeading1':
        case 'SetextHeading1':
          paintLines('cm-md-h1', from, to)
          return
        case 'ATXHeading2':
        case 'SetextHeading2':
          paintLines('cm-md-h2', from, to)
          return
        case 'ATXHeading3':
          paintLines('cm-md-h3', from, to)
          return
        case 'ATXHeading4':
          paintLines('cm-md-h4', from, to)
          return
        case 'ATXHeading5':
        case 'ATXHeading6':
          paintLines('cm-md-h5', from, to)
          return

        // `#` `*` `**` `~~` `>` `[` `]` `(` `)`：渲染态里都不该出现
        case 'HeaderMark':
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'QuoteMark':
        case 'LinkMark':
          if (quiet(from)) hide(from, to)
          return

        // 反引号分两种：行内码的收起来，代码围栏的留着（只压暗），否则看不出这是块代码
        case 'CodeMark':
          if (parent === 'InlineCode') {
            if (quiet(from)) hide(from, to)
          } else {
            out.push(mark('cm-md-fence').range(from, to))
          }
          return
        case 'CodeInfo':
          out.push(mark('cm-md-fence').range(from, to))
          return
        case 'CodeText':
          out.push(mark('cm-md-code').range(from, to))
          return

        case 'InlineCode':
        case 'CodeBlock':
        case 'FencedCode':
          out.push(mark('cm-md-code').range(from, to))
          if (name !== 'InlineCode') paintLines('cm-md-codeblock', from, to)
          return

        case 'Emphasis':
          out.push(mark('cm-md-em').range(from, to))
          return
        case 'StrongEmphasis':
          out.push(mark('cm-md-strong').range(from, to))
          return
        case 'Strikethrough':
          out.push(mark('cm-md-strike').range(from, to))
          return
        case 'Link':
          out.push(mark('cm-md-link').range(from, to))
          return
        case 'Image':
          out.push(mark('cm-md-link').range(from, to))
          return
        case 'URL':
          // 自动链接自己就是地址，留着；md 链接的目的地在渲染态里没必要占位置
          if (parent === 'Link' || parent === 'Image') {
            if (quiet(from)) hide(from, to)
          } else {
            out.push(mark('cm-md-link').range(from, to))
          }
          return

        case 'Blockquote':
          paintLines('cm-md-quote', from, to)
          return
        case 'ListItem':
          paintLines('cm-md-li', from, to)
          return
        case 'ListMark':
          if (grandparent === 'BulletList') {
            if (quiet(from)) out.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to))
          } else {
            out.push(mark('cm-md-ordered').range(from, to))
          }
          return
        case 'TaskMarker':
          if (quiet(from)) {
            const done = doc.sliceString(from, to).toLowerCase().includes('x')
            out.push(Decoration.replace({ widget: new TaskWidget(done, from, to) }).range(from, to))
          } else {
            out.push(mark('cm-md-taskmark').range(from, to))
          }
          return

        case 'TableHeader':
          paintLines('cm-md-thead', from, to)
          return
        case 'TableDelimiter':
          out.push(mark('cm-md-delim').range(from, to))
          return

        case 'HorizontalRule':
          if (quiet(from)) {
            const l = doc.lineAt(from)
            out.push(Decoration.replace({ widget: new RuleWidget() }).range(l.from, l.to))
          } else {
            out.push(mark('cm-md-hr').range(from, to))
          }
          return

        default:
          return
      }
    },
  })

  // 行装饰与标记装饰交错取出来，交给 RangeSet 排序
  return Decoration.set(out, true)
}

const decorations = StateField.define<DecorationSet>({
  create: liveDecorations,
  update: (value, tr) =>
    tr.docChanged || tr.selection || tr.effects.some((e) => e.is(focusEffect))
      ? liveDecorations(tr.state)
      : value.map(tr.changes),
})

/** 编辑器扩展：把正文按 md 渲染出来，同时保持它是可编辑的原文 */
export const livePreview: Extension = [focused, decorations, EditorView.decorations.from(decorations)]
