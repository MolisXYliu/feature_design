import { app, BrowserWindow, IpcMain } from "electron"
import { existsSync, readFileSync, mkdirSync } from "fs"
import { execFile } from "child_process"
import { homedir } from "os"
import { join } from "path"
import { getWindowsSandboxMode, setWindowsSandboxMode, getYoloMode, setYoloMode } from "../storage"

const CODEX_HOME = join(homedir(), ".codex")
const SETUP_MARKER_PATH = join(CODEX_HOME, ".sandbox", "setup_marker.json")
const SETUP_VERSION = 5

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("sandbox:changed")
  }
}

/** Resolve the directory containing codex.exe and the sandbox helper binaries. */
function resolveCodexBinDir(): string {
  const base = app.isPackaged ? process.resourcesPath : join(__dirname, "../../../resources")
  return join(base, "bin", "win32")
}

/** Check whether the elevated sandbox setup has been completed (marker exists with correct version). */
function isElevatedSetupComplete(): boolean {
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
    async (): Promise<{ success: boolean; error?: string }> => {
      if (process.platform !== "win32") {
        return { success: false, error: "Elevated sandbox is only available on Windows" }
      }

      // Already done — skip
      if (isElevatedSetupComplete()) return { success: true }

      const binDir = resolveCodexBinDir()
      const setupExe = join(binDir, "codex-windows-sandbox-setup.exe")
      if (!existsSync(setupExe)) {
        return { success: false, error: `找不到沙箱配置程序: ${setupExe}` }
      }

      // Ensure .sandbox directory exists
      const sbxDir = join(CODEX_HOME, ".sandbox")
      mkdirSync(sbxDir, { recursive: true })

      // Build the ElevationPayload (matches Codex's ElevationPayload struct).
      // Setup only creates sandbox users + firewall rules (global operations).
      // Per-workspace ACLs are refreshed by codex.exe at execution time.
      const home = homedir()
      const tmpDir = process.env.TEMP || process.env.TMP || join(home, "AppData", "Local", "Temp")
      const userProfile = process.env.USERPROFILE || home

      const payload = {
        version: SETUP_VERSION,
        offline_username: "CodexSandboxOffline",
        online_username: "CodexSandboxOnline",
        codex_home: CODEX_HOME,
        command_cwd: home,
        read_roots: [userProfile],
        write_roots: [tmpDir],
        real_user: process.env.USERNAME || "Administrators",
        refresh_only: false
      }
      const b64 = Buffer.from(JSON.stringify(payload)).toString("base64")

      try {
        // BUG 1 fix: use async exec instead of execSync to avoid blocking the main process
        // BUG 2 fix: escape single quotes in path for PowerShell
        const psCommand = [
          "Start-Process",
          `-FilePath '${psEscape(setupExe)}'`,
          `-ArgumentList '${psEscape(b64)}'`,
          "-Verb RunAs",
          "-Wait",
          "-WindowStyle Hidden"
        ].join(" ")

        // Use execFile to bypass cmd.exe, avoiding % expansion and other shell escaping issues
        await new Promise<void>((resolve, reject) => {
          execFile("powershell", ["-NoProfile", "-Command", psCommand], {
            timeout: 120_000,
            windowsHide: true
          }, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // ERROR_CANCELLED (1223) means user dismissed UAC
        if (msg.includes("1223") || msg.includes("canceled") || msg.includes("cancelled")) {
          return { success: false, error: "用户取消了管理员授权" }
        }
        return { success: false, error: `沙箱配置失败: ${msg}` }
      }

      // Verify setup succeeded
      if (isElevatedSetupComplete()) {
        return { success: true }
      }
      return { success: false, error: "沙箱配置未完成，请重试" }
    }
  )
}
