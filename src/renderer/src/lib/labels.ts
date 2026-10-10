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

/** 优先级标签，对应艾森豪威尔四象限 */
export const PRIORITY_LABEL: Record<string, string> = {
  p0: '重要且紧急（马上做）',
  p1: '重要不紧急（计划做）',
  p2: '紧急不重要（授权做）',
  p3: '不重要不紧急（有空再做）',
}
