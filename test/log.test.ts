import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { LOG_LEVELS, formatLine, levelFromEnv } from '../server/log.ts'

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
})
