#!/usr/bin/env node
/**
 * 桌面应用的启停：start / stop / restart / status。
 *
 * 只管桌面应用（electron-vite dev），不含 web 那套（pnpm dev:web）。
 * 启动是脱离终端的：另起一个进程组，日志与 PID 落在 .tmp/，所以关掉终端窗口
 * 应用不会跟着死；停止按进程组杀，免得留下孤儿 electron。
 *
 * 想在终端里盯着日志看，直接用 pnpm dev；这个脚本是给「起了就走」准备的。
 *
 * 用法：pnpm app start | stop | restart | status
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP = join(ROOT, '.tmp')
const PID_FILE = join(TMP, 'app.pid')
const LOG_FILE = join(TMP, 'app.log')
const LOG_ROTATED = join(TMP, 'app.log.1')
/** 日志只留一代：超过这个大小就在启动时挪走，别让它无限涨 */
const LOG_MAX_BYTES = 5 * 1024 * 1024

/** 内嵌服务端口，用来判断应用有没有起来（见 server/index.ts 的 DEFAULT_PORT） */
const PORT = 3210
/** 启动最多等这么久：electron-vite 要先编主进程与 preload，再拉 electron */
const BOOT_TIMEOUT_MS = 40_000
/** 停止时留给进程的退出时间，超时就 SIGKILL */
const STOP_TIMEOUT_MS = 6_000
const POLL_MS = 400

const rel = (p) => p.replace(`${ROOT}/`, '')

// ------------------------------------------------------------------ 进程

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 是不是这个应用的进程。
 *
 * 只看命令行里有没有 electron 与 easy-flow：端口是固定的，同时只可能跑一个实例，
 * 所以不区分它从哪个 checkout 起（主目录还是哪个工作区）——能停掉才算数。
 */
function isOurs(pid) {
  const cmd = capture('ps', ['-o', 'command=', '-p', String(pid)])
  return /electron/i.test(cmd) && /easy-flow/.test(cmd)
}

function pidsOnPort(port) {
  const out = capture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  return out ? out.split('\n').filter(Boolean).map(Number) : []
}

/** 内嵌服务在听 = 应用起来了（它跟着 electron 主进程起落） */
function running() {
  return pidsOnPort(PORT).some(isOurs)
}

function readPidFile() {
  if (!existsSync(PID_FILE)) return null
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** 脚本自己起的那个实例的组长 pid；不在跑就是 null */
function scriptPid() {
  const pid = readPidFile()
  return pid && isAlive(pid) ? pid : null
}

/** 该被停掉的进程：脚本起的组长 + electron-vite + 占着内嵌服务端口的 electron 主进程 */
function targets() {
  const set = new Set()
  const pid = scriptPid()
  if (pid) set.add(pid)
  for (const p of capture('pgrep', ['-f', 'electron-vite/bin/electron-vite.js dev'])
    .split('\n')
    .filter(Boolean)
    .map(Number)) {
    if (isOurs(p)) set.add(p)
  }
  for (const p of pidsOnPort(PORT)) {
    if (isOurs(p)) set.add(p)
  }
  return [...set]
}

function signal(pid, sig) {
  // 先当进程组杀：脚本起的实例自成一组，这样能把 electron 一起带走
  try {
    process.kill(-pid, sig)
    return
  } catch {
    /* 不是组长（比如手工在终端里起的），单杀 */
  }
  try {
    process.kill(pid, sig)
  } catch {
    /* 已经没了 */
  }
}

/** 启动时转一次：服务是追加写的，只有这里能动手 */
function rotateLog() {
  if (!existsSync(LOG_FILE) || statSync(LOG_FILE).size < LOG_MAX_BYTES) return
  rmSync(LOG_ROTATED, { force: true })
  renameSync(LOG_FILE, LOG_ROTATED)
}

function logTail(lines = 15) {
  if (!existsSync(LOG_FILE)) return '(没有日志)'
  return readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
}

// ------------------------------------------------------------------ 命令

function start() {
  if (running()) {
    console.error(`应用已经在跑（内嵌服务 ${PORT} 已占用）。要重来一次：pnpm app restart`)
    return 1
  }

  mkdirSync(TMP, { recursive: true })
  rotateLog()
  appendFileSync(LOG_FILE, `\n=== 启动 ${new Date().toISOString()} ===\n`)
  const log = openSync(LOG_FILE, 'a')
  const child = spawn('pnpm', ['dev'], {
    cwd: ROOT,
    // 自成进程组：关掉终端不带走应用，停止时也能整组杀
    detached: true,
    stdio: ['ignore', log, log],
  })
  closeSync(log)
  child.unref()

  if (!child.pid) {
    console.error('启动失败：起不来 pnpm（PATH 里有吗）')
    return 1
  }
  writeFileSync(PID_FILE, `${child.pid}\n`)
  console.log(`启动中…（日志 ${rel(LOG_FILE)}，最多等 ${BOOT_TIMEOUT_MS / 1000} 秒）`)

  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (running()) {
      console.log(`已启动（组长 pid ${child.pid}，内嵌服务 ${PORT}）。停：pnpm app stop`)
      return 0
    }
    // 组长已经死了、端口还没起来：启动就失败了，不必等满
    if (!isAlive(child.pid)) break
    sleep(POLL_MS)
  }

  console.error('启动失败，日志尾部：')
  console.error(logTail())
  rmSync(PID_FILE, { force: true })
  return 1
}

function stop(quiet = false) {
  const pids = targets()
  if (!pids.length) {
    rmSync(PID_FILE, { force: true })
    if (!quiet) console.log('应用没在跑。')
    return 0
  }

  for (const pid of pids) signal(pid, 'SIGTERM')
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline && pids.some(isAlive)) sleep(POLL_MS)

  const stubborn = pids.filter(isAlive)
  for (const pid of stubborn) signal(pid, 'SIGKILL')
  if (stubborn.length) sleep(POLL_MS * 2)
  rmSync(PID_FILE, { force: true })

  if (running()) {
    console.error(`停止失败：内嵌服务 ${PORT} 还占着。用 lsof -nP -iTCP:${PORT} -sTCP:LISTEN 看看是谁`)
    return 1
  }
  const killed = stubborn.length ? `，其中 ${stubborn.length} 个是强杀的` : ''
  console.log(`已停止（${pids.length} 个进程${killed}）。`)
  return 0
}

function restart() {
  const code = stop(true)
  if (code !== 0) return code
  return start()
}

function status() {
  const pid = scriptPid()
  if (!running()) {
    console.log(pid ? `没起来（组长 pid ${pid} 还活着，但内嵌服务没听）` : '没在跑。')
    return 0
  }
  const listeners = pidsOnPort(PORT).filter(isOurs)
  const who = pid ? `脚本组长 pid ${pid}` : '不是这个脚本起的'
  console.log(`在跑：内嵌服务 ${PORT}，pid ${listeners.join(', ')}（${who}）`)
  console.log(`日志 ${rel(LOG_FILE)}`)
  return 0
}

// ------------------------------------------------------------------ 入口

const commands = { start, stop, restart, status }
const cmd = process.argv[2]

if (!cmd || !commands[cmd]) {
  console.error('用法：pnpm app start | stop | restart | status')
  process.exit(2)
}
process.exit(commands[cmd]())
