import { normalizeRequirementStatus, RequirementStatus, CodeLinkState, TodoOrigin } from './domain.ts'
import { messages, type MessageKey } from './messages.ts'

export const Language = {
  English: 'en',
  Chinese: 'zh',
} as const
export type Language = (typeof Language)[keyof typeof Language]

export const LANGUAGES = Object.values(Language)
export function isLanguage(value: unknown): value is Language {
  return value === Language.English || value === Language.Chinese
}

let currentLanguage: Language = Language.English
const listeners = new Set<() => void>()

export function getLanguage(): Language {
  return currentLanguage
}

export function setLanguage(language: Language): void {
  if (currentLanguage === language) return
  currentLanguage = language
  for (const listener of listeners) listener()
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/* Resolve only catalog messages; never rewrite user content or API data. */
export function translate(key: MessageKey, values: readonly unknown[] = [], language = getLanguage()): string {
  const template = messages[key][language]
  return template.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : match)
}

export const t = translate

export function requirementStatusLabel(status: string): string {
  if (status === 'pinned') return t('Pinned')
  switch (normalizeRequirementStatus(status)) {
    case RequirementStatus.Clarification: return t('Clarification')
    case RequirementStatus.InProgress: return t('In progress')
    case RequirementStatus.Review: return t('Review')
    case RequirementStatus.Completed: return t('Completed')
    default: return status
  }
}

export function codeLinkStateLabel(state: CodeLinkState): string {
  switch (state) {
    case CodeLinkState.Open: return t('Open')
    case CodeLinkState.Merged: return t('Merged')
    case CodeLinkState.Closed: return t('Closed')
  }
}

export function todoSourceLabel(source: string): string {
  switch (source) {
    case TodoOrigin.Feishu: return t('Feishu')
    case TodoOrigin.Chat: return t('Chat')
    case TodoOrigin.Agent: return t('Agent')
    case TodoOrigin.Manual: return t('Manual')
    default: return source
  }
}

// Descriptor keys are persisted identities. Change catalog translation values without renaming these keys.
export interface MessageDescriptor {
  key: MessageKey
  values: ReadonlyArray<string | number | boolean | null>
}

// Persist identities and arguments, rather than freezing a display-language string.
export function message(key: MessageKey, values: readonly unknown[] = []): MessageDescriptor {
  return {
    key,
    values: values.map(value => value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value)) ? value : String(value)),
  }
}

export function messageText(descriptor: MessageDescriptor): string {
  return t(descriptor.key, descriptor.values)
}

export function messageDetail(key: MessageKey, values: readonly unknown[] = []): {
  detail: string
  detailMessage: MessageDescriptor
} {
  const descriptor = message(key, values)
  return { detail: messageText(descriptor), detailMessage: descriptor }
}

export function readMessage(raw: string | null | undefined): MessageDescriptor | undefined {
  if (!raw) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    if (typeof record.key !== 'string' || !Object.hasOwn(messages, record.key) || !Array.isArray(record.values)) return undefined
    if (!record.values.every(item => item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))) return undefined
    return record as unknown as MessageDescriptor
  } catch { return undefined }
}
