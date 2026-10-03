import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import { join } from 'node:path'
import type { RunningBoardServer } from '../../server/index.ts'
import { TerminalManager } from './terminal.ts'

let win: BrowserWindow | null = null
let boardServer: RunningBoardServer | null = null
let terminals: TerminalManager | null = null

// 开发时开远程调试端口，便于用 CDP 检查渲染进程（黑屏/白屏排查）。
// 必须在 app ready 之前设置。端口避开 Chrome 惯用的 9222。
if (process.env.EASY_FLOW_DEBUG === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.EASY_FLOW_DEBUG_PORT ?? '9229')
}

/**
 * CSP 必须按环境区分：
 *   dev  — Vite 会注入内联脚本（@react-refresh、@vite/client）并开 HMR WebSocket，
 *          script-src 必须放开 inline 与 ws，否则渲染层整页白/黑屏。
 *   prod — 渲染层是本地打包文件，不依赖内联脚本，收紧到 'self'。
 */
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' ws://localhost:* http://localhost:* http://127.0.0.1:*; img-src 'self' data:"
const CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' http://127.0.0.1:*; img-src 'self' data:"

function applyCsp(): void {
  const policy = process.env.ELECTRON_RENDERER_URL ? CSP_DEV : CSP_PROD
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })
}

function registerIpc(): void {
  ipcMain.handle('easy-flow:pick-directory', async () => {
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })

  // ---------------------------------------------------------------- 终端

  ipcMain.handle(
    'terminal:create',
    (event, target: { project: string; slug?: string }, opts: { cols?: number; rows?: number } = {}) => {
      if (!terminals) throw new Error('终端服务未就绪')
      const publish = (channel: string, payload: unknown) => event.sender.send(channel, payload)
      return terminals.create(target, publish, opts)
    },
  )

  ipcMain.on('terminal:input', (_e, id: string, data: string) => terminals?.write(id, data))
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    terminals?.resize(id, cols, rows),
  )
  ipcMain.on('terminal:destroy', (_e, id: string) => terminals?.destroy(id))
}

/**
 * Cmd+, 是 macOS 的系统级约定，挂在应用菜单里最正统
 * （从菜单栏也能打开，不只是快捷键）。
 */
function registerMenu(): void {
  const send = () => win?.webContents.send('easy-flow:open-settings')
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '偏好设置…', accelerator: 'CommandOrControl+,', click: send },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 一次性初始化：配置、IPC、菜单、CSP、内嵌服务、终端管理。
 * 必须在建窗之前完成，且只能跑一次——重复注册 IPC 会抛错、
 * 重复启动服务会 EADDRINUSE，结果就是窗口再也开不出来。
 */
let booted = false

async function boot(): Promise<void> {
  if (booted) return
  booted = true

  // ★ 必须在 import server 之前设置：配置层用它定位 userData。
  //   ESM 的 import 是静态提升的，所以这里用动态 import。
  process.env.EASY_FLOW_USER_DATA = app.getPath('userData')
  process.env.EASY_FLOW_CONFIG = join(app.getPath('userData'), 'config.json')
  const { startBoardServer, DEFAULT_PORT } = await import('../../server/index.ts')

  registerIpc()
  registerMenu()
  applyCsp()
  boardServer = await startBoardServer({ port: DEFAULT_PORT })

  // 终端只需要挂载点目录。需求身份不由环境变量传递——agent 从需求目录里读 id 再显式传给 MCP，
  // 这样在 easy-flow 之外开的终端也能用。
  terminals = new TerminalManager((target) => {
    const project = boardServer?.db.listProjects().find((p) => p.slug === target.project)
    if (!project) return null
    const req = target.slug ? boardServer?.db.get(target.slug, target.project) : undefined
    if (target.slug && !req) return null
    return {
      cwd: req?.path ?? project.root,
      // 身份（需求 id / 项目）都不经环境变量传：agent 从需求目录里读，再显式传给 MCP，
      // 这样在 easy-flow 之外开的终端也能用。这里只留一个"这是本应用开的终端"的标记。
      env: {
        EASY_FLOW_SESSION: '1',
      },
    }
  })
}

async function createWindow(): Promise<void> {
  await boot()
  // 已有窗口就把它带到前台，不再新建（macOS 从 Dock 重开走这里）
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'easy-flow',
    titleBarStyle: 'hiddenInset',
    // 显式固定交通灯位置：默认位置随系统浮动，侧边栏开关没法跟它精确对齐
    trafficLightPosition: { x: 16, y: 15 },
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 外链走系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    win = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady()
  .then(createWindow)
  .catch((err) => {
    console.error('[easy-flow] 启动失败:', err)
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow().catch((err) => {
      console.error('[easy-flow] 重建窗口失败:', err)
    })
  }
})

app.on('before-quit', () => {
  terminals?.destroyAll()
  boardServer?.close()
})
