/**
 * 安装包里的技能、命令行、图标不再沿仓库相对路径找。
 * 开发态（没有安装包资源目录）仍走仓库里的文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppServer } from '../server/codex.ts'
import { iconFile } from '../server/app-paths.ts'
import { installSkill, skillPlan } from '../server/skill-install.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))

function resourcesFixture(root: string): string {
  const resources = join(root, 'Resources')
  for (const name of ['easy-flow', 'todo']) {
    mkdirSync(join(resources, 'skill', name), { recursive: true })
    writeFileSync(join(resources, 'skill', name, 'SKILL.md'), `# ${name}\n`)
  }
  return resources
}

test('图标：已打包读 Resources，开发态从 out/main 往上两级', () => {
  assert.equal(iconFile(true, '/App/Contents/Resources', '/App/out/main'), '/App/Contents/Resources/icon.png')
  assert.equal(
    iconFile(false, '/Electron.app/Contents/Resources', '/repo/out/main'),
    '/repo/resources/icon.png',
  )
})

test('有安装包资源时，技能和命令行指向 Resources 而不是仓库', async () => {
  const root = join(tmpdir(), `easy-flow-pack-paths-${process.pid}`)
  const home = join(root, 'home')
  const resources = resourcesFixture(root)
  const prevHome = process.env.HOME
  const prevResources = process.env.EASY_FLOW_RESOURCES
  process.env.HOME = home
  process.env.EASY_FLOW_RESOURCES = resources
  try {
    const plan = await skillPlan()
    assert.equal(plan.source, join(resources, 'skill'))
    assert.equal(plan.cli, join(resources, 'cli', 'index.mjs'))
    assert.equal(plan.problem, null)

    const outcome = await installSkill()
    assert.deepEqual(outcome.failed, [])
    const shim = readFileSync(join(home, '.local', 'bin', 'easy-flow'), 'utf8')
    assert.match(shim, /ELECTRON_RUN_AS_NODE=1/)
    assert.match(shim, /MacOS\/easy-flow/)
    assert.match(shim, /cli\/index\.mjs/)
    assert.doesNotMatch(shim, /server\/cli\.ts/)
    assert.equal(realpathSync(join(home, '.agents', 'skills', 'easy-flow')), realpathSync(join(resources, 'skill', 'easy-flow')))
    assert.equal(realpathSync(join(home, '.agents', 'skills', 'todo')), realpathSync(join(resources, 'skill', 'todo')))
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevResources === undefined) delete process.env.EASY_FLOW_RESOURCES
    else process.env.EASY_FLOW_RESOURCES = prevResources
    rmSync(root, { recursive: true, force: true })
  }
})

test('没有安装包资源时，命令行仍是仓库里的 server/cli.ts', async () => {
  const prev = process.env.EASY_FLOW_RESOURCES
  delete process.env.EASY_FLOW_RESOURCES
  try {
    const plan = await skillPlan()
    assert.equal(plan.cli, join(REPO, 'server', 'cli.ts'))
    assert.equal(plan.source, join(REPO, 'skill'))
  } finally {
    if (prev === undefined) delete process.env.EASY_FLOW_RESOURCES
    else process.env.EASY_FLOW_RESOURCES = prev
  }
})

test('app-server 经登录 shell 启动（PATH 才不会缺 node）', async () => {
  const root = join(tmpdir(), `easy-flow-codex-bin-${process.pid}`)
  mkdirSync(root)
  const marker = join(root, 'spawned')
  const shellArgs = join(root, 'shell-args')
  const bin = join(root, 'codex-bin')
  const shell = join(root, 'shell')
  // echo 是 shell 内建。测试把 PATH 收成临时目录后，外部命令 touch 不在路径里。
  writeFileSync(bin, `#!/bin/sh\necho ok > ${JSON.stringify(marker)}\nexit 0\n`)
  // 同一个 shell 要接两次调用：先 `command -v codex`，再 `exec "$0" "$@"` 拉起 codex
  writeFileSync(
    shell,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(shellArgs)}
if [ "$2" = 'command -v codex' ]; then echo ${JSON.stringify(bin)}; exit 0; fi
shift 2
exec "$@"
`,
  )
  chmodSync(bin, 0o755)
  chmodSync(shell, 0o755)
  const prevShell = process.env.SHELL
  const prevPath = process.env.PATH
  process.env.SHELL = shell
  process.env.PATH = root
  try {
    await assert.rejects(AppServer.start(), /提前退出/)
    assert.equal(existsSync(marker), true)
    assert.match(readFileSync(shellArgs, 'utf8'), /-lc exec "\$0" "\$@" .*codex-bin app-server/m)
  } finally {
    if (prevShell === undefined) delete process.env.SHELL
    else process.env.SHELL = prevShell
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    rmSync(root, { recursive: true, force: true })
  }
})
