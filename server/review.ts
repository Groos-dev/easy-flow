import { execFile } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Worktree } from './db.ts'
import { AppServer } from './codex.ts'
import { parseFrontmatter } from './markdown.ts'

const exec = promisify(execFile)

interface ReviewInput {
  worktree: Worktree
  requirementPath: string
  context: string
  title: string
  base?: string
  recheck?: string
  model?: string
  getSession: () => string | undefined
  onSessionResolved: (id: string) => void
}

/**
 * 在独立 Codex 会话中评审工作区，将结论与运行日志保存到需求目录。
 */
export async function reviewWorktree(input: ReviewInput) {
  const reviewDir = join(input.requirementPath, 'docs', 'review')
  mkdirSync(reviewDir, { recursive: true })
  const lockPath = join(reviewDir, `.${input.worktree.id}.lock`)
  writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' })
  try {
    return await runReview(input, reviewDir)
  } finally {
    rmSync(lockPath)
  }
}

async function runReview(input: ReviewInput, reviewDir: string) {
  const { worktree } = input
  const git = async (args: string[], cwd = worktree.path) => (
    await exec('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024 })
  ).stdout.trim()
  const reports = readdirSync(reviewDir).flatMap((name) => {
    const match = /^(\d+)-(?:review|recheck)\.md$/.exec(name)
    return match ? [{ name, round: Number(match[1]) }] : []
  }).sort((a, b) => b.round - a.round)
  let previous = ''
  let previousPath = ''
  let baseRef = input.base
  if (input.recheck) {
    previousPath = realpathSync(input.recheck)
    if (dirname(previousPath) !== realpathSync(reviewDir)) {
      throw new Error('Recheck report must belong to this requirement')
    }
    previous = readFileSync(previousPath, 'utf8')
    const { data } = parseFrontmatter(previous)
    if (data.requirement !== worktree.requirementId || data.worktree !== worktree.id ||
      !['completed', 'failed'].includes(data.status) || !data.base || !data.session) {
      throw new Error('Recheck requires a finished report with a session for the same worktree')
    }
    baseRef = data.base
  }
  let sessionId = input.getSession() ?? ''
  if (!sessionId) {
    let hasUnresolvedHistory = false
    for (const report of reports) {
      const path = join(reviewDir, report.name)
      const { data } = parseFrontmatter(readFileSync(path, 'utf8'))
      if (!data.requirement || !data.worktree) throw new Error(`Review report is missing ownership: ${path}`)
      if (data.requirement !== worktree.requirementId || data.worktree !== worktree.id) continue
      if (data.session) {
        sessionId = data.session
        break
      }
      if (data.status !== 'failed' || data.creation_requested !== 'false') hasUnresolvedHistory = true
    }
    if (!sessionId && hasUnresolvedHistory) throw new Error(`Cannot determine the existing reviewer for ${worktree.id}`)
  }
  const existingSessionId = sessionId
  if (sessionId) input.onSessionResolved(sessionId)
  if (baseRef === undefined) {
    const mainHead = await git(['rev-parse', 'HEAD'], worktree.main)
    baseRef = await git(['merge-base', 'HEAD', mainHead])
  }
  const base = await git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])
  const head = await git(['rev-parse', 'HEAD'])
  const diff = await git(['diff', '--stat', base, '--'])
  const untracked = await git(['ls-files', '--others', '--exclude-standard'])
  let round = (reports[0]?.round ?? 0) + 1
  const pathsForRound = (number: number) => {
    const name = `${String(number).padStart(2, '0')}-${input.recheck ? 'recheck' : 'review'}`
    return { name, reportPath: join(reviewDir, `${name}.md`), logPath: join(reviewDir, `${name}.log`) }
  }
  let paths = pathsForRound(round)
  let creationRequested = false
  const render = (status: string, body: string) => [
    '---',
    `requirement: ${worktree.requirementId}`,
    `worktree: ${worktree.id}`,
    `base: ${base}`,
    `head: ${head}`,
    `status: ${status}`,
    `session: ${sessionId}`,
    `creation_requested: ${creationRequested}`,
    '---',
    '',
    `# ${input.recheck ? '复查' : '评审'} · ${paths.name}`,
    '',
    `- 工作区：${worktree.path}`,
    `- 日志：${paths.logPath}`,
    ...(previousPath ? [`- 上一轮报告：${previousPath}`] : []),
    '- 范围：基线到当前工作区，包含已提交、暂存、未暂存和未跟踪文件。',
    '',
    body,
    '',
  ].join('\n')
  const prompt = [
    '你是独立代码 reviewer。本轮仅评审，原 coding 会话等待你的结果后负责修复。',
    '本轮属于评审角色，只产出报告；不再调用 easy-flow review，不修改代码、需求文档或看板状态。',
    '使用 self-codereview 的检查口径：简洁、架构正确性、冗余、死代码及正确性。',
    '以需求、验收和已确认决策为依据，主动阅读下列文档正文、完整文件及相关调用链。',
    '独立核对代码证据，区分确定缺陷和待确认项；改法限定在已确认需求内。',
    '输出简体中文 Markdown，包含验收对照、按严重度排列的问题、待确认项和验证结果。',
    '每个问题用 F-1、F-2 等编号，给出 file_path:line_number、证据、影响及最小改法。',
    '没有问题也明确写出结论和验证范围；未运行的检查标为未验证。',
    ...(previous ? ['这是修复后的复查。逐条核对上一轮问题及处理证据，并检查修复引入的回归。'] : []),
    '',
    input.context,
    '',
    `需求目录：${input.requirementPath}`,
    `工作区：${worktree.id} ${worktree.path}`,
    `固定基线：${base}`,
    `评审 HEAD：${head}`,
    `使用 git diff ${base} -- 查看已提交与未提交的整体改动，另外读取未跟踪文件。`,
    '',
    '## 改动统计',
    diff || '已跟踪文件没有改动。',
    '',
    '## 未跟踪文件',
    untracked || '无',
    ...(previous ? ['', `## 上一轮报告与处理记录（${previousPath}）`, previous] : []),
  ].join('\n')
  for (;;) {
    try {
      writeFileSync(paths.reportPath, render('running', '评审正在执行，结论待生成。'), { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      paths = pathsForRound(++round)
    }
  }
  const { reportPath, logPath } = paths
  const save = (status: string, body: string) => {
    writeFileSync(`${reportPath}.tmp`, render(status, body))
    renameSync(`${reportPath}.tmp`, reportPath)
  }
  writeFileSync(logPath, '')
  let error = ''
  let server: AppServer | undefined
  try {
    server = await AppServer.start((text) => appendFileSync(logPath, text))
    if (!existingSessionId) {
      // 请求前落盘，断连后保留“可能已创建”的事实。
      creationRequested = true
      save('running', '评审正在执行，结论待生成。')
    }
    const started = await server.call(sessionId ? 'thread/resume' : 'thread/start', {
      cwd: worktree.path,
      runtimeWorkspaceRoots: [worktree.path],
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ...(sessionId ? { threadId: sessionId } : {
        ephemeral: false,
        threadSource: 'easy-flow-review',
      }),
      ...(input.model ? { model: input.model } : {}),
    }) as { thread: { id: string } }
    if (existingSessionId && started.thread.id !== existingSessionId) {
      throw new Error('Codex resumed a different reviewer session')
    }
    sessionId = started.thread.id
    if (!existingSessionId) {
      input.onSessionResolved(sessionId)
      save('running', '评审正在执行，结论待生成。')
    }
    await server.call('thread/name/set', { threadId: sessionId, name: input.title })
    const result = (await server.runTurn(sessionId, prompt, (event) => {
      appendFileSync(logPath, `${JSON.stringify(event)}\n`)
    })).trim()
    if (!result) throw new Error('Codex returned no review conclusion')
    save('completed', `${result}\n\n## 处理结果\n\n由原 coding 会话逐条追加问题编号、处理结论和验证证据。`)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    save('failed', `## 执行失败\n\n${error}\n\n本轮未取得有效评审结论。`)
  } finally {
    server?.close()
  }
  return { ok: !error, reportPath, logPath, sessionId, ...(error ? { error: `${error}; report: ${reportPath}` } : {}) }
}
