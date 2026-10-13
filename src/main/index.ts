import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunningBoardServer } from '../../server/index.ts'

// 图标放在仓库根的 resources/（electron-vite 的约定），运行时从 out/main 往上两级
const ICON = join(__dirname, '../../resources/icon.png')

let win: BrowserWindow | null = null
/** mini 面板窗（见下方 mini 面板段） */
let panel: BrowserWindow | null = null
/** 待主窗口渲染层取走的「打开需求」请求 */
let pendingOpen: { project: string; slug: string } | null = null
let boardServer: RunningBoardServer | null = null

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

// ---------------------------------------------------------------- mini 面板

/**
 * mini 面板：launcher 式第二窗口。快捷键呼出、失焦即隐、隐藏不销毁——
 * 跨应用快速回到最近活跃需求的入口（设计见需求 mini-panel 的 design.md）。
 */
const PANEL_SIZE = { width: 420, height: 480 }

/** 上次呼出位置存 userData，跨重启生效 */
function panelPositionFile(): string {
  return join(process.env.EASY_FLOW_USER_DATA!, 'panel-position.json')
}

function loadPanelPosition(): { x: number; y: number } | null {
  try {
    const pos = JSON.parse(readFileSync(panelPositionFile(), 'utf8'))
    if (typeof pos?.x === 'number' && typeof pos?.y === 'number') return pos
  } catch {
    // 没存过或文件损坏：回落到默认位置
  }
  return null
}

/** 存进文件前校验位置还落在某块屏幕的工作区内；拔了显示器的旧坐标直接作废 */
function validPanelPosition(
  pos: { x: number; y: number } | null,
): { x: number; y: number } | null {
  if (!pos) return null
  const inside = screen.getAllDisplays().some(
    (d) =>
      pos.x >= d.workArea.x &&
      pos.x < d.workArea.x + d.workArea.width &&
      pos.y >= d.workArea.y &&
      pos.y < d.workArea.y + d.workArea.height,
  )
  return inside ? pos : null
}

function savePanelPosition(): void {
  if (!panel || panel.isDestroyed()) return
  try {
    writeFileSync(panelPositionFile(), JSON.stringify(panel.getPosition()))
  } catch {
    // 存不下就算了：位置记忆不是关键路径
  }
}

function createPanel(): void {
  panel = new BrowserWindow({
    ...PANEL_SIZE,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 跟随当前 Space：默认行为把窗口钉在创建时所在的桌面，呼出时反把人拽回主窗口那屏。
  // skipTransformProcessType 不能省——不传时 Electron 会为 visibleOnFullScreen 调 dock.hide()，
  // 把带 Dock 图标的主窗口应用的图标吞掉
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })

  // 外链走系统浏览器（会话 deeplink、MR 等链接），不在面板窗里开
  panel.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // launcher 的关键：焦点一走就藏。隐藏不销毁，再呼秒开
  panel.on('blur', () => panel?.hide())
  panel.on('closed', () => {
    panel = null
  })
  // 'moved' 在拖动落定后触发；程序化 setPosition 也会发，无害（存的就是当前值）
  panel.on('moved', savePanelPosition)

  if (process.env.ELECTRON_RENDERER_URL) {
    void panel.loadURL(`${process.env.ELECTRON_RENDERER_URL}/mini.html`)
  } else {
    void panel.loadFile(join(__dirname, '../renderer/mini.html'))
  }
}

function showPanel(): void {
  if (!panel || panel.isDestroyed()) createPanel()
  panel!.setAlwaysOnTop(true, 'floating')

  const saved = validPanelPosition(loadPanelPosition())
  if (saved) {
    panel!.setPosition(saved.x, saved.y)
  } else {
    // 默认位置：鼠标所在屏幕、顶部居中约 20%
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const wa = display.workArea
    panel!.setPosition(
      wa.x + Math.round((wa.width - PANEL_SIZE.width) / 2),
      wa.y + Math.round(wa.height * 0.2),
    )
  }

  panel!.show()
  panel!.focus()
  // 呼出即聚焦过滤框、顺手重拉数据——上次呼出后 agent 可能又动了看板
  panel!.webContents.send('easy-flow:panel-shown')
}

function togglePanel(): void {
  if (panel && !panel.isDestroyed() && panel.isVisible()) {
    panel.hide()
  } else {
    showPanel()
  }
}

/** 默认快捷键。用户改了存在配置里（见设置页的「快捷键」） */
const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+E'
/** 当前生效的快捷键，改的时候要先摘掉旧的 */
let panelShortcut = DEFAULT_SHORTCUT

/**
 * 换绑快捷键。先注册新的，成功再摘旧的——新组合被别的应用占着时，
 * 旧的还留在手上，不至于两个都用不了。
 */
function rebindShortcut(accel: string): boolean {
  if (accel === panelShortcut) return true
  if (!globalShortcut.register(accel, togglePanel)) return false
  globalShortcut.unregister(panelShortcut)
  panelShortcut = accel
  return true
}

function registerIpc(): void {
  ipcMain.handle('easy-flow:pick-directory', async () => {
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })

  // 设置页的「快捷键」：取值与改绑都归主进程（globalShortcut 只在这儿）
  ipcMain.handle('easy-flow:get-shortcut', () => ({
    shortcut: panelShortcut,
    fallback: DEFAULT_SHORTCUT,
  }))

  ipcMain.handle('easy-flow:set-shortcut', async (_event, accel: string) => {
    const next = accel.trim()
    if (!next) return { ok: false, error: '快捷键不能为空' }
    if (!rebindShortcut(next)) {
      return { ok: false, error: `${next} 注册不上：多半被别的应用占用了，换一个` }
    }
    try {
      const { writeConfig } = await import('../../server/config.ts')
      writeConfig({ panelShortcut: next })
    } catch (e) {
      // 注册已经生效，只是没记住；下次启动会回到旧值，得说出来
      return { ok: true, shortcut: next, error: `已生效，但写入配置失败：${(e as Error).message}` }
    }
    return { ok: true, shortcut: next }
  })

  // mini 面板点「详情」：主窗口前置并跳到该需求。主窗口被关过就重建（macOS 常态）
  ipcMain.handle('easy-flow:open-requirement', async (_event, payload: { project: string; slug: string }) => {
    if (!win || win.isDestroyed()) {
      // 新窗口的渲染层订阅可能还没挂上，先存着等它来取（见 take-pending-open）
      pendingOpen = payload
      await createWindow()
    }
    win!.show()
    win!.focus()
    win!.webContents.send('easy-flow:open-requirement', payload)
  })

  // 渲染层起来时取走待打开的需求：事件早于订阅就会丢，靠这一份兜底
  ipcMain.handle('easy-flow:take-pending-open', () => {
    const p = pendingOpen
    pendingOpen = null
    return p
  })

  // mini 面板 Esc 到顶（没展开、没过滤词）时藏起自己
  ipcMain.on('easy-flow:panel-hide', () => panel?.hide())
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
  // server 侧读不到 package.json（被单独打包成 chunk），版本号由这里注入
  process.env.EASY_FLOW_VERSION = app.getVersion()
  const { startBoardServer, DEFAULT_PORT } = await import('../../server/index.ts')

  registerIpc()
  registerMenu()
  applyCsp()
  boardServer = await startBoardServer({ port: DEFAULT_PORT })

  // mini 面板的全局快捷键：取用户改过的，没改过就是默认
  const { readConfig } = await import('../../server/config.ts')
  panelShortcut = readConfig().panelShortcut || DEFAULT_SHORTCUT
  if (!globalShortcut.register(panelShortcut, togglePanel)) {
    // 被别的应用占用时 register 返回 false。回落到默认，至少还能呼出——
    // 否则用户改的那个键失效后，面板就再没有入口了
    console.warn(`[easy-flow] 快捷键 ${panelShortcut} 注册失败：可能被其它应用占用`)
    if (panelShortcut !== DEFAULT_SHORTCUT && globalShortcut.register(DEFAULT_SHORTCUT, togglePanel)) {
      panelShortcut = DEFAULT_SHORTCUT
    }
  }
}

async function createWindow(): Promise<void> {
  await boot()
  // 已有窗口就把它带到前台，不再新建（macOS 从 Dock 重开走这里）
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }

  // macOS 的开发态 dock 图标是 Electron 自带的，得显式换；其它平台认 BrowserWindow 的 icon
  if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(ICON))

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'easy-flow',
    icon: ICON,
    titleBarStyle: 'hiddenInset',
    // 显式固定交通灯位置：默认位置随系统浮动，顶栏左侧的留白没法跟它对齐
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
  boardServer?.close()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
