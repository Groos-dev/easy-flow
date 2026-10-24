// MR/PR 状态走本机已登录的 glab / gh：内网 CA 不被 Node 信任，也免去在本进程经手 token
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './log.ts'
import { parseJsonOrNull } from './util.ts'

const log = createLogger('code-host')

export type CodeLinkState = 'open' | 'merged' | 'closed'
export type PipelineState = 'success' | 'failed' | 'running' | 'skipped'

export interface CodeLinkStatus {
  state: CodeLinkState
  // 只有 GitLab 的 MR 带；PR 与没跑过流水线的为 null
  pipeline: PipelineState | null
}

interface CodeLinkRef {
  kind: 'gitlab' | 'github'
  host: string
  project: string
  iid: string
}

export function parseCodeLink(url: string): CodeLinkRef | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  // host 会原样进 glab 的 --hostname，别让一个以 - 开头的串被当成参数
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i.test(parsed.host)) return null

  const gitlab = /^\/(.+)\/-\/merge_requests\/(\d+)\/?$/.exec(parsed.pathname)
  if (gitlab) {
    return { kind: 'gitlab', host: parsed.host, project: gitlab[1], iid: gitlab[2] }
  }

  if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null
  // owner/repo 会拼进 gh 的 API 路径，不允许点段与转义字符
  const github = /^\/([a-z0-9._-]+)\/([a-z0-9._-]+)\/pull\/(\d+)\/?$/i.exec(parsed.pathname)
  if (github && github[1] !== '.' && github[1] !== '..' && github[2] !== '.' && github[2] !== '..') {
    return { kind: 'github', host: parsed.host, project: `${github[1]}/${github[2]}`, iid: github[3] }
  }
  return null
}

export function stateOfGitlab(data: unknown): CodeLinkState | null {
  const state = (data as { state?: unknown } | null)?.state
  // locked 只是锁了讨论，MR 本身还开着（老版本 GitLab 会这么报）
  if (state === 'opened' || state === 'locked') return 'open'
  if (state === 'merged' || state === 'closed') return state
  return null
}

export function stateOfGithub(data: unknown): CodeLinkState | null {
  const d = data as { state?: unknown; merged?: unknown; merged_at?: unknown } | null
  if (d?.state === 'open') return 'open'
  if (d?.state !== 'closed') return null
  return d.merged === true || d.merged_at ? 'merged' : 'closed'
}

// 只取汇总：stage 明细留在 GitLab，面板里一个图标就够
export function pipelineOfGitlab(data: unknown): PipelineState | null {
  const pipeline = (data as { head_pipeline?: { status?: unknown } | null } | null)?.head_pipeline
  const status = pipeline?.status
  if (status === 'success') return 'success'
  if (status === 'failed') return 'failed'
  if (status === 'canceled' || status === 'skipped') return 'skipped'
  if (
    status === 'running' ||
    status === 'pending' ||
    status === 'created' ||
    status === 'preparing' ||
    status === 'waiting_for_resource' ||
    status === 'scheduled' ||
    status === 'canceling' ||
    status === 'manual' ||
    status === 'blocked'
  ) {
    return 'running'
  }
  return null
}

// GUI 拉起的进程读不到登录 shell 的 PATH，补上 Homebrew 的安装位置
function which(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(':').concat('/opt/homebrew/bin', '/usr/local/bin')
  for (const dir of dirs) {
    if (!dir) continue
    const bin = join(dir, name)
    if (existsSync(bin)) return bin
  }
  return null
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message))
          return
        }
        resolve(stdout)
      },
    )
    // 没登录时 glab/gh 想弹交互，直接给 EOF，别耗到超时
    child.stdin?.end()
  })
}

export function statusOfGitlab(data: unknown): CodeLinkStatus | null {
  const state = stateOfGitlab(data)
  return state ? { state, pipeline: pipelineOfGitlab(data) } : null
}

async function requestStatus(ref: CodeLinkRef): Promise<CodeLinkStatus | null> {
  if (ref.kind === 'gitlab') {
    const bin = which('glab')
    if (!bin) return null
    const path = `projects/${encodeURIComponent(ref.project)}/merge_requests/${ref.iid}`
    return statusOfGitlab(parseJsonOrNull(await run(bin, ['api', '--hostname', ref.host, path])))
  }
  const bin = which('gh')
  if (!bin) return null
  const path = `repos/${ref.project}/pulls/${ref.iid}`
  const state = stateOfGithub(parseJsonOrNull(await run(bin, ['api', path])))
  return state ? { state, pipeline: null } : null
}

const TTL_MS = 10_000
const CACHE_MAX = 500
const MAX_PARALLEL = 4
const cache = new Map<string, { at: number; status: CodeLinkStatus | null }>()
const inflight = new Map<string, Promise<CodeLinkStatus | null>>()
const warned = new Set<string>()

let running = 0
const waiting: Array<() => void> = []

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((go) => waiting.push(go))
  running++
  try {
    return await task()
  } finally {
    running--
    waiting.shift()?.()
  }
}

async function lookup(url: string): Promise<CodeLinkStatus | null> {
  const ref = parseCodeLink(url)
  let status: CodeLinkStatus | null = null
  if (ref) {
    try {
      status = await requestStatus(ref)
    } catch (err) {
      /* 没装、没登录、断网都当取不到，同一链接只提醒一次 */
      if (!warned.has(url)) {
        warned.add(url)
        log.warn(`取不到 ${url} 的状态：${(err as Error).message}`)
      }
    }
  }
  cache.set(url, { at: Date.now(), status })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return status
}

// 取不到的不出现，不拿 unknown 冒充事实
export async function codeLinkStatuses(
  urls: string[],
  resolve: (url: string) => Promise<CodeLinkStatus | null> = lookup,
): Promise<Record<string, CodeLinkStatus>> {
  const out: Record<string, CodeLinkStatus> = {}
  await Promise.all(
    [...new Set(urls)].map(async (url) => {
      const hit = cache.get(url)
      if (hit && Date.now() - hit.at < TTL_MS) {
        if (hit.status) out[url] = hit.status
        return
      }
      let pending = inflight.get(url)
      if (!pending) {
        pending = limited(() => resolve(url))
        inflight.set(url, pending)
        const done = () => inflight.delete(url)
        pending.then(done, done)
      }
      const status = await pending
      if (status) out[url] = status
    }),
  )
  return out
}
