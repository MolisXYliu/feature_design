/**
 * Terminal IPC handlers — 主进程端。
 * PTY 操作全部代理到独立的 Pty Host 子进程，
 * 避免 PTY I/O 阻塞主进程事件循环。
 */
import { IpcMain, BrowserWindow, dialog } from "electron"
import { fork, type ChildProcess } from "node:child_process"
import { accessSync } from "fs" // #15 fix: 用 import 代替 require
import path from "path"
import { app } from "electron"

let ptyHost: ChildProcess | null = null
let idCounter = 0
let isShuttingDown = false

// 每个 PTY 对应的 BrowserWindow，用于将数据转发到正确的渲染进程
const ptyWindows = new Map<string, BrowserWindow>()

// #7 fix: 统一的窗口关闭监听器，避免 window.once 只触发一次的问题
const windowCleanupRegistered = new WeakSet<BrowserWindow>()

// P1 fix: 等待子进程确认创建成功/失败
const pendingCreates = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()

function getClaudePath(): string {
  const isWin = process.platform === "win32"
  const binName = isWin ? "claude.cmd" : "claude"

  // 方式1: 直接用 @anthropic-ai/claude-code 的 cli.js（最可靠，不依赖 .bin shim）
  const cliJs = path.join(app.getAppPath(), "node_modules", "@anthropic-ai", "claude-code", "cli.js")
  const unpackedCliJs = cliJs.replace("app.asar", "app.asar.unpacked")
  try { accessSync(unpackedCliJs); return unpackedCliJs } catch { /* continue */ }
  try { accessSync(cliJs); return cliJs } catch { /* continue */ }

  // 方式2: .bin shim
  const localBin = path.join(app.getAppPath(), "node_modules", ".bin", binName)
  const unpackedBin = localBin.replace("app.asar", "app.asar.unpacked")
  try { accessSync(unpackedBin); return unpackedBin } catch { /* continue */ }
  try { accessSync(localBin); return localBin } catch { /* continue */ }

  console.warn("[Terminal] Claude Code not found in node_modules, falling back to PATH lookup")
  return binName
}

function getPtyHostPath(): string {
  // #1 fix: fork() 不能从 asar 内加载，需要用 unpacked 路径
  const outPath = path.join(app.getAppPath(), "out", "main", "pty-host.js")
  const unpackedPath = outPath.replace("app.asar", "app.asar.unpacked")
  try {
    accessSync(unpackedPath)
    return unpackedPath
  } catch {
    try {
      accessSync(outPath)
      return outPath
    } catch {
      return path.join(__dirname, "pty-host.js")
    }
  }
}

function ensurePtyHost(): ChildProcess {
  if (isShuttingDown) throw new Error("Application is shutting down")
  if (ptyHost && !ptyHost.killed) return ptyHost

  const hostPath = getPtyHostPath()
  console.log(`[Terminal] Spawning Pty Host: ${hostPath}`)

  ptyHost = fork(hostPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env }
  })

  ptyHost.on("message", (msg: { type: string; id?: string; data?: string; exitCode?: number; error?: string }) => {
    if (msg.type === "ready") {
      console.log("[Terminal] Pty Host ready")
      return
    }

    if (msg.type === "created" && msg.id) {
      const pending = pendingCreates.get(msg.id)
      if (pending) { pending.resolve(); pendingCreates.delete(msg.id) }
      return
    }

    if (msg.type === "error") {
      if (msg.id) {
        const pending = pendingCreates.get(msg.id)
        if (pending) { pending.reject(new Error(msg.error || "PTY creation failed")); pendingCreates.delete(msg.id) }
      } else {
        // 全局异常，无 id，记日志
        console.error("[Terminal] Pty Host error:", msg.error)
      }
      return
    }

    if (msg.type === "data" && msg.id) {
      const win = ptyWindows.get(msg.id)
      if (win && !win.isDestroyed()) {
        // 数据和字节数一起发给渲染端，渲染端消费后发 ack 回来
        win.webContents.send(`terminal:data:${msg.id}`, msg.data, Buffer.byteLength((msg.data as string) || ""))
      }
      return
    }

    if (msg.type === "exit" && msg.id) {
      const win = ptyWindows.get(msg.id)
      if (win && !win.isDestroyed()) {
        win.webContents.send(`terminal:exit:${msg.id}`, msg.exitCode)
      }
      ptyWindows.delete(msg.id)
      return
    }
  })

  ptyHost.on("exit", (code) => {
    console.log(`[Terminal] Pty Host exited with code ${code}`)
    for (const [id, win] of ptyWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send(`terminal:exit:${id}`, code)
      }
    }
    ptyHost = null
    ptyWindows.clear()
    // #3 fix: reject 所有等待中的创建请求
    for (const [, pending] of pendingCreates) {
      pending.reject(new Error(`Pty Host exited with code ${code}`))
    }
    pendingCreates.clear()
    if (!isShuttingDown && code !== 0) {
      console.log("[Terminal] Pty Host crashed, will restart on next terminal:create")
    }
  })

  ptyHost.stdout?.on("data", (data: Buffer) => {
    console.log(`[PtyHost stdout] ${data.toString().trim()}`)
  })
  ptyHost.stderr?.on("data", (data: Buffer) => {
    console.error(`[PtyHost stderr] ${data.toString().trim()}`)
  })

  return ptyHost
}

function sendToHost(msg: Record<string, unknown>): void {
  try {
    const host = ensurePtyHost()
    host.send(msg)
  } catch {
    // shutdown 期间或 Pty Host 崩溃时静默忽略（非 create 调用）
  }
}

// 安全检查：只允许本地页面或配置的远程 renderer 调用终端 API
function isAllowedSender(sender: Electron.WebContents): boolean {
  const url = sender.getURL()
  if (!url) return false
  try {
    const parsed = new URL(url)
    if (parsed.hostname === "localhost" || parsed.protocol === "file:") return true
    // 支持配置的远程 renderer，按 origin 精确匹配
    const renderUrl = process.env.ELECTRON_RENDERER_URL
    if (renderUrl) {
      const allowed = new URL(renderUrl)
      if (parsed.origin === allowed.origin) return true
    }
  } catch { return false }
  return false
}

// #7 fix: 为 BrowserWindow 注册统一的关闭监听器
function ensureWindowCleanup(win: BrowserWindow): void {
  if (windowCleanupRegistered.has(win)) return
  windowCleanupRegistered.add(win)

  win.on("closed", () => {
    // 遍历所有属于该窗口的 PTY，全部清理
    for (const [id, w] of ptyWindows) {
      if (w === win) {
        try { sendToHost({ type: "dispose", id }) } catch { /* Pty Host 可能已退出 */ }
        ptyWindows.delete(id)
      }
    }
  })
}

export function registerTerminalHandlers(ipcMain: IpcMain): void {
  console.log("[Terminal] Registering terminal handlers...")

  ipcMain.handle(
    "terminal:create",
    async (event, { workDir, args, cols: initCols, rows: initRows }: { workDir?: string; args?: string[]; cols?: number; rows?: number }) => {
      const id = `term-${++idCounter}`
      try {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window) throw new Error("No window found")
        if (!isAllowedSender(event.sender)) {
          throw new Error("Terminal creation not allowed from remote pages")
        }

        ptyWindows.set(id, window)
        ensureWindowCleanup(window)

        const claudePath = getClaudePath()

        // P1 fix: 等待子进程确认创建成功
        const createPromise = new Promise<void>((resolve, reject) => {
          pendingCreates.set(id, { resolve, reject })
          // 超时 5 秒
          setTimeout(() => {
            if (pendingCreates.has(id)) {
              pendingCreates.delete(id)
              reject(new Error("PTY creation timed out"))
            }
          }, 5000)
        })

        sendToHost({
          type: "create",
          id,
          workDir: workDir || process.env.HOME || process.cwd(),
          cols: initCols || 120,
          rows: initRows || 30,
          claudePath,
          args: args || [],
          electronPath: process.execPath // Electron 二进制路径，可当 node 用
        })

        await createPromise
        console.log(`[Terminal] Created PTY ${id} via Pty Host, running: ${claudePath}`)
        return id
      } catch (err) {
        // 创建失败：清理主进程状态，通知子进程销毁可能已创建的 PTY
        console.error("[Terminal] Failed to create terminal:", err)
        ptyWindows.delete(id)
        try { sendToHost({ type: "dispose", id }) } catch { /* Pty Host 可能已退出 */ }
        throw err
      }
    }
  )

  ipcMain.on("terminal:write", (_event, { id, data }: { id: string; data: string }) => {
    sendToHost({ type: "write", id, data })
  })

  // P1 fix: 渲染端消费数据后发 ack，主进程转发给 Pty Host
  ipcMain.on("terminal:ack", (_event, { id, bytes }: { id: string; bytes: number }) => {
    sendToHost({ type: "ack", id, bytes })
  })

  ipcMain.on("terminal:resize", (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    sendToHost({ type: "resize", id, cols, rows })
  })

  ipcMain.handle("terminal:selectDir", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error("No window found")
    if (!isAllowedSender(event.sender)) {
      throw new Error("Directory selection not allowed from remote pages")
    }
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle("terminal:dispose", async (_event, id: string) => {
    sendToHost({ type: "dispose", id })
    ptyWindows.delete(id)
    console.log(`[Terminal] Disposed PTY ${id}`)
  })
}

export function disposeAllTerminals(): void {
  isShuttingDown = true
  if (ptyHost && !ptyHost.killed) {
    ptyHost.send({ type: "disposeAll" })
    // #2 fix: 给子进程时间处理 disposeAll，超时后强制杀
    const host = ptyHost
    setTimeout(() => {
      if (host && !host.killed) host.kill()
    }, 500)
    ptyHost = null
  }
  ptyWindows.clear()
  console.log("[Terminal] Disposed all terminals and killed Pty Host")
}
