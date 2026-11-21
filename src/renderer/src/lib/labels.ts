import { RequirementStatus } from '../../../shared/domain.ts'
import { t as tr } from "../../../shared/i18n.ts"
/**
 * 展示用的映射表，详情页与 mini 面板共用：
 * 分开写两份迟早漂移（agent 名认不出来、状态色对不齐）。
 */

// agent 显示名。取值与 CLI 的 --agent 一致，认不出来的原样显示
export const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  get chengxiaobang() { return tr("Chengxiaobang") },
}

// 状态圆点的配色，与看板列的语义对齐
export const STATUS_CLASS: Record<string, string> = {
  [RequirementStatus.Clarification]: 's-clarify',
  [RequirementStatus.InProgress]: 's-doing',
  [RequirementStatus.Review]: 's-review',
  [RequirementStatus.Completed]: 's-done',
}

// 「下一步」两级的分组标题
export const NEXT_UP_LEVEL_LABEL: Record<string, string> = {
  get now() { return tr("Needs attention now") },
  get soon() { return tr("Review when convenient") },
}

// Resolve known agent names from IDs at display time; server labels may be cached in another language.
export function agentLabel(id: string, fallback = id): string {
  return Object.hasOwn(AGENT_LABELS, id) ? AGENT_LABELS[id] : fallback
}

export function openTargetLabel(target: { id: string; label: string }): string {
  if (!target.id) return tr('Finder')
  if (target.id === 'terminal') return tr('Terminal')
  return target.label
}
