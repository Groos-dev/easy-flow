/**
 * 展示用的映射表，详情页与 mini 面板共用：
 * 分开写两份迟早漂移（agent 名认不出来、状态色对不齐）。
 */

/** agent 显示名。取值与 CLI 的 --agent 一致，认不出来的原样显示 */
export const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

/** 状态圆点的配色，与看板列的语义对齐 */
export const STATUS_CLASS: Record<string, string> = {
  澄清: 's-clarify',
  执行中: 's-doing',
  Review: 's-review',
  已完成: 's-done',
}

/**
 * 会话实时状态的文案与配色。配色沿用看板那四个色，失败用 p0 的红。
 * unknown 不给配色——它不该出现在角标上，只该在详情页里说明为什么读不到。
 */
export const THREAD_STATE_LABEL: Record<string, string> = {
  thinking: '正在思考',
  working: '正在干活',
  idle: '静止',
  done: '已完成待看',
  blocked: '需要人介入',
  failed: '失败',
  unknown: '读不到状态',
}

/** 「下一步」两级的分组标题 */
export const NEXT_UP_LEVEL_LABEL: Record<string, string> = {
  now: '现在就得动',
  soon: '有空再看',
}

export const THREAD_STATE_CLASS: Record<string, string> = {
  thinking: 't-thinking',
  working: 't-working',
  idle: 't-idle',
  done: 't-done',
  blocked: 't-blocked',
  failed: 't-failed',
}
