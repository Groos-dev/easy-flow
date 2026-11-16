import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOG_LEVELS, createLogger, formatLine, levelFromEnv, setLogLevel, startFileLogging } from '../server/log.ts'

describe('日志', () => {
  test('级别从环境变量读，认不出就用 info', () => {
    assert.equal(levelFromEnv('debug'), 'debug')
    assert.equal(levelFromEnv(' SILENT '), 'silent', '大小写与空格都认')
    assert.equal(levelFromEnv(undefined), 'info', '没设就是 info')
    assert.equal(levelFromEnv('verbose'), 'info', '拼错不该把日志整个关掉')
    assert.deepEqual([...LOG_LEVELS], ['debug', 'info', 'warn', 'error', 'silent'])
  })

  test('一行：时间到毫秒、级别对齐、scope 进方括号', () => {
    const at = new Date(2026, 9, 15, 14, 11, 5, 123).getTime()
    assert.equal(
      formatLine('debug', 'state', 'claude/x → idle', at),
      '2026-10-15 14:11:05.123 DEBUG [state] claude/x → idle',
    )
    assert.equal(formatLine('info', 'easy-flow', '起来了', at), '2026-10-15 14:11:05.123 INFO  [easy-flow] 起来了')
    assert.equal(formatLine('error', 'easy-flow', '挂了', at), '2026-10-15 14:11:05.123 ERROR [easy-flow] 挂了')
  })

  test('日志级别即时生效，过期日志在启动与定期清理时删除', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-flow-log-'))
    const file = join(dir, 'app.log')
    const now = Date.now()
    writeFileSync(file, `${formatLine('info', 'test', 'expired', now - 25 * 3600_000)}\n${formatLine('info', 'test', 'recent', now - 3600_000)}\n`)
    const stop = startFileLogging(file)
    try {
      const log = createLogger('test')
      setLogLevel('warn')
      log.info('hidden')
      log.warn('visible')
      setLogLevel('debug')
      log.debug('debug-visible')
      const content = readFileSync(file, 'utf8')
      assert.doesNotMatch(content, /expired|hidden/)
      assert.match(content, /recent/)
      assert.match(content, /visible/)
      assert.match(content, /debug-visible/)
    } finally {
      stop()
      setLogLevel('info')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
