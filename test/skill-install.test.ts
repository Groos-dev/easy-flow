/**
 * 设置页「CLI 与 Skill」的安装状态判定：链接解到同一份 skill 就算装好。
 *
 * 最要紧的一条是**应用从工作区（worktree）里跑**：这时 skill 源算的是工作区那份，
 * 而机器上的链接多半指向主 checkout——两边其实是同一份 skill，不该报未安装。
 * 反过来，链接断了（目标被删）要如实报未安装。
 *
 * 全程在临时 HOME 上跑，绝不碰用户的 ~/.agents/skills 与 ~/.claude/skills。
 *
 * 运行：pnpm test
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { skillPlan } from '../server/skill-install.ts'

const TMP = join(tmpdir(), `easy-flow-skill-${basename(process.cwd())}`)
const HOME = join(TMP, 'home')
/** 假装是另一份 checkout 的 skill 根目录（链接指向它，而不是当前这份） */
const OTHER = join(TMP, 'other-checkout', 'skill')

const SKILLS = ['easy-flow', 'todo']
const AGENT_DIRS = ['.claude', '.cursor', '.codex']

function writeSkill(root: string, name: string) {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `# ${name}\n`)
}

function link(from: string, to: string) {
  mkdirSync(dirname(from), { recursive: true })
  symlinkSync(to, from)
}

/** 照安装时那样链起来：home 指向 skill 源，三个 agent 的目录再指向 home（程小帮直接读 home） */
function linkAll(sourceRoot: string) {
  for (const name of SKILLS) {
    const home = join(HOME, '.agents', 'skills', name)
    link(home, join(sourceRoot, name))
    for (const agent of AGENT_DIRS) link(join(HOME, agent, 'skills', name), home)
  }
}

describe('skill 安装状态', () => {
  let originalHome: string | undefined

  before(() => {
    originalHome = process.env.HOME
    rmSync(TMP, { recursive: true, force: true })
    process.env.HOME = HOME
    writeSkill(OTHER, 'easy-flow')
    writeSkill(OTHER, 'todo')
  })

  after(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    rmSync(TMP, { recursive: true, force: true })
  })

  beforeEach(() => {
    rmSync(join(HOME, '.agents'), { recursive: true, force: true })
    for (const agent of AGENT_DIRS) rmSync(join(HOME, agent), { recursive: true, force: true })
  })

  // 顺序与 agentDirs() 一致：claude / cursor / codex，最后是直接读 ~/.agents/skills 的程小帮
  const linked = async () => (await skillPlan()).agents.map((a) => a.linked)
  const FOUR = (v: boolean) => [v, v, v, v]

  test('什么都没装：四个 agent 都报未安装', async () => {
    assert.deepEqual(await linked(), FOUR(false))
  })

  test('链到别处那份 checkout 也算装好', async () => {
    linkAll(OTHER)
    assert.deepEqual(await linked(), FOUR(true))
  })

  test('程小帮直接读共享目录：home 链接对了就算装好，不需要自己那层', async () => {
    linkAll(OTHER)
    const cxb = (await skillPlan()).agents.find((a) => a.id === 'chengxiaobang')
    assert.ok(cxb, '设置页要能看到程小帮这一行')
    assert.equal(cxb.label, '程小帮')
    assert.equal(cxb.dir, join(HOME, '.agents', 'skills'))
    assert.equal(cxb.linked, true)

    // 只拆掉 home 链接，程小帮跟着变成未安装
    rmSync(join(HOME, '.agents', 'skills', 'todo'))
    const after = (await skillPlan()).agents.find((a) => a.id === 'chengxiaobang')
    assert.equal(after?.linked, false)
  })

  test('链到当前这份 checkout 同样算装好', async () => {
    const { source } = await skillPlan()
    assert.ok(source)
    linkAll(source)
    assert.deepEqual(await linked(), FOUR(true))
  })

  test('链接断了（目标被删）要露馅', async () => {
    linkAll(OTHER)
    rmSync(OTHER, { recursive: true, force: true })
    assert.deepEqual(await linked(), FOUR(false))
  })

  test('home 链接指向别的 skill：名字对不上，不算', async () => {
    linkAll(OTHER)
    const home = join(HOME, '.agents', 'skills', 'easy-flow')
    rmSync(home)
    link(home, join(OTHER, 'todo'))
    assert.deepEqual(await linked(), FOUR(false))
  })

  test('home 链接指着个空目录（没有 SKILL.md）：不算', async () => {
    linkAll(OTHER)
    const bare = join(TMP, 'bare', 'easy-flow')
    mkdirSync(bare, { recursive: true })
    const home = join(HOME, '.agents', 'skills', 'easy-flow')
    rmSync(home)
    link(home, bare)
    assert.deepEqual(await linked(), FOUR(false))
  })
})
