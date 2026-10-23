/**
 * 会话的「事件型」状态：一轮结束时需要人消费的那几档。
 *
 * 服务端的通知判据与渲染层的卡片角标必须共用这一份。两边各自再写一遍字面量，
 * 以后任何一边新增一档事件态，另一边都不会报错，只会悄悄不一致。
 *
 * 状态全集与展示语义仍在 server/session-state.ts 的 THREAD_STATES。
 */
export const EVENT_STATES = ['done', 'blocked', 'failed'] as const

export type EventState = (typeof EVENT_STATES)[number]

export function isEventState(state: string): state is EventState {
  return (EVENT_STATES as readonly string[]).includes(state)
}
