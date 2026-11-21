// Every test process gets isolated preferences and data; never use the user's live board or settings.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Language, setLanguage } from '../src/shared/i18n.ts'

const testRoot = mkdtempSync(join(tmpdir(), 'easy-flow-test-config-'))
process.env.EASY_FLOW_CONFIG = join(testRoot, 'config.json')
writeFileSync(process.env.EASY_FLOW_CONFIG, JSON.stringify({ dataDir: join(testRoot, 'data'), language: Language.Chinese }))
process.once('exit', () => rmSync(testRoot, { recursive: true, force: true }))

// Historical display fixtures use Chinese; localization tests explicitly exercise both languages.
process.env.EASY_FLOW_LANG ??= Language.Chinese
setLanguage(Language.Chinese)
