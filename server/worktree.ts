/**
 * worktree 的 git 交互层。
 *
 * 需求目录里没有指向 worktree 的反向指针，所以归属只能靠创建时落库。
 * 创建不回滚：重试是幂等的，而回滚要先判断"哪些是本次造的"，判错一次就是数据丢失。
 *
 * git 一律经登录 shell 解析绝对路径再执行：MCP 进程由 agent 拉起，PATH 未必是全的
 * （与 mcp-install.ts 同一个坑）。
 */
import { execFile } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { renderWorktreeAgents } from './convention.ts'
import { parseFrontmatter } from './markdown.ts'

/** info/exclude 里那几行的抬头注释，同时当"我们写过"的标记用，避免重复追加 */
const EXCLUDE_MARK = '# easy-flow：需求软链与身份文件，勿删'
/** 不让 easy-flow 的三件产物进 git status */
const EXCLUDE_LINES = ['/requirement.md', '/AGENTS.md', '/CLAUDE.md']
/** 同上，去掉开头的斜杠，便于和 git status 的输出比对 */
const OURS = EXCLUDE_LINES.map((f) => f.slice(1))

let gitPath: string | null = null

function exec(bin: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(failureDetail(stderr, err.message)))
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * 从 stderr 里挑出真正的原因。git 会先往 stderr 写进度行
 * （如 Preparing worktree (new branch 'x')），取首行会把 fatal 那句挤掉。
 */
function failureDetail(stderr: string, fallback: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return [...lines].reverse().find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? fallback
}

/** 登录 shell 里解析 git 的绝对路径，进程内只做一次 */
async function gitBinary(): Promise<string> {
  if (gitPath) return gitPath
  const shell = process.env.SHELL ?? '/bin/zsh'
  try {
    const found = (await exec(shell, ['-lc', 'command -v git'])).trim().split('\n').pop()?.trim()
    if (!found) throw new Error('empty')
    gitPath = found
  } catch {
    throw new Error(`找不到 git 命令（SHELL=${shell}）：确认已安装，且在登录 shell 的 PATH 里`)
  }
  return gitPath
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    return (await exec(await gitBinary(), args, cwd)).trim()
  } catch (err) {
    throw new Error(`git ${args[0]} 失败：${(err as Error).message}`)
  }
}

// ------------------------------------------------------------------ 仓库

export interface RepoCheckout {
  /** 仓库名 = 主 checkout 的目录名 */
  repo: string
  /** 主 checkout 绝对路径 */
  main: string
}

/** 仓库根目录。默认 ~/repo，测试与多盘用 EASY_FLOW_REPO_ROOTS 覆盖（冒号分隔） */
function repoRoots(): string[] {
  const raw = process.env.EASY_FLOW_REPO_ROOTS
  return (raw ? raw.split(':') : [join(homedir(), 'repo')])
    .filter(Boolean)
    .map((r) => (r.startsWith('~') ? join(homedir(), r.slice(1)) : r))
}

/** 认出一个 checkout 属于哪个仓库。主 worktree 由 git 排在 list 首位，比推 --git-common-dir 稳 */
async function describeCheckout(path: string): Promise<RepoCheckout> {
  const here = await git(['rev-parse', '--show-toplevel'], path)
  const head = (await git(['worktree', 'list', '--porcelain'], here)).split('\n\n')[0] ?? ''
  const main = /^worktree (.+)$/m.exec(head)?.[1]?.trim()
  if (!main || !existsSync(main)) throw new Error(`认不出 ${path} 的主 checkout`)
  return { repo: basename(main), main }
}

/**
 * 解析 repo 参数：绝对路径（或 ~ 开头）直接用；仓库名在 repoRoots 下按目录名找。
 * 找不到或重名时报错并给出候选，不猜。
 */
export async function resolveCheckout(repo: string): Promise<RepoCheckout> {
  const asPath = repo.startsWith('~') ? join(homedir(), repo.slice(1)) : repo
  if (asPath.startsWith('/')) {
    if (!existsSync(asPath)) throw new Error(`路径不存在：${asPath}`)
    return describeCheckout(asPath)
  }

  const roots = repoRoots()
  const hits = roots.flatMap((root) => findRepo(root, repo, 2))
  if (hits.length === 1) return describeCheckout(hits[0])
  if (!hits.length) {
    throw new Error(
      `没找到仓库「${repo}」：在 ${roots.join('、')} 下按目录名找（两层以内），也可以直接传主 checkout 的绝对路径`,
    )
  }
  throw new Error(`仓库名「${repo}」有多个候选，请传绝对路径：\n${hits.slice(0, 5).join('\n')}`)
}

/** 在 root 下按目录名找 git 仓库。深度受限，跳过点开头与 node_modules */
function findRepo(root: string, name: string, depth: number): string[] {
  if (depth < 0 || !existsSync(root)) return []
  const hits: string[] = []
  const walk = (dir: string, left: number): void => {
    for (const entry of readdirSafe(dir)) {
      if (entry.startsWith('.') || entry === 'node_modules') continue
      const p = join(dir, entry)
      const st = lstatOrNull(p)
      if (!st?.isDirectory() || st.isSymbolicLink()) continue
      if (entry === name && existsSync(join(p, '.git'))) hits.push(p)
      else if (left > 0) walk(p, left - 1)
    }
  }
  walk(root, depth - 1)
  return hits
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** worktree 路径：主 checkout 旁边，`<仓库名>.<分支扁平化>`。分支里的 / 会坏掉目录名 */
export function worktreePathFor(main: string, branch: string): string {
  return join(dirname(main), `${basename(main)}.${branch.replace(/\//g, '-')}`)
}

// ------------------------------------------------------------------ 创建

export interface Provision {
  path: string
  /** 目录是本次 add 出来的。false = 复用了已存在的 worktree */
  created: boolean
  /** 分支是本次新建的 */
  branchCreated: boolean
  /** worktree 里能读到 wt- id。false = 已有一份别人的 AGENTS.md，身份只在库里 */
  identityInFile: boolean
  /** info/exclude 的结果，直接说给 agent 听（补上了 / 没补上） */
  excludeNote: string
}

export interface ProvisionInput {
  /** 写进 worktree 的 AGENTS.md，落库也用同一个 */
  worktreeId: string
  requirementId: string
  requirementDir: string
  target: RepoCheckout
  branch: string
  /** 新分支的起点，缺省主 checkout 当前的 HEAD */
  base?: string
}

/**
 * 建出 worktree 并补齐产物。
 *
 * 失败不回滚：重试是幂等的（已存在的目录走认领，wt id 从它自己的 AGENTS.md 读回来），
 * 而回滚要判断"哪些是本次造的、哪些是别人的"，判错一次就是数据丢失——
 * 留半个现场，比删错东西便宜。
 */
export async function provisionWorktree(input: ProvisionInput): Promise<Provision> {
  const { target, branch } = input
  await git(['check-ref-format', '--branch', branch], target.main)

  const path = worktreePathFor(target.main, branch)
  const registered = await registeredWorktrees(target.main)
  const mine = registered.find((w) => w.path === path)
  if (mine && mine.branch && mine.branch !== branch) {
    throw new Error(`${path} 已登记给分支 ${mine.branch}，换路径或换分支`)
  }
  if (existsSync(path) && !mine) {
    throw new Error(`${path} 已被占用（不是已登记的 worktree），先腾开它`)
  }
  const elsewhere = registered.find((w) => w.branch === branch && w.path !== path)
  if (elsewhere) throw new Error(`分支 ${branch} 已在 ${elsewhere.path} 检出，一个分支只能有一处`)

  let created = false
  let branchCreated = false
  if (!mine) {
    if (await hasLocalBranch(target.main, branch)) {
      await git(['worktree', 'add', path, branch], target.main)
    } else {
      await git(['worktree', 'add', '-b', branch, path, input.base?.trim() || 'HEAD'], target.main)
      branchCreated = true
    }
    created = true
  }

  const agentsCreated = writeAgentsFile(input, path)
  ensureSymlink(join(path, 'requirement.md'), join(input.requirementDir, 'requirement.md'))
  // 最后这步只影响观感，成败都不该拖垮创建
  const excludeNote = await ensureExclude(target.main)

  return {
    path,
    created,
    branchCreated,
    identityInFile: agentsCreated || !!worktreeIdIn(path),
    excludeNote,
  }
}

// ------------------------------------------------------------------ 移除

export interface Deprovision {
  /** 目录本来就不在（只清了记录与 git 登记） */
  missing: boolean
  /** 被丢弃的未提交改动条数 */
  discarded: string[]
}

/** 删掉 worktree。脏工作区要 force 才动，分支永不删（里面可能有提交） */
export async function deprovisionWorktree(input: {
  path: string
  main: string
  branch: string
  force: boolean
}): Promise<Deprovision> {
  const { path, main, force } = input
  if (!existsSync(path)) {
    // 主 checkout 也可能跟着没了（换盘、搬家）：清记录不该因为它而失败
    try {
      await git(['worktree', 'prune'], main)
    } catch {
      /* 主 checkout 不在，无处可 prune */
    }
    return { missing: true, discarded: [] }
  }

  const registered = await registeredWorktrees(main)
  if (registered.some((w) => w.path === path)) {
    const discarded = (await git(['status', '--porcelain'], path))
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l && !OURS.includes(l.slice(3).trim()))
    if (discarded.length && !force) {
      const shown = discarded.slice(0, 5).join('\n')
      throw new Error(`worktree 里有未提交改动，确认丢弃请传 force：\n${shown}`)
    }
    await git(['worktree', 'remove', '--force', path], main)
    await git(['worktree', 'prune'], main)
    return { missing: false, discarded }
  }

  // git 登记不在了（被别处 prune 或手工删过元数据），目录还在：按目录删。
  // 这种目录连 git status 都问不出来，证明不了干净，所以只能要求 force；
  // 另外再看一眼它停在哪，对不上就不动——那说明它已经不是记录里那个 worktree 了。
  const here = await branchOf(path)
  if (here && here !== input.branch) {
    throw new Error(`${path} 现在停在分支 ${here}，不是记录里的 ${input.branch}，不敢删`)
  }
  if (!force) {
    throw new Error(`${path} 已不在 ${main} 的 git 登记里，判断不了工作区是否干净；确认丢弃请传 force`)
  }
  rmSync(path, { recursive: true, force: true })
  return { missing: false, discarded: [] }
}

// ------------------------------------------------------------------ 零件

/** 已登记的 worktree：路径与它检出的分支 */
async function registeredWorktrees(main: string): Promise<Array<{ path: string; branch: string }>> {
  const out = await git(['worktree', 'list', '--porcelain'], main)
  return out
    .split('\n\n')
    .map((block) => ({
      path: /^worktree (.+)$/m.exec(block)?.[1]?.trim() ?? '',
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? '',
    }))
    .filter((w) => w.path)
}

async function hasLocalBranch(main: string, branch: string): Promise<boolean> {
  const out = await git(['branch', '--list', '--format=%(refname:short)'], main)
  return out.split('\n').some((l) => l.trim() === branch)
}

/** 目录当前停在哪个分支。不是 git 仓库、或元数据已坏，都返回空串 */
async function branchOf(path: string): Promise<string> {
  try {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], path)
    return branch === 'HEAD' ? '' : branch
  } catch {
    return ''
  }
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** worktree 的 AGENTS.md 里写的身份 id（没有则空串） */
export function worktreeIdIn(path: string): string {
  try {
    const { data } = parseFrontmatter(readFileSync(join(path, 'AGENTS.md'), 'utf8'))
    return data.id?.startsWith('wt-') ? data.id : ''
  } catch {
    return ''
  }
}

/**
 * 身份文件。已经有一份不是 easy-flow 写的就留着——那份多半是仓库自己的 agent 指令，
 * 覆盖它会把仓库的约束弄丢（返回值告诉调用方这次到底写没写）。
 */
function writeAgentsFile(input: ProvisionInput, path: string): boolean {
  const file = join(path, 'AGENTS.md')
  if (existsSync(file)) return false
  writeFileSync(
    file,
    renderWorktreeAgents({
      id: input.worktreeId,
      requirementId: input.requirementId,
      requirementDir: input.requirementDir,
      repo: input.target.repo,
      branch: input.branch,
    }),
    'utf8',
  )
  return true
}

/** 已存在且指向同一目标算成功；指向别处、或占位的是普通文件，都报错不覆盖 */
function ensureSymlink(link: string, target: string): void {
  const st = lstatOrNull(link)
  if (!st) {
    symlinkSync(target, link)
    return
  }
  if (!st.isSymbolicLink()) throw new Error(`${link} 已存在且不是软链，不覆盖`)
  const current = readlinkSync(link)
  if (current !== target) throw new Error(`${link} 已指向 ${current}，不覆盖`)
}

/**
 * 让产物不进 git status。info/exclude 是仓库级共享文件，按行判重所以能反复调。
 * 这只是观感问题（多几个 untracked 文件），失败也不该拖垮创建，所以只回一句话。
 */
async function ensureExclude(main: string): Promise<string> {
  try {
    const file = await git(
      // --path-format=absolute 不能省：默认给的是相对路径，而进程 cwd 不在这个仓库里
      ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      main,
    )
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const present = new Set(text.split('\n').map((l) => l.trim()))
    const added = EXCLUDE_LINES.filter((l) => !present.has(l))
    if (!added.length) return ''
    const block = present.has(EXCLUDE_MARK) ? added : [EXCLUDE_MARK, ...added]
    mkdirSync(dirname(file), { recursive: true })
    const gap = !text || text.endsWith('\n') ? '' : '\n'
    // 临时文件 + rename：两个 agent 同时建 worktree 时别把对方的行截掉
    const tmp = `${file}.easy-flow-${process.pid}`
    writeFileSync(tmp, `${text}${gap}${block.join('\n')}\n`, 'utf8')
    renameSync(tmp, file)
    return `已补 ${file}（让 AGENTS.md 与软链不进 git status）`
  } catch (err) {
    return `没能补 info/exclude：${(err as Error).message}；不影响使用，只是 git status 会多出 AGENTS.md 与软链`
  }
}
