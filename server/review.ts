import { execFile } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
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
  onSessionStarted: (id: string) => void
}

/**
 * 在独立 Codex 会话中评审工作区，将结论与运行日志保存到需求目录。
 */
export async function reviewWorktree(input: ReviewInput) {
  const { worktree } = input
  const git = async (args: string[], cwd = worktree.path) => (
    await exec('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024 })
  ).stdout.trim()
  const reviewDir = join(input.requirementPath, 'docs', 'review')
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
      data.status !== 'completed' || !data.base) {
      throw new Error('Recheck requires a completed report for the same worktree')
    }
    baseRef = data.base
  }
  if (baseRef === undefined) {
    const mainHead = await git(['rev-parse', 'HEAD'], worktree.main)
    baseRef = await git(['merge-base', 'HEAD', mainHead])
  }
  const base = await git(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])
  const head = await git(['rev-parse', 'HEAD'])
  const diff = await git(['diff', '--stat', base, '--'])
  const untracked = await git(['ls-files', '--others', '--exclude-standard'])
  mkdirSync(reviewDir, { recursive: true })
  const round = 1 + Math.max(0, ...readdirSync(reviewDir).map((name) =>
    Number(/^(\d+)-(?:review|recheck)\.md$/.exec(name)?.[1] ?? 0),
  ))
  const name = `${String(round).padStart(2, '0')}-${input.recheck ? 'recheck' : 'review'}`
  const reportPath = join(reviewDir, `${name}.md`)
  const logPath = join(reviewDir, `${name}.log`)
  let sessionId = ''
  const save = (status: string, body: string) => {
    const report = [
      '---',
      `requirement: ${worktree.requirementId}`,
      `worktree: ${worktree.id}`,
      `base: ${base}`,
      `head: ${head}`,
      `status: ${status}`,
      `session: ${sessionId}`,
      '---',
      '',
      `# ${input.recheck ? '复查' : '评审'} · ${name}`,
      '',
      `- 工作区：${worktree.path}`,
      `- 日志：${logPath}`,
      ...(previousPath ? [`- 上一轮报告：${previousPath}`] : []),
      '- 范围：基线到当前工作区，包含已提交、暂存、未暂存和未跟踪文件。',
      '',
      body,
      '',
    ].join('\n')
    writeFileSync(`${reportPath}.tmp`, report)
    renameSync(`${reportPath}.tmp`, reportPath)
  }
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
  save('running', '评审正在执行，结论待生成。')
  writeFileSync(logPath, '')
  let error = ''
  let server: AppServer | undefined
  try {
    server = await AppServer.start((text) => appendFileSync(logPath, text))
    const started = await server.call('thread/start', {
      cwd: worktree.path,
      runtimeWorkspaceRoots: [worktree.path],
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: false,
      threadSource: 'easy-flow-review',
      ...(input.model ? { model: input.model } : {}),
    }) as { thread: { id: string } }
    sessionId = started.thread.id
    input.onSessionStarted(sessionId)
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
