import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { focusEffect, livePreview } from '../lib/markdown-live'

/**
 * 正文编辑器。没有预览/源码两态：写的就是看的那份东西，光标所在行显原文，
 * 其余行按 md 渲染（怎么渲染见 lib/markdown-live）。
 *
 * 文档由 CodeMirror 自己持有，React 只在「换了文档」时把新的整篇灌进去、在按键时收下新内容。
 * 不做受控绑定：每次按键都把光标重置回 React state 会跟输入法打架。
 */
export default function MarkdownEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 建实例那一刻的正文。之后 value 变了走下面的同步，不再重建实例
  const initial = useRef(value)
  const changeRef = useRef(onChange)
  changeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          livePreview,
          drawSelection(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: 'false' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changeRef.current(u.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    // 焦点进出的那一刻要重画：焦点在外面时整篇都按渲染结果画
    const focus = (on: boolean) => () => view.dispatch({ effects: focusEffect.of(on) })
    const onFocus = focus(true)
    const onBlur = focus(false)
    host.addEventListener('focusin', onFocus)
    host.addEventListener('focusout', onBlur)
    return () => {
      viewRef.current = null
      host.removeEventListener('focusin', onFocus)
      host.removeEventListener('focusout', onBlur)
      view.destroy()
    }
  }, [])

  // 换文档：整篇替换。本地输入回流进来的 value 与 doc 相同，这里直接跳过
  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  return <div className="md-live" ref={hostRef} />
}
