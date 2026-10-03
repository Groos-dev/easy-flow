/**
 * Install easy-flow's skill and CLI into the user's environment (the settings-page entry).
 *
 * Three things get installed:
 *   1. a CLI shim at ~/.local/bin/easy-flow — the commands the skill mentions need a real command
 *   2. skill links for each agent: the entity lives in the repo (same source as the CLI, so the
 *      two cannot drift), ~/.agents/skills/easy-flow points at it, and claude / cursor / codex
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
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
    if (code === 127) throw new Error(`Cannot find the ${bin} command; make sure it is installed and on PATH`)
    const detail = (stderr ?? '').trim() || (err as Error).message
    throw new Error(detail.split('\n').find((line) => line.trim())?.trim() ?? detail)
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

function skillSource(): string {
  return dirname(upfind('skill', 'SKILL.md'))
}

function cliEntry(): string {
  return upfind('server', 'cli.ts')
}

export interface AgentSkill {
  id: 'claude' | 'cursor' | 'codex'
  label: string
  /** That agent's skills dir; it may not exist when the agent is not installed */
  dir: string
  /** Whether the dir exists (skip missing ones — do not create an empty dir for them) */
  available: boolean
  /** The symlink already points at the right skill entity */
  linked: boolean
}

export interface SkillPlan {
  /** The skill entity and CLI entry inside the repo; null when the environment does not allow it */
  source: string | null
  cli: string | null
  problem: string | null
  shim: { path: string; installed: boolean }
  /** node resolved from a login shell; running .ts directly needs >= 22.18 */
  node: { path: string; version: string } | null
  agents: AgentSkill[]
  /** Legacy MCP registrations still present (installing removes them) */
  legacyMcp: Array<{ id: 'claude' | 'codex'; label: string; registered: boolean }>
}

function shimPath(): string {
  return join(homedir(), '.local', 'bin', NAME)
}

/**
 * Where the repo's skill entity is mounted under ~/.agents/skills.
 */
function homeLink(): string {
  return join(homedir(), '.agents', 'skills', NAME)
}

function agentDirs(): Array<{ id: AgentSkill['id']; label: string; dir: string }> {
  return [
    { id: 'claude', label: 'Claude Code', dir: join(homedir(), '.claude', 'skills') },
    { id: 'cursor', label: 'Cursor', dir: join(homedir(), '.cursor', 'skills') },
    { id: 'codex', label: 'Codex', dir: join(homedir(), '.codex', 'skills') },
  ]
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/**
 * Only a link pointing at the right target counts: missing, a real dir, or a wrong
 * target all mean "not installed".
 */
function linkedTo(link: string, target: string): boolean {
  const st = lstatOrNull(link)
  return !!st?.isSymbolicLink() && readlinkSync(link) === target
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
    source = skillSource()
    cli = cliEntry()
  } catch (err) {
    problem = (err as Error).message
  }

  const home = homeLink()
  const agents = agentDirs().map((a) => ({
    ...a,
    available: existsSync(a.dir),
    linked: !!source && linkedTo(join(a.dir, NAME), home) && linkedTo(home, source),
  }))

  return {
    source,
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
 * Remove legacy MCP registrations. Failing is fine (never registered);
 * report it honestly anyway.
 */
async function removeLegacyMcp(): Promise<string[]> {
  const done: string[] = []
  const targets: Array<{ id: 'claude' | 'codex'; label: string; args: string[] }> = [
    { id: 'claude', label: 'Claude Code', args: ['mcp', 'remove', '-s', 'user', NAME] },
    { id: 'codex', label: 'Codex', args: ['mcp', 'remove', NAME] },
  ]
  for (const t of targets) {
    const registered = t.id === 'claude' ? claudeMcpRegistered() : codexMcpRegistered()
    if (!registered) continue
    try {
      await runAgent(t.id, t.args)
      done.push(`已摘除 ${t.label} 的旧 MCP 注册`)
    } catch (err) {
      done.push(
        `Failed to remove the legacy MCP registration for ${t.label} (${(err as Error).message}); run \`${t.id} mcp remove\` manually`,
      )
    }
  }
  return done
}

/**
 * Install the CLI shim + skill links + remove legacy MCP registrations;
 * returns what each step did, for the settings page.
 */
export async function installSkill(): Promise<string[]> {
  const source = skillSource()
  const cli = cliEntry()

  const node = await nodeInfo()
  if (!node) throw new Error('Cannot find node from a login shell; make sure it is installed and on PATH')
  if (nodeTooOld(node.version)) {
    throw new Error(`node ${node.version} is too old: running .ts directly needs Node >= 22.18`)
  }

  const done: string[] = []

  const shim = shimPath()
  mkdirSync(dirname(shim), { recursive: true })
  writeFileSync(shim, shimScript(node.path, cli), { mode: 0o755 })
  done.push(`CLI：${shim} → ${node.path} ${cli}`)

  const home = homeLink()
  ensureLink(home, source)
  done.push(`skill：${home} → ${source}`)

  for (const a of agentDirs()) {
    if (!existsSync(a.dir)) continue
    ensureLink(join(a.dir, NAME), home)
    done.push(`${a.label}：${join(a.dir, NAME)}`)
  }

  done.push(...(await removeLegacyMcp()))
  return done
}
