/**
 * 一次工具调用 → 气泡里那句动作。
 *
 * hook 推来的 PreToolUse 报文里有工具名与参数，codex 落盘的 function_call 里也有，
 * 所以归一只有这一处：认得就拼一句，认不出返回空串。
 */
export interface SessionAction {
  /** 展示文案，形如「改 hook.ts」 */
  text: string
  /** 这次工具调用发生的时刻（epoch ms） */
  calledAt: number
}

/** 描述类文案的字数上限 */
const DESC_MAX = 12

/**
 * 一句动作的宽度上限（半角宽），取渲染层两行的容量。
 *
 * 源头只切超过两行的，渲染层的两行封顶与省略号只是兜底。气泡宽度由 UI 那份需求定稿，
 * 定稿后回填这个数。
 */
export const ACTION_MAX_WIDTH = 36

interface Rule {
  /** 拼在文案最前面的动词 */
  verb: string
  /** 从工具参数里取哪个字段 */
  field: string
  /** 取到之后怎么裁 */
  cut: (raw: string) => string
}

/**
 * 认得的工具。claude 的参数位置见它自己的 hook 文档；codex 的 exec_command 参数是 cmd；
 * 程小帮的 Shell 与 Bash 同形。
 */
const RULES: Record<string, Rule> = {
  Edit: { verb: '改', field: 'file_path', cut: tailPath },
  Write: { verb: '写', field: 'file_path', cut: tailPath },
  Read: { verb: '读', field: 'file_path', cut: tailPath },
  Bash: { verb: '跑', field: 'command', cut: headWords },
  Shell: { verb: '跑', field: 'command', cut: headWords },
  Grep: { verb: '搜', field: 'pattern', cut: raw },
  Glob: { verb: '搜', field: 'pattern', cut: raw },
  Agent: { verb: '派', field: 'description', cut: clipText },
  Task: { verb: '派', field: 'description', cut: clipText },
  exec_command: { verb: '跑', field: 'cmd', cut: headWords },
  view_image: { verb: '看', field: 'path', cut: tailPath },
}

/**
 * 一次工具调用 → 一句动作文案。
 * 认不出的工具、取不到参数、取到空，都返回空串。
 */
export function actionTextOf(tool: string, input: unknown): string {
  const rule = RULES[tool]
  if (!rule || !input || typeof input !== 'object') return ''
  const raw = (input as Record<string, unknown>)[rule.field]
  if (typeof raw !== 'string') return ''
  const text = rule.cut(raw)
  return text ? clip(`${rule.verb} ${text}`) : ''
}

/** 带时刻的动作。认不出就是 null——读不到一律不猜 */
export function actionOf(tool: string, input: unknown, calledAt: number): SessionAction | null {
  const text = actionTextOf(tool, input)
  return text ? { text, calledAt } : null
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

/** 描述截到 12 个字，截短了带省略号 */
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

/**
 * 整句封顶：本机取样里超过两行的有 23%，最长的 409 个半角宽。
 */
function clip(text: string): string {
  if (width(text) <= ACTION_MAX_WIDTH) return text
  let cut = ''
  for (const ch of text) {
    if (width(cut + ch) > ACTION_MAX_WIDTH - 1) break
    cut += ch
  }
  return `${cut}…`
}

/** 展示宽度：全角算 2、半角算 1 */
function width(text: string): number {
  let n = 0
  for (const ch of text) n += ch.codePointAt(0)! > 0x2e80 ? 2 : 1
  return n
}

function collapse(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}
