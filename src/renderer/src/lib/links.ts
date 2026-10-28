import type { CodeLinkStatus, PipelineState } from './types'

// 短名与「这条是不是 MR/PR」的口径在 shared/，命令行与看板共用一份
export { isCodeLink, linkLabel } from '../../../../shared/link.ts'

// 流水线汇总的图标：够小，跟状态列并排不抢戏
export const PIPELINE_ICON: Record<PipelineState, string> = {
  success: '✓',
  failed: '✕',
  running: '◔',
  skipped: '–',
}

// hover 用中文说清楚到哪一步，图标本身认不出来
export const PIPELINE_LABEL: Record<PipelineState, string> = {
  success: '通过',
  failed: '失败',
  running: '进行中或等待手动执行',
  skipped: '已取消或跳过',
}

// 合入/关闭的 MR 再看流水线是历史噪音，只有还开着的才带
export function showsPipeline(status: CodeLinkStatus): boolean {
  return status.state === 'open' && status.pipeline !== null
}
