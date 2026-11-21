import { message, type MessageDescriptor } from '../src/shared/i18n.ts'
import type { MessageKey } from '../src/shared/messages.ts'
import { clipActionText, formatActionText, type SessionAction } from '../src/shared/session-text.ts'
export { ACTION_MAX_WIDTH } from '../src/shared/session-text.ts'
export type { SessionAction } from '../src/shared/session-text.ts'
/**
 * 一次工具调用 → 气泡里那句动作。
 *
 * hook 推来的 PreToolUse 报文里有工具名与参数，codex 落盘的 function_call 里也有，
 * 所以归一只有这一处：认得就拼一句，认不出返回空串。
 */
// 描述类文案的字数上限
const DESC_MAX = 12

interface Rule {
  // 拼在文案最前面的动词
  messageKey: MessageKey
  // 从工具参数里取哪个字段
  field: string
  // 取到之后怎么裁
  cut: (raw: string) => string
}

/**
 * 认得的工具。claude 的参数位置见它自己的 hook 文档；codex 的 exec_command 参数是 cmd；
 * 程小帮的 Shell 与 Bash 同形。
 */
const RULES: Record<string, Rule> = {
  Edit: { messageKey: 'Edit {0}', field: 'file_path', cut: tailPath },
  Write: { messageKey: 'Write {0}', field: 'file_path', cut: tailPath },
  Read: { messageKey: 'Read {0}', field: 'file_path', cut: tailPath },
  Bash: { messageKey: 'Run {0}', field: 'command', cut: headWords },
  Shell: { messageKey: 'Run {0}', field: 'command', cut: headWords },
  Grep: { messageKey: 'Search {0}', field: 'pattern', cut: raw },
  Glob: { messageKey: 'Search {0}', field: 'pattern', cut: raw },
  Agent: { messageKey: 'Delegate {0}', field: 'description', cut: clipText },
  Task: { messageKey: 'Delegate {0}', field: 'description', cut: clipText },
  Delete: { messageKey: 'Delete {0}', field: 'file_path', cut: tailPath },
  WebSearch: { messageKey: 'Inspect {0}', field: 'query', cut: clipText },
  WebFetch: { messageKey: 'Inspect {0}', field: 'url', cut: clipText },
  CallMcpTool: { messageKey: 'Call {0}', field: 'toolName', cut: clipText },
  exec_command: { messageKey: 'Run {0}', field: 'cmd', cut: headWords },
  view_image: { messageKey: 'View {0}', field: 'path', cut: tailPath },
}

/**
 * 一次工具调用 → 一句动作文案。
 * 认不出的工具、取不到参数、取到空，都返回空串。
 */
function actionMessageOf(tool: string, input: unknown): MessageDescriptor | undefined {
  const rule = RULES[tool]
  if (!rule || !input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[rule.field]
  if (typeof value !== 'string') return undefined
  const text = clipActionText(rule.cut(value))
  return text ? message(rule.messageKey, [text]) : undefined
}

export function actionTextOf(tool: string, input: unknown): string {
  const descriptor = actionMessageOf(tool, input)
  return descriptor ? formatActionText({ text: '', calledAt: 0, message: descriptor }) : ''
}

export function actionOf(tool: string, input: unknown, calledAt: number): SessionAction | null {
  const descriptor = actionMessageOf(tool, input)
  if (!descriptor) return null
  const action: SessionAction = { text: '', calledAt, message: descriptor }
  return { ...action, text: formatActionText(action) }
}

/**
 * 路径取末段：一行里放得下的是文件名，不是整条路径。
 */
function tailPath(raw: string): string {
  const trimmed = collapse(raw).replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * 命令取前两个词，丢掉开关与后面的参数。
 *
 * 开头的 `cd <目录> &&` 只是定位、不是动作，先剥掉——本机取样里三分之一以上的 claude 命令、
 * 近六成的 codex 命令都以它开头。剥完空了就退回原样。
 */
const LEADING_CD = /^\s*cd\s+[^&;]*?(?:&&|;)\s*/

function headWords(raw: string): string {
  const body = collapse(raw)
  let rest = body
  while (LEADING_CD.test(rest)) rest = rest.replace(LEADING_CD, '')
  const words = (rest || body).split(' ').filter((w) => w && !w.startsWith('-'))
  return words.slice(0, 2).join(' ')
}

// 描述截到 12 个字，截短了带省略号
function clipText(raw: string): string {
  const body = collapse(raw)
  return body.length > DESC_MAX ? `${body.slice(0, DESC_MAX).trimEnd()}…` : body
}

/**
 * 搜索词原样：pattern 本身就是要看的东西，长度交给整句封顶。
 */
function raw(text: string): string {
  return collapse(text)
}

function collapse(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}
