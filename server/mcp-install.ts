/**
 * 把 easy-flow 的 MCP server 注册到 claude / codex 的用户级配置里。
 *
 * 为什么是用户级而不是项目目录：codex 压根没有项目级 MCP 配置（只认
 * $CODEX_HOME/config.toml），claude 的 .mcp.json 又只在项目里生效。两边统一
 * 到用户级，一次设置、哪个终端都能用，也不用往任何需求目录/worktree 落文件。
 *
 * 判断是否已注册读配置文件，安装调各自的 CLI——格式交给它们自己保证。
 * 配置里带上 EASY_FLOW_CONFIG，MCP server 才知道该开哪个数据目录。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { configPath } from './config.ts'

const run = promisify(execFile)

const NAME = 'easy-flow'
const SHELL = process.env.SHELL ?? '/bin/zsh'

/**
 * 用登录 shell 跑 agent 的 CLI。
 * GUI 启动的 Electron 只有 /usr/bin:/bin 这点 PATH，而 claude / codex 一般装在
 * ~/.local/bin、fnm 那些地方——只有登录 shell 会把这些路径带进来。
 * 命令本身走 "$0"/"$@" 传参，不拼字符串，路径里有空格也不怕。
 */
async function runAgent(bin: string, args: string[]): Promise<void> {
  try {
    await run(SHELL, ['-lc', 'exec "$0" "$@"', bin, ...args])
  } catch (err) {
    const { code, stderr } = err as { code?: number; stderr?: string }
    // 登录 shell 找不到命令时退出码固定是 127，比匹配 stderr 里的措辞可靠
    if (code === 127) throw new Error(`找不到 ${bin} 命令，确认它已安装且在 PATH 里`)
    // CLI 通常把原因写在第一行，后面跟着用法，取第一行比截尾更有用
    const detail = (stderr ?? '').trim() || (err as Error).message
    throw new Error(detail.split('\n').find((line) => line.trim())?.trim() ?? detail)
  }
}

export interface AgentMcp {
  id: 'claude' | 'codex'
  label: string
  /** 只读判断用的配置文件 */
  configFile: string
  installed: boolean
}

export interface McpPlan {
  /** MCP server 的入口文件；环境不允许时为 null */
  entry: string | null
  /** 入口不可用时的原因 */
  problem: string | null
  agents: AgentMcp[]
}

/**
 * MCP server 的入口文件。开发态直接从源码跑——Node ≥22.18 原生会剥掉类型。
 *
 * 不能按固定层数往上找：源码跑时本模块在 server/ 下，打包后代码在 out/main/
 * （electron-vite 会把 server/ 打进主进程包），层数不一样。所以一层层往上试。
 * 打包版如果没把 server/mcp.ts 单独产出一份，这里会明确报错，
 * 总好过装一条跑不起来的命令进用户配置。
 */
export function entryFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'server', 'mcp.ts')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到 MCP 入口 server/mcp.ts，打包版需要把它单独产出一份')
}

/** claude 的用户级配置：~/.claude.json 顶层的 mcpServers */
function claudeConfig(): string {
  return join(homedir(), '.claude.json')
}

/** codex 的用户级配置：$CODEX_HOME/config.toml */
function codexConfig(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
}

function claudeInstalled(): boolean {
  try {
    const raw = JSON.parse(readFileSync(claudeConfig(), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    return !!raw.mcpServers?.[NAME]
  } catch {
    return false
  }
}

/** 只认 codex 自己写出的表头写法（`[mcp_servers.easy-flow]`），手写的内联表认不出来 */
function codexInstalled(): boolean {
  try {
    return new RegExp(`^\\[mcp_servers\\.${NAME}\\]`, 'm').test(readFileSync(codexConfig(), 'utf8'))
  } catch {
    return false
  }
}

export function mcpPlan(): McpPlan {
  let entry: string | null = null
  let problem: string | null = null
  try {
    entry = entryFile()
  } catch (err) {
    problem = (err as Error).message
  }
  return {
    entry,
    problem,
    agents: [
      { id: 'claude', label: 'Claude Code', configFile: claudeConfig(), installed: claudeInstalled() },
      { id: 'codex', label: 'Codex', configFile: codexConfig(), installed: codexInstalled() },
    ],
  }
}

/** 摘掉旧注册。没装过会失败，忽略即可 */
async function remove(agent: AgentMcp['id']): Promise<void> {
  const args = agent === 'claude' ? ['mcp', 'remove', '-s', 'user', NAME] : ['mcp', 'remove', NAME]
  try {
    await runAgent(agent, args)
  } catch {
    /* 本来就没注册 */
  }
}

/**
 * 注册一个 agent。重名时 add 只报错、不覆盖（实测退出码 1），所以要摘掉旧的再来。
 * 顺序是先试一次而不是直接摘：参数本身有问题时，宁可报错也不能把好好的注册弄丢。
 */
async function registerOne(agent: AgentMcp['id'], args: string[]): Promise<void> {
  try {
    await runAgent(agent, args)
    return
  } catch {
    /* 多半是已存在，下面摘掉重来 */
  }
  await remove(agent)
  await runAgent(agent, args)
}

export async function installMcp(target?: AgentMcp['id']): Promise<string[]> {
  const entry = entryFile()
  const env = `EASY_FLOW_CONFIG=${configPath()}`
  const todo: Array<{ id: AgentMcp['id']; args: string[] }> = [
    { id: 'claude', args: ['mcp', 'add', '-s', 'user', NAME, '-e', env, '--', 'node', entry] },
    { id: 'codex', args: ['mcp', 'add', NAME, '--env', env, '--', 'node', entry] },
  ]

  const done: string[] = []
  for (const { id, args } of todo) {
    if (target && target !== id) continue
    try {
      await registerOne(id, args)
      done.push(id)
    } catch (err) {
      // 一边失败就停，报清楚是哪一个
      throw new Error(`注册到 ${id} 失败：${(err as Error).message}`)
    }
  }
  return done
}
