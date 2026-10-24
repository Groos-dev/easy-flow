/**
 * Install easy-flow's skills and CLI into the user's environment (the settings-page entry).
 *
 * Three things get installed:
 *   1. a CLI shim at ~/.local/bin/easy-flow — the commands the skills mention need a real command
 *   2. skill links for each agent: the entities live in the repo (same source as the CLI, so the
 *      two cannot drift), ~/.agents/skills/<name> points at one, and the claude / cursor / codex
 *      skills dirs link to that again
 *   3. removal of the legacy easy-flow MCP registration — its entry file is gone, and a stale
 *      registration only makes every session error out
 *
 * Installed-or-not is always read from the filesystem (does the symlink point at the right
 * place, does the shim exist), never from a state file: if the user changed things by hand,
 * this must reflect that truthfully.
 */
import { execFile } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { configPath } from './config.ts'

const run = promisify(execFile)

const NAME = 'easy-flow'
const SHELL = process.env.SHELL ?? '/bin/zsh'

/**
 * Run an agent CLI through a login shell.
 * A GUI-launched Electron only has /usr/bin:/bin on PATH, while claude / codex usually live in
 * ~/.local/bin, fnm and friends — only a login shell brings those paths in.
 * The command itself goes through "$0"/"$@" so paths with spaces survive without quoting.
 */
async function runAgent(bin: string, args: string[]): Promise<void> {
  try {
    await run(SHELL, ['-lc', 'exec "$0" "$@"', bin, ...args])
  } catch (err) {
    const { code, stderr } = err as { code?: number; stderr?: string }
    // a login shell exits 127 when the command is missing — more reliable than matching stderr wording
    if (code === 127) throw new Error(`Cannot find the ${bin} command; make sure it is installed and on PATH`, { cause: err })
    const detail = (stderr ?? '').trim() || (err as Error).message
    throw new Error(detail.split('\n').find((line) => line.trim())?.trim() ?? detail, { cause: err })
  }
}

/**
 * Find a repo file by walking up: in dev this module sits in server/, while a packaged build
 * has the code in out/main/ (electron-vite bundles server/ into the main process), so the
 * depth differs — try one level at a time.
 */
function upfind(...rel: string[]): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, ...rel)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`Cannot find ${rel.join('/')}; a packaged build must emit it separately`)
}

/**
 * 仓库里要装到各 agent 的 skill。目录名就是 skill 名，一个目录一个 skill。
 * 都放在同一个根下，装的时候一起链，免得加一个 skill 要改一遍安装逻辑。
 */
const SKILLS = ['easy-flow', 'todo'] as const

// 仓库里的 skill 根目录（<repo>/skill）：找到任一 skill 的 SKILL.md 再往上退两级
function skillRoot(): string {
  return dirname(dirname(upfind('skill', SKILLS[0], 'SKILL.md')))
}

// 某个 skill 在仓库里的实体
function skillSource(name: string): string {
  return join(skillRoot(), name)
}

function cliEntry(): string {
  return upfind('server', 'cli.ts')
}

export interface AgentSkill {
  id: 'claude' | 'cursor' | 'codex' | 'chengxiaobang'
  label: string
  // That agent's skills dir; it may not exist when the agent is not installed
  dir: string
  // Whether the dir exists (skip missing ones — do not create an empty dir for them)
  available: boolean
  // 这个 agent 下的每个 skill 都已链对
  linked: boolean
}

export interface SkillPlan {
  // 仓库里的 skill 根目录与 CLI 入口；环境不允许时为 null
  source: string | null
  // 根目录下的 skill 清单
  skills: string[]
  cli: string | null
  problem: string | null
  shim: { path: string; installed: boolean }
  // node resolved from a login shell; running .ts directly needs >= 22.18
  node: { path: string; version: string } | null
  agents: AgentSkill[]
  // Legacy MCP registrations still present (installing removes them)
  legacyMcp: Array<{ id: 'claude' | 'codex'; label: string; registered: boolean }>
}

function shimPath(): string {
  return join(homedir(), '.local', 'bin', NAME)
}

// 某个 skill 挂到 ~/.agents/skills 下的位置
function homeLink(name: string): string {
  return join(homedir(), '.agents', 'skills', name)
}

function agentDirs(): Array<{ id: AgentSkill['id']; label: string; dir: string; shared?: boolean }> {
  return [
    { id: 'claude', label: 'Claude Code', dir: join(homedir(), '.claude', 'skills') },
    { id: 'cursor', label: 'Cursor', dir: join(homedir(), '.cursor', 'skills') },
    { id: 'codex', label: 'Codex', dir: join(homedir(), '.codex', 'skills') },
    // 程小帮直接读 ~/.agents/skills（CHENGXIAOBANG_AGENTS_DIR 的默认值），
    // 共享目录本身就是 home 链接，不用再套一层
    { id: 'chengxiaobang', label: '程小帮', dir: join(homedir(), '.agents', 'skills'), shared: true },
  ]
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function resolveOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * 比最终落到哪，不比中间那串字面量：应用可能从工作区（worktree）里跑，链接指的却是主 checkout，
 * 两边其实是同一份 skill，不该报未安装。链接断了（目标被删）在这里也露馅——realpath 解不开。
 */
function linkedTo(link: string, target: string): boolean {
  const st = lstatOrNull(link)
  if (!st?.isSymbolicLink()) return false
  const real = resolveOrNull(link)
  return !!real && real === resolveOrNull(target)
}

// ~/.agents/skills/<name> 要落在真的 skill 源上：解出来名字对得上，里面还有 SKILL.md
function homeLinked(name: string): boolean {
  const real = resolveOrNull(homeLink(name))
  return !!real && basename(real) === name && existsSync(join(real, 'SKILL.md'))
}

/**
 * Refuse when a real dir/file already exists there — that is the user's own stuff,
 * not ours to replace.
 */
function ensureLink(link: string, target: string): void {
  if (linkedTo(link, target)) return
  const st = lstatOrNull(link)
  if (st) {
    if (!st.isSymbolicLink()) throw new Error(`A file or directory already exists at ${link}; move it away before installing`)
    rmSync(link)
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link)
}

/**
 * Wrap a shell argument in single quotes, splitting on embedded quotes.
 */
function shq(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

function shimScript(node: string, cli: string): string {
  return `#!/bin/sh
# easy-flow CLI (installed by the easy-flow app; re-run Install in settings to refresh)
EASY_FLOW_CONFIG=${shq(configPath())} exec ${shq(node)} ${shq(cli)} "$@"
`
}

/**
 * Resolve node's real binary path and version from a login shell; the shim bakes the path in.
 * Not `command -v node`: version managers like fnm hand out a per-shell multishell path that
 * dies with the process — process.execPath is where node actually lives.
 */
async function nodeInfo(): Promise<{ path: string; version: string } | null> {
  try {
    const path = (await run(SHELL, ['-lc', 'node -e "console.log(process.execPath)"']))
      .stdout.trim()
      .split('\n')
      .pop()
      ?.trim()
    if (!path) return null
    const version = (await run(path, ['--version'])).stdout.trim()
    return { path, version }
  } catch {
    return null
  }
}

/**
 * The CLI runs .ts directly, which needs Node's native type stripping (>= 22.18).
 */
function nodeTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number)
  return major < 22 || (major === 22 && minor < 18)
}

function claudeMcpRegistered(): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    return !!raw.mcpServers?.[NAME]
  } catch {
    return false
  }
}

/**
 * Only codex's own table header style (`[mcp_servers.easy-flow]`) counts;
 * hand-written inline tables are not detected.
 */
function codexMcpRegistered(): boolean {
  try {
    const file = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
    return new RegExp(`^\\[mcp_servers\\.${NAME}\\]`, 'm').test(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

export async function skillPlan(): Promise<SkillPlan> {
  let source: string | null = null
  let cli: string | null = null
  let problem: string | null = null
  try {
    source = skillRoot()
    cli = cliEntry()
  } catch (err) {
    problem = (err as Error).message
  }

  // 一个 agent 算"装好了"，是它下面每个 skill 都链对了
  const linkedEverywhere = (agentDir: string) =>
    SKILLS.every((name) => homeLinked(name) && linkedTo(join(agentDir, name), homeLink(name)))

  const agents = agentDirs().map(({ shared, ...a }) => ({
    ...a,
    available: existsSync(a.dir),
    // 共享目录的 agent 没有自己那层链接：home 链接对了就算装好
    linked: shared ? SKILLS.every((name) => homeLinked(name)) : linkedEverywhere(a.dir),
  }))

  return {
    source,
    skills: [...SKILLS],
    cli,
    problem,
    shim: { path: shimPath(), installed: existsSync(shimPath()) },
    node: await nodeInfo(),
    agents,
    legacyMcp: [
      { id: 'claude', label: 'Claude Code', registered: claudeMcpRegistered() },
      { id: 'codex', label: 'Codex', registered: codexMcpRegistered() },
    ],
  }
}

/**
 * 装 / 卸的结果：成功只回一句结论（设置页不再回显每一步的路径），
 * 没做成的步骤带原因，由界面照错误显示。
 */
export interface InstallOutcome {
  summary: string
  failed: string[]
}

/**
 * Remove legacy MCP registrations. Failing is fine (never registered);
 * report it honestly anyway.
 */
async function removeLegacyMcp(): Promise<string[]> {
  const failed: string[] = []
  const targets: Array<{ id: 'claude' | 'codex'; label: string; args: string[] }> = [
    { id: 'claude', label: 'Claude Code', args: ['mcp', 'remove', '-s', 'user', NAME] },
    { id: 'codex', label: 'Codex', args: ['mcp', 'remove', NAME] },
  ]
  for (const t of targets) {
    const registered = t.id === 'claude' ? claudeMcpRegistered() : codexMcpRegistered()
    if (!registered) continue
    try {
      await runAgent(t.id, t.args)
    } catch (err) {
      failed.push(
        `Failed to remove the legacy MCP registration for ${t.label} (${(err as Error).message}); run \`${t.id} mcp remove\` manually`,
      )
    }
  }
  return failed
}

/**
 * Install the CLI shim + skill links + remove legacy MCP registrations;
 * 结果只回一句结论与没装上的那几步，供设置页直接显示。
 */
export async function installSkill(): Promise<InstallOutcome> {
  const cli = cliEntry()

  const node = await nodeInfo()
  if (!node) throw new Error('Cannot find node from a login shell; make sure it is installed and on PATH')
  if (nodeTooOld(node.version)) {
    throw new Error(`node ${node.version} is too old: running .ts directly needs Node >= 22.18`)
  }

  const failed: string[] = []

  const shim = shimPath()
  mkdirSync(dirname(shim), { recursive: true })
  writeFileSync(shim, shimScript(node.path, cli), { mode: 0o755 })

  // 一个 skill 装不上不该拖垮其余的：目标位置被用户自己的真目录占着是常见情况
  // （比如 todo skill 原先手写在 ~/.agents/skills/todo），报出来让人自己处置
  const link = (what: string, target: string, into: string) => {
    try {
      ensureLink(target, into)
    } catch (err) {
      failed.push(`${what} 没装上（${(err as Error).message}）`)
    }
  }

  for (const name of SKILLS) {
    const source = skillSource(name)
    const home = homeLink(name)
    link(`skill ${name}`, home, source)
    for (const a of agentDirs()) {
      if (a.shared) continue
      if (!existsSync(a.dir)) continue
      link(`${a.label} / ${name}`, join(a.dir, name), home)
    }
  }

  failed.push(...(await removeLegacyMcp()))
  return { summary: '已安装', failed }
}
