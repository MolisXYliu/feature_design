import { ipcMain, BrowserWindow } from "electron"
import { checkForUpdate, type UpdateCheckResult } from "./checker"
import { downloadUpdate } from "./downloader"
import { installAsarUpdate, installFullUpdate } from "./installer"
import { rollbackToPrevious, isRollbackAvailable } from "./rollback"

// Module state
let checkInterval: ReturnType<typeof setInterval> | null = null
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null
let lastCheckResult: UpdateCheckResult | null = null
let downloadedFilePath: string | null = null
let updateStatus: "idle" | "available" | "downloading" | "downloaded" | "error" = "idle"

const CHECK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
const INITIAL_DELAY_MS = 30 * 1000 // 30 seconds after startup

function getUpdateServerUrl(): string {
  const url = (import.meta.env.VITE_UPDATE_SERVER_URL as string) || ""
  if (!url) {
    console.warn("[Updater] VITE_UPDATE_SERVER_URL is not configured")
  }
  return url
}

/**
 * Broadcast an event to all renderer windows.
 */
function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}

/**
 * Perform update check and notify renderer if update is available.
 */
async function performCheck(manual: boolean): Promise<UpdateCheckResult | null> {
  const baseUrl = getUpdateServerUrl()
  if (!baseUrl) {
    if (manual) throw new Error("更新服务器地址未配置")
    return null
  }

  try {
    const result = await checkForUpdate(baseUrl)
    lastCheckResult = result

    if (result) {
      updateStatus = "available"
      broadcast("update:available", {
        version: result.version,
        updateType: result.updateType,
        releaseNotes: result.releaseNotes,
        size: result.downloadSize,
        mandatory: result.mandatory
      })
      console.log(`[Updater] Update available: v${result.version} (${result.updateType})`)
    } else if (manual) {
      console.log("[Updater] Already up to date")
    }

    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[Updater] Check failed:", message)
    if (manual) {
      broadcast("update:error", { message: `检查更新失败: ${message}` })
    }
    return null
  }
}

/**
 * Register all update-related IPC handlers.
 */
export function registerUpdaterHandlers(): void {
  // Manual check for updates
  ipcMain.handle("update:check", async () => {
    const result = await performCheck(true)
    return result
      ? {
          hasUpdate: true,
          version: result.version,
          updateType: result.updateType,
          releaseNotes: result.releaseNotes,
          size: result.downloadSize,
          mandatory: result.mandatory
        }
      : { hasUpdate: false }
  })

  // Start downloading the update
  ipcMain.handle("update:download", async () => {
    if (!lastCheckResult) {
      throw new Error("没有可用的更新，请先检查更新")
    }

    const baseUrl = getUpdateServerUrl()
    if (!baseUrl) throw new Error("更新服务器地址未配置")

    updateStatus = "downloading"

    try {
      downloadedFilePath = await downloadUpdate(
        baseUrl,
        lastCheckResult.downloadFile,
        lastCheckResult.downloadSha256,
        lastCheckResult.downloadSize,
        (p) => broadcast("update:progress", p)
      )

      updateStatus = "downloaded"
      broadcast("update:downloaded", {
        version: lastCheckResult.version,
        updateType: lastCheckResult.updateType
      })

      return { success: true }
    } catch (err) {
      updateStatus = "error"
      const message = err instanceof Error ? err.message : "Download failed"
      broadcast("update:error", { message })
      throw err
    }
  })

  // Install the downloaded update (triggers restart)
  ipcMain.handle("update:install", async () => {
    if (!lastCheckResult || !downloadedFilePath) {
      throw new Error("没有已下载的更新")
    }

    if (lastCheckResult.updateType === "asar") {
      installAsarUpdate(downloadedFilePath, lastCheckResult.version)
    } else {
      installFullUpdate(downloadedFilePath, lastCheckResult.version)
    }
    // App will quit after this, no return needed
  })

  // Dismiss the update notification
  ipcMain.handle("update:dismiss", async () => {
    // Just reset status; the next scheduled check will re-notify
    updateStatus = "idle"
    lastCheckResult = null
    return { success: true }
  })

  // Rollback to previous version
  ipcMain.handle("update:rollback", async () => {
    const baseUrl = getUpdateServerUrl()
    await rollbackToPrevious(baseUrl)
    // App will quit after this
  })

  // Get current update status
  ipcMain.handle("update:get-status", async () => {
    return {
      status: updateStatus,
      update: lastCheckResult
        ? {
            version: lastCheckResult.version,
            updateType: lastCheckResult.updateType,
            releaseNotes: lastCheckResult.releaseNotes,
            size: lastCheckResult.downloadSize
          }
        : null,
      canRollback: isRollbackAvailable()
    }
  })

  console.log("[Updater] IPC handlers registered")
}

/**
 * Start the periodic update checker.
 * Waits 30s after startup, then checks every 30 minutes.
 */
export function startUpdateChecker(): void {
  // Check immediately on startup, no periodic polling
  performCheck(false)
  console.log("[Updater] Startup update check triggered")
}

/**
 * Stop the periodic update checker.
 */
export function stopUpdateChecker(): void {
  if (initialCheckTimer) {
    clearTimeout(initialCheckTimer)
    initialCheckTimer = null
  }
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}
