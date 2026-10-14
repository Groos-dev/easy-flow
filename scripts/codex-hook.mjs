#!/usr/bin/env node
/**
 * Codex 用户级 hook 的薄转发脚本：读 stdin 的 JSON，原样 POST 到 easy-flow 的 /api/hook。
 *
 * Codex 的 hook 只有 `type: "command"`、没有 http，所以要这层转发。四条纪律：
 *   - 无论成败都往 stdout 写 `{}`：hook 的输出是给 Codex 读的，不能把 agent 卡住或刷屏
 *   - **整条链路 3 秒封顶**：读 stdin、连服务、等回应都算在同一个总闸里。只给 HTTP 请求设
 *     timeout 不够——上游不关 stdin 一样会挂住。本机已经有三家在吃 Codex hook（cmux 那条设了
 *     120000ms），我们这条绝不能拖住每一次工具调用
 *   - 服务没开就静默放弃：看板读不到，自然会退回它自己那条落盘读法
 *   - 带 `?agent=codex`：/api/hook 是 claude 与 codex 共用的入口，缺省算 claude；
 *     不标来源，codex 的事件会落进 claude 那一格，看板照旧读不到
 *
 * 端口默认 3210（应用固定用这个，见 server/index.ts 的 DEFAULT_PORT）；真要改端口，
 * 在 hook 命令里显式给 `EASY_FLOW_PORT`——hook 进程不继承看板的 env，别指望自动对上。
 *
 * 接法见需求 docs/easy-flow/codex-hook.md。同等的 curl 一行接法（连 node 都不用）：
 *   curl -s -m 3 -X POST -H 'content-type: application/json' --data-binary @- \
 *     'http://127.0.0.1:3210/api/hook?agent=codex' >/dev/null 2>&1; echo '{}'
 */
import { request } from 'node:http'

const PORT = process.env.EASY_FLOW_PORT ?? '3210'
const PATH = '/api/hook?agent=codex'
const TIMEOUT_MS = 3000

let done = false
function finish() {
  if (done) return
  done = true
  process.stdout.write('{}')
  process.exit(0)
}

// 总闸：连读 stdin 那一段也算进来，上游一直不关 stdin 也会在 3 秒内收口
setTimeout(finish, TIMEOUT_MS)

let body = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  body += chunk
})
process.stdin.on('error', finish)
process.stdin.on('end', () => {
  if (!body.trim()) return finish()
  const req = request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    },
    (res) => {
      res.resume()
      res.on('end', finish)
    },
  )
  // 连不上 / 中途断开都走同一条出口：静默、不阻塞
  req.on('error', finish)
  req.on('close', finish)
  req.end(body)
})
