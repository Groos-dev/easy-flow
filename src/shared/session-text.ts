import { messageText, type MessageDescriptor } from './i18n.ts'

export const ACTION_MAX_WIDTH = 36

export interface SessionAction {
  text: string
  calledAt: number
  message?: MessageDescriptor
}

export function formatActionText(action: SessionAction): string {
  return action.message ? clipActionText(messageText(action.message)) : action.text
}

// The source and both renderers share the same two-line display budget.
export function clipActionText(text: string): string {
  const width = (value: string) => [...value].reduce((sum, ch) => sum + (ch.codePointAt(0)! > 0x2e80 ? 2 : 1), 0)
  if (width(text) <= ACTION_MAX_WIDTH) return text
  let result = ''
  for (const ch of text) {
    if (width(result + ch) > ACTION_MAX_WIDTH - 1) break
    result += ch
  }
  return `${result}…`
}
