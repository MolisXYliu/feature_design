/**
 * Pty Host — 独立子进程，管理所有 node-pty 实例。
 * 避免 PTY I/O 阻塞主进程事件循环。
 * 通过 process.send / process.on("message") 与主进程通信。
 */
import { spawn as ptySpawn, IPty } from "node-pty"
import { platform, homedir } from "os"
import { existsSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"

const activePtys = new Map<string, IPty>()

// 流控：高低水位线，防止缓冲区溢出
const HIGH_WATER_MARK = 5 * 1024 * 1024  // 5MB 暂停
const LOW_WATER_MARK = 1 * 1024 * 1024   // 1MB 恢复
const pendingBytes = new Map<string, number>()
const paused = new Map<string, boolean>()

let cachedShell: string | null = null
function getShell(): string {
  if (cachedShell) return cachedShell
  if (platform() === "win32") {
    // Git Bash：POSIX 兼容，ConPTY 正常，子进程 stdin 是真 TTY
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      // per-user 安装路径
      join(homedir(), "AppData", "Local", "Programs", "Git", "bin", "bash.exe"),
    ]
    for (const p of candidates) {
      if (existsSync(p)) {
        cachedShell = p
        return cachedShell
      }
    }
    // 兜底：where.exe 查找，过滤 System32\bash.exe（WSL 启动器）
    try {
      const out = execSync("where bash.exe", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      const found = out.trim().split(/\r?\n/).find(
        (l) => !l.toLowerCase().includes("system32")
      )
      if (found) {
        cachedShell = found
        return cachedShell
      }
    } catch {}
    throw new Error(
      "Git Bash not found. Please install Git for Windows: https://git-scm.com/download/win"
    )
  } else {
    cachedShell = process.env.SHELL || "/bin/zsh"
  }
  return cachedShell
}

interface CreateMsg {
  type: "create"
  id: string
  workDir: string
  cols: number
  rows: number
  claudePath: string
  args: string[]
  electronPath: string
  extraEnv?: Record<string, string> // Claude Code 模型相关环境变量
}

interface WriteMsg {
  type: "write"
  id: string
  data: string
}

interface ResizeMsg {
  type: "resize"
  id: string
  cols: number
  rows: number
}

interface DisposeMsg {
  type: "dispose"
  id: string
}

interface AckMsg {
  type: "ack"
  id: string
  bytes: number
}

interface DisposeAllMsg {
  type: "disposeAll"
}

type HostMessage = CreateMsg | WriteMsg | ResizeMsg | DisposeMsg | AckMsg | DisposeAllMsg

function send(msg: Record<string, unknown>): void {
  process.send?.(msg)
}

function handleCreate(msg: CreateMsg): void {
  try {
    const shell = getShell()
    // Git Bash (Windows) 与 Unix shell 均为 POSIX 兼容，统一使用单引号转义
    const escapeArg = (arg: string): string => `'${arg.replace(/'/g, "'\\''")}'`

    const isJsFile = msg.claudePath.endsWith(".js")
    const env = { ...process.env, ...(msg.extraEnv || {}) } as Record<string, string>

    let claudeCmd: string
    if (isJsFile) {
      claudeCmd = [escapeArg(msg.electronPath), escapeArg(msg.claudePath), ...msg.args.map(escapeArg)].join(" ")
      env.ELECTRON_RUN_AS_NODE = "1"
    } else {
      claudeCmd = [escapeArg(msg.claudePath), ...msg.args.map(escapeArg)].join(" ")
    }

    // Claude Code 退出后清除敏感变量，再 exec 回交互式 shell
    const varsToUnset: string[] = []
    if (msg.extraEnv) {
      varsToUnset.push(...Object.keys(msg.extraEnv))
    }
    if (isJsFile) {
      varsToUnset.push("ELECTRON_RUN_AS_NODE")
    }

    const shellCmd = varsToUnset.length > 0
      ? claudeCmd + ` ; ${varsToUnset.map((v) => `unset ${escapeArg(v)}`).join("; ")}; exec ${escapeArg(shell)} -l`
      : claudeCmd + ` ; exec ${escapeArg(shell)} -l`

    const pty = ptySpawn(shell, ["-c", shellCmd], {
      name: "xterm-256color",
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.workDir || homedir() || process.cwd(),
      env
    })

    activePtys.set(msg.id, pty)
    pendingBytes.set(msg.id, 0)
    paused.set(msg.id, false)

    pty.onData((data) => {
      const current = (pendingBytes.get(msg.id) || 0) + Buffer.byteLength(data)
      pendingBytes.set(msg.id, current)
      if (current > HIGH_WATER_MARK && !paused.get(msg.id)) {
        pty.pause()
        paused.set(msg.id, true)
      }
      send({ type: "data", id: msg.id, data })
    })

    pty.onExit(({ exitCode }) => {
      send({ type: "exit", id: msg.id, exitCode })
      activePtys.delete(msg.id)
      pendingBytes.delete(msg.id)
      paused.delete(msg.id)
    })

    send({ type: "created", id: msg.id })
  } catch (err) {
    send({ type: "error", id: msg.id, error: err instanceof Error ? err.message : String(err) })
  }
}

function handleWrite(msg: WriteMsg): void {
  const pty = activePtys.get(msg.id)
  if (pty) pty.write(msg.data)
}

function handleResize(msg: ResizeMsg): void {
  const pty = activePtys.get(msg.id)
  if (pty) pty.resize(msg.cols, msg.rows)
}

function handleAck(msg: AckMsg): void {
  const clamped = Math.max(0, (pendingBytes.get(msg.id) || 0) - msg.bytes)
  pendingBytes.set(msg.id, clamped)

  if (clamped < LOW_WATER_MARK && paused.get(msg.id)) {
    const pty = activePtys.get(msg.id)
    if (pty) pty.resume()
    paused.set(msg.id, false)
  }
}

function handleDispose(msg: DisposeMsg): void {
  const pty = activePtys.get(msg.id)
  if (pty) {
    pty.kill()
    activePtys.delete(msg.id)
  }
  pendingBytes.delete(msg.id)
  paused.delete(msg.id)
}

function handleDisposeAll(): void {
  for (const [, pty] of activePtys) {
    pty.kill()
  }
  activePtys.clear()
  pendingBytes.clear()
  paused.clear()
  // #2 fix: 清理完毕后自行退出，避免被强制 kill 导致孤儿进程
  process.exit(0)
}

process.on("message", (msg: HostMessage) => {
  switch (msg.type) {
    case "create": handleCreate(msg); break
    case "write": handleWrite(msg); break
    case "resize": handleResize(msg); break
    case "ack": handleAck(msg); break
    case "dispose": handleDispose(msg); break
    case "disposeAll": handleDisposeAll(); break
  }
})

// 父进程退出时清理（handleDisposeAll 内部会调 process.exit(0)）
process.on("disconnect", () => {
  handleDisposeAll()
})

// 全局异常捕获，防止子进程静默崩溃
process.on("uncaughtException", (err) => {
  console.error("[PtyHost] Uncaught exception:", err)
  send({ type: "error", error: err.message })
})

process.on("unhandledRejection", (reason) => {
  console.error("[PtyHost] Unhandled rejection:", reason)
})

send({ type: "ready" })
