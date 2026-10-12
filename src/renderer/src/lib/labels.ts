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
