import { SessionState } from '../src/shared/domain.ts'
import { t as tr } from "../src/shared/i18n.ts"
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
      throw new Error(tr("Recheck report must belong to this requirement"))
    }
    previous = readFileSync(previousPath, 'utf8')
    const { data } = parseFrontmatter(previous)
    if (data.requirement !== worktree.requirementId || data.worktree !== worktree.id ||
      !['completed', SessionState.Failed].includes(data.status) || !data.base || !data.session) {
      throw new Error(tr("Recheck requires a finished report with a session for the same worktree"))
    }
    baseRef = data.base
  }
  let sessionId = input.getSession() ?? ''
  if (!sessionId) {
    let hasUnresolvedHistory = false
    for (const report of reports) {
      const path = join(reviewDir, report.name)
      const { data } = parseFrontmatter(readFileSync(path, 'utf8'))
      if (!data.requirement || !data.worktree) throw new Error(tr("Review report is missing ownership: {0}", [path]))
      if (data.requirement !== worktree.requirementId || data.worktree !== worktree.id) continue
      if (data.session) {
        sessionId = data.session
        break
      }
      if (data.status !== SessionState.Failed || data.creation_requested !== 'false') hasUnresolvedHistory = true
    }
    if (!sessionId && hasUnresolvedHistory) throw new Error(tr("Cannot determine the existing reviewer for {0}", [worktree.id]))
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
    `# ${input.recheck ? tr("Recheck") : tr("Review")} · ${paths.name}`,
    '',
    tr("- Workspace: {0}", [worktree.path]),
    tr("- Log: {0}", [paths.logPath]),
    ...(previousPath ? [tr("- Previous report: {0}", [previousPath])] : []),
    tr("- Scope: baseline to current workspace, including committed, staged, unstaged, and untracked files."),
    '',
    body,
    '',
  ].join('\n')
  const prompt = [
    tr("You are the independent code reviewer. Review only; the original coding session will read your results and make fixes."),
    tr("Produce the report only. Do not call easy-flow review or modify code, requirement documents, or board state."),
    tr("Review simplicity, architecture, redundancy, dead code, and correctness."),
    tr("Use the requirement, acceptance criteria, and confirmed decisions. Read the documents below, complete files, and relevant call chains."),
    tr("Check code evidence independently, distinguish confirmed defects from uncertainties, and limit proposed fixes to the agreed scope."),
    tr("Write the Markdown report in English, including acceptance coverage, findings ordered by severity, open questions, and verification results."),
    tr("Number findings F-1, F-2, etc. Include file_path:line_number, evidence, impact, and the smallest appropriate fix."),
    tr("If no defects are found, state that and the verified scope. Mark checks not run as unverified."),
    ...(previous ? [tr("This is a recheck after fixes. Verify every previous finding and its disposition evidence, and check for regressions caused by fixes.")] : []),
    '',
    input.context,
    '',
    tr("Requirement directory: {0}", [input.requirementPath]),
    tr("Workspace: {0} {1}", [worktree.id, worktree.path]),
    tr("Fixed baseline: {0}", [base]),
    tr("Reviewed HEAD: {0}", [head]),
    tr("Use git diff {0} -- to inspect committed and uncommitted changes, and read untracked files separately.", [base]),
    '',
    tr("## Change summary"),
    diff || tr("No tracked-file changes."),
    '',
    tr("## Untracked files"),
    untracked || tr("None"),
    ...(previous ? ['', tr("## Previous report and dispositions ({0})", [previousPath]), previous] : []),
  ].join('\n')
  for (;;) {
    try {
      writeFileSync(paths.reportPath, render('running', tr("Review is running; findings are pending.")), { flag: 'wx' })
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
      save('running', tr("Review is running; findings are pending."))
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
      throw new Error(tr("Codex resumed a different reviewer session"))
    }
    sessionId = started.thread.id
    if (!existingSessionId) {
      input.onSessionResolved(sessionId)
      save('running', tr("Review is running; findings are pending."))
    }
    await server.call('thread/name/set', { threadId: sessionId, name: input.title })
    const result = (await server.runTurn(sessionId, prompt, (event) => {
      appendFileSync(logPath, `${JSON.stringify(event)}\n`)
    })).trim()
    if (!result) throw new Error(tr("Codex returned no review conclusion"))
    save('completed', tr("{0}\n\n## Dispositions\n\nThe original coding session appends finding IDs, dispositions, and verification evidence here.", [result]))
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    save(SessionState.Failed, tr("## Execution failed\n\n{0}\n\nNo valid review conclusions were obtained in this round.", [error]))
  } finally {
    server?.close()
  }
  return { ok: !error, reportPath, logPath, sessionId, ...(error ? { error: `${error}; report: ${reportPath}` } : {}) }
}
