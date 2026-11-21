import { CodeLinkState, PipelineState } from '../../../shared/domain.ts'
import { t as tr } from "../../../shared/i18n.ts"
import type { CodeLinkStatus } from './types'

// 短名与「这条是不是 MR/PR」的口径在 shared/，命令行与看板共用一份
export { isCodeLink, linkLabel } from '../../../../shared/link.ts'

// 流水线汇总的图标：够小，跟状态列并排不抢戏
export const PIPELINE_ICON: Record<PipelineState, string> = {
  [PipelineState.Success]: '✓',
  [PipelineState.Failed]: '✕',
  [PipelineState.Running]: '◔',
  [PipelineState.Skipped]: '–',
}

// hover 用中文说清楚到哪一步，图标本身认不出来
export const PIPELINE_LABEL: Record<PipelineState, string> = {
  get [PipelineState.Success]() { return tr("Passed") },
  get [PipelineState.Failed]() { return tr("Failed") },
  get [PipelineState.Running]() { return tr("Running or waiting for manual execution") },
  get [PipelineState.Skipped]() { return tr("Cancelled or skipped") },
}

// 合入/关闭的 MR 再看流水线是历史噪音，只有还开着的才带
export function showsPipeline(status: CodeLinkStatus): boolean {
  return status.state === CodeLinkState.Open && status.pipeline !== null
}
