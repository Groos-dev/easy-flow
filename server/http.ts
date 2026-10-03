/**
 * HTTP 层的零件：CORS、JSON 响应、请求体解析、需求文档读写。
 *
 * 都是无状态的纯函数——不碰 db，也不关心当前数据目录是哪个，
 * 所以能独立于路由表存在。路由与"当前库"（会随换目录重赋值）留在 index.ts。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 允许的跨源来源：本机的 Vite dev server，以及打包后渲染进程的 file 协议源。
 * 这个服务能删目录、写文件、调 open，因此不能对任意网页开放
 * （否则任何网站都能向 127.0.0.1:3210 发请求）。
 */
const ALLOWED_ORIGIN = new RegExp(
  '^(file://|https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?)$',
)

export function allowOrigin(req: IncomingMessage): string | null {
  const origin = req.headers.origin
  if (!origin) return null // 非浏览器请求（curl、Electron 主进程）不涉及 CORS
  return ALLOWED_ORIGIN.test(origin) ? origin : null
}

export function json(req: IncomingMessage, res: ServerResponse, code: number, payload: unknown): void {
  const buf = Buffer.from(JSON.stringify(payload))
  const headers: Record<string, string | number> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  }
  const origin = allowOrigin(req)
  if (origin) headers['access-control-allow-origin'] = origin
  res.writeHead(code, headers)
  res.end(buf)
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

/** 只允许读写需求目录内的文本/markdown，且禁止越界（..、绝对路径） */
const READABLE = /\.(md|markdown|txt|json|ya?ml)$/i

function resolveDocPath(reqDir: string, name: string): string {
  if (isAbsolute(name)) throw new Error('Absolute paths are not allowed')
  if (!READABLE.test(name)) throw new Error(`Unsupported file type: ${name}`)
  const base = resolve(reqDir)
  const target = resolve(base, name)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path escapes the root')
  return target
}

export function readRequirementDoc(reqDir: string, name: string): string {
  const target = resolveDocPath(reqDir, name)
  try {
    return readFileSync(target, 'utf8')
  } catch {
    throw new Error(`Cannot read file: ${name}`)
  }
}

/** 直接写入，不留备份（版本历史交给 git） */
export function writeRequirementDoc(
  reqDir: string,
  name: string,
  content: string,
): { bytes: number } {
  const target = resolveDocPath(reqDir, name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  return { bytes: Buffer.byteLength(content, 'utf8') }
}
