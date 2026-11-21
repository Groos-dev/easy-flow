import { t } from '../src/shared/i18n.ts'

// Error classification must not depend on a translated message.
export class CommandNotFoundError extends Error {
  readonly code = 'COMMAND_NOT_FOUND'

  constructor(command: string, cause?: unknown) {
    super(t('Cannot find the {0} command; make sure it is installed and on PATH', [command]), { cause })
  }
}
