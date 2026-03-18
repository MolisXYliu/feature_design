import { app, BrowserWindow, IpcMain } from "electron"
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "fs"
import { execFile } from "child_process"
import { homedir } from "os"
import { join, resolve } from "path"
import {
  getWindowsSandboxMode,
  setWindowsSandboxMode,
  getYoloMode,
  setYoloMode,
  getApprovalRules,
  removeApprovalRule,
  isSandboxNuxCompleted,
  setSandboxNuxCompleted
} from "../storage"
import { pendingApprovals } from "../agent/runtime"
import type { ApprovalDecision } from "../types"

const CODEX_HOME = join(homedir(), ".codex")
const SETUP_MARKER_PATH = join(CODEX_HOME, ".sandbox", "setup_marker.json")
const SETUP_VERSION = 5

/** Track which workspace directories have had elevated ACL setup done (session-level). */
const elevatedSetupDirs = new Set<string>()

/** Sensitive directories under user profile that should NOT be readable by the sandbox user. */
const USERPROFILE_READ_ROOT_EXCLUSIONS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config",
  ".npm",
  ".pki",
  ".terraform.d"
]

/**
 * Enumerate user profile subdirectories, excluding sensitive ones.
 * Matches codex's profile_read_roots() behavior.
 */
function profileReadRoots(userProfile: string): string[] {
  try {
    const entries = readdirSync(userProfile, { withFileTypes: true })
    return entries
      .filter((entry) => {
        const name = entry.name.toLowerCase()
        return !USERPROFILE_READ_ROOT_EXCLUSIONS.some((ex) => name === ex.toLowerCase())
      })
      .map((entry) => join(userProfile, entry.name))
  } catch {
    // If enumeration fails, fall back to the profile root (same as codex)
    return [userProfile]
  }
}

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("sandbox:changed")
  }
}

/** Resolve the directory containing codex.exe and the sandbox helper binaries. */
function resolveCodexBinDir(): string {
  // electron-vite bundles everything into out/main/index.js, so __dirname = out/main/
  const base = app.isPackaged ? process.resourcesPath : join(__dirname, "../../resources")
  return join(base, "bin", "win32")
}

/** Check whether the elevated sandbox setup has been completed (marker exists with correct version). */
export function isElevatedSetupComplete(): boolean {
  if (!existsSync(SETUP_MARKER_PATH)) return false
  try {
    const marker = JSON.parse(readFileSync(SETUP_MARKER_PATH, "utf-8"))
    return marker.version === SETUP_VERSION
  } catch {
    return false
  }
}

/** Escape single quotes for PowerShell single-quoted strings. */
function psEscape(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Run elevated sandbox setup with UAC for the given workspace paths.
 * This is called both from the NUX dialog and from local-sandbox when
 * a new workspace directory needs ACL setup in elevated mode.
 */
export async function runElevatedSetupForPaths(
  workspacePaths?: string[]
): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== "win32") {
    return { success: false, error: "Elevated sandbox is only available on Windows" }
  }

  const binDir = resolveCodexBinDir()
  const setupExe = join(binDir, "codex-windows-sandbox-setup.exe")
  if (!existsSync(setupExe)) {
    return { success: false, error: `找不到沙箱配置程序: ${setupExe}` }
  }

  // Ensure .sandbox directory exists
  const sbxDir = join(CODEX_HOME, ".sandbox")
  mkdirSync(sbxDir, { recursive: true })

  const home = homedir()
  const tmpDir = process.env.TEMP || process.env.TMP || join(home, "AppData", "Local", "Temp")
  const userProfile = process.env.USERPROFILE || home

  // write_roots: TEMP + workspace paths (validated)
  const writeRoots = [tmpDir]
  const validatedWorkspacePaths: string[] = []
  if (workspacePaths) {
    for (const p of workspacePaths) {
      if (!p || typeof p !== "string") continue
      // Resolve to absolute path (handles relative paths like ../../)
      const resolved = resolve(p)
      const normalized = resolved.replace(/\\/g, "/").toLowerCase()

      // Block UNC paths (\\server\share or //server/share)
      if (/^[\\/]{2}/.test(p) || /^[\\/]{2}/.test(resolved)) {
        console.warn(`[Sandbox] Rejected write_root: UNC path "${p}"`)
        continue
      }

      // Block drive roots (e.g. "C:\", "D:\")
      if (/^[a-z]:\/?\s*$/.test(normalized)) {
        console.warn(`[Sandbox] Rejected write_root: drive root "${p}"`)
        continue
      }
      // Block system directories
      const blockedPrefixes = [
        "c:/windows", "c:/program files", "c:/program files (x86)",
        "c:/programdata", "c:/users/all users", "c:/users/default",
        "c:/users/public"
      ]
      if (blockedPrefixes.some(bp => normalized === bp || normalized.startsWith(bp + "/"))) {
        console.warn(`[Sandbox] Rejected write_root: system directory "${p}"`)
        continue
      }
      // Block sensitive user directories
      const homeNorm = home.replace(/\\/g, "/").toLowerCase()
      if (normalized.startsWith(homeNorm + "/")) {
        const relative = normalized.slice(homeNorm.length + 1).split("/")[0]
        if (USERPROFILE_READ_ROOT_EXCLUSIONS.some(e => e.toLowerCase() === relative)) {
          console.warn(`[Sandbox] Rejected write_root: sensitive directory "${p}"`)
          continue
        }
      }
      // Verify path exists and is a directory
      try {
        const st = statSync(resolved)
        if (!st.isDirectory()) {
          console.warn(`[Sandbox] Rejected write_root: not a directory "${p}"`)
          continue
        }
      } catch {
        console.warn(`[Sandbox] Rejected write_root: path does not exist "${p}"`)
        continue
      }
      if (!writeRoots.includes(resolved)) writeRoots.push(resolved)
      validatedWorkspacePaths.push(resolved)
    }
  }

  // read_roots: user profile subdirs (excluding sensitive dirs) + standard Windows dirs
  const readRoots = profileReadRoots(userProfile)
  const standardReadDirs = [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData"
  ]
  for (const d of standardReadDirs) {
    if (existsSync(d) && !readRoots.includes(d)) readRoots.push(d)
  }

  // Determine if this is initial setup or refresh (workspace ACL update)
  const isRefresh = isElevatedSetupComplete()

  const payload = {
    version: SETUP_VERSION,
    offline_username: "CodexSandboxOffline",
    online_username: "CodexSandboxOnline",
    codex_home: CODEX_HOME,
    command_cwd: validatedWorkspacePaths[0] || home,
    read_roots: readRoots,
    write_roots: writeRoots,
    real_user: process.env.USERNAME || "Administrators",
    refresh_only: isRefresh
  }
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64")

  try {
    // Build icacls commands to DENY sandbox group access to sensitive directories.
    // These run as admin (inside the same elevated PowerShell) after the setup binary.
    const sensitiveIcaclsCmds: string[] = []
    const sandboxGroup = "CodexSandboxUsers"
    for (const excluded of USERPROFILE_READ_ROOT_EXCLUSIONS) {
      const dirPath = join(userProfile, excluded)
      if (existsSync(dirPath)) {
        // Deny read access for the sandbox group on each sensitive directory
        sensitiveIcaclsCmds.push(
          `icacls '${psEscape(dirPath)}' /deny '${sandboxGroup}:(OI)(CI)(R)' /T /C /Q`
        )
      }
    }

    const setupCmd = `& '${psEscape(setupExe)}' '${psEscape(b64)}'`
    const allCmds = sensitiveIcaclsCmds.length > 0
      ? [setupCmd, ...sensitiveIcaclsCmds].join("; ")
      : setupCmd

    const psCommand = [
      "Start-Process",
      "-FilePath 'powershell'",
      `-ArgumentList '-NoProfile -Command ${psEscape(allCmds)}'`,
      "-Verb RunAs",
      "-Wait",
      "-WindowStyle Hidden"
    ].join(" ")

    await new Promise<void>((resolve, reject) => {
      execFile("powershell", ["-NoProfile", "-Command", psCommand], {
        timeout: 120_000,
        windowsHide: false
      }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("1223") || msg.includes("canceled") || msg.includes("cancelled")) {
      return { success: false, error: "用户取消了管理员授权" }
    }
    return { success: false, error: `沙箱配置失败: ${msg}` }
  }

  // Mark these directories as set up for this session
  if (workspacePaths) {
    for (const p of workspacePaths) {
      if (p) elevatedSetupDirs.add(p)
    }
  }

  if (isElevatedSetupComplete()) {
    return { success: true }
  }
  return { success: false, error: "沙箱配置未完成，请重试" }
}

/** Check if a workspace directory has had elevated ACL setup in this session. */
export function isWorkspaceElevatedSetupDone(dir: string): boolean {
  return elevatedSetupDirs.has(dir)
}

/** Mark a workspace directory as having elevated ACL setup done. */
export function markWorkspaceElevatedSetupDone(dir: string): void {
  elevatedSetupDirs.add(dir)
}

export function registerSandboxHandlers(ipcMain: IpcMain): void {

  ipcMain.handle("sandbox:getMode", async (): Promise<"none" | "unelevated" | "readonly" | "elevated"> => {
    return getWindowsSandboxMode()
  })

  ipcMain.handle(
    "sandbox:setMode",
    async (_event, mode: "none" | "unelevated" | "readonly" | "elevated"): Promise<void> => {
      if (mode !== "none" && mode !== "unelevated" && mode !== "readonly" && mode !== "elevated") {
        throw new Error(`Invalid sandbox mode: ${mode}`)
      }
      setWindowsSandboxMode(mode)
      notifyChanged()
    }
  )

  ipcMain.handle("sandbox:getYoloMode", async (): Promise<boolean> => {
    return getYoloMode()
  })

  ipcMain.handle("sandbox:setYoloMode", async (_event, yolo: boolean): Promise<void> => {
    if (typeof yolo !== "boolean") throw new Error(`Invalid yolo value: ${yolo}`)
    setYoloMode(yolo)
    notifyChanged()
  })

  ipcMain.handle("sandbox:checkElevatedSetup", async (): Promise<{ setupComplete: boolean }> => {
    return { setupComplete: isElevatedSetupComplete() }
  })

  ipcMain.handle(
    "sandbox:runElevatedSetup",
    async (_event, workspacePaths?: string[]): Promise<{ success: boolean; error?: string }> => {
      return runElevatedSetupForPaths(workspacePaths)
    }
  )

  // ── NUX (first-run setup) ──

  ipcMain.handle("sandbox:isNuxNeeded", async (): Promise<boolean> => {
    // Only show NUX on Windows, and only if not yet completed (persisted across app restarts)
    return process.platform === "win32" && !isSandboxNuxCompleted()
  })

  ipcMain.handle(
    "sandbox:completeNux",
    async (_event, mode: "elevated" | "unelevated" | "none"): Promise<void> => {
      if (mode === "elevated" || mode === "unelevated") {
        setWindowsSandboxMode(mode)
      } else {
        setWindowsSandboxMode("none")
      }
      setSandboxNuxCompleted()
      notifyChanged()
    }
  )

  // ── Approval rules management ──

  ipcMain.handle("sandbox:getApprovalRules", async (): Promise<Array<{ pattern: string; decision: string }>> => {
    return getApprovalRules()
  })

  ipcMain.handle("sandbox:deleteApprovalRule", async (_event, pattern: string): Promise<void> => {
    removeApprovalRule(pattern)
  })

  // ── Approval decision from renderer ──
  // When the renderer makes a decision on an approval request, it sends it here.
  // We look up the pending promise and resolve it.

  const VALID_DECISION_TYPES = new Set(["approve", "approve_session", "approve_permanent", "reject"])

  ipcMain.on("sandbox:approvalDecision", (event, decision: ApprovalDecision & { requestId: string }) => {
    // P2 fix: validate sender is a known BrowserWindow
    const senderWindow = BrowserWindow.getAllWindows().find(w => w.webContents.id === event.sender.id)
    if (!senderWindow) {
      console.warn("[Sandbox] Rejected approval decision from unknown sender, webContentsId:", event.sender.id)
      return
    }

    // Validate decision type
    if (!decision || !decision.requestId || !VALID_DECISION_TYPES.has(decision.type)) {
      console.warn("[Sandbox] Rejected approval decision with invalid type:", decision?.type)
      return
    }

    const pending = pendingApprovals.get(decision.requestId)
    if (pending) {
      // P2 fix: validate sender is one of the windows that received this specific request
      if (!pending.targetWebContentsIds.includes(event.sender.id)) {
        console.warn(
          `[Sandbox] Rejected approval decision from non-target window (sender=${event.sender.id}, targets=[${pending.targetWebContentsIds.join(",")}])`
        )
        return
      }

      // P2 fix: validate tool_call_id matches the original request
      // When expected ID exists, decision MUST provide a matching non-empty value
      // (prevents bypass via empty string or omitted field)
      const expectedToolCallId = pending.request.tool_call?.id
      if (expectedToolCallId) {
        if (!decision.tool_call_id || decision.tool_call_id !== expectedToolCallId) {
          console.warn(
            `[Sandbox] Rejected approval decision: tool_call_id mismatch (expected=${expectedToolCallId}, got=${decision.tool_call_id ?? "(missing)"})`
          )
          return
        }
      }
      pendingApprovals.delete(decision.requestId)
      pending.resolve(decision)
    } else {
      console.warn("[Sandbox] Received approval decision for unknown request:", decision.requestId)
    }
  })
}
