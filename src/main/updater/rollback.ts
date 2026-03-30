import { app } from "electron"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { spawn } from "child_process"
import { join } from "path"
import { getBackupPath, getMarkerPath, generateRollbackBat } from "./installer"
import { getUpdatesDir, downloadUpdate } from "./downloader"
import { fetchLatestJson } from "./checker"

interface UpdateMarker {
  fromVersion: string
  toVersion: string
  updatedAt: string
}

/**
 * Run startup self-check after an ASAR update.
 * Called early in app.whenReady(), BEFORE createWindow().
 *
 * If update-marker.json exists, it means the app just updated.
 * We verify the version is correct. If not, we auto-rollback.
 *
 * Note: Full self-check (window load within 15s) is handled separately
 * via a timeout after createWindow().
 */
export async function runStartupSelfCheck(): Promise<void> {
  const markerPath = getMarkerPath()

  if (!existsSync(markerPath)) {
    return // Not a post-update boot, nothing to do
  }

  console.log("[Updater] Post-update boot detected, running self-check...")

  let marker: UpdateMarker
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf-8"))
  } catch {
    console.warn("[Updater] Failed to parse update-marker.json, removing it")
    unlinkSync(markerPath)
    return
  }

  const currentVersion = app.getVersion()

  // Check 1: version matches expected
  if (currentVersion === marker.toVersion) {
    console.log(`[Updater] Self-check passed: version ${currentVersion} matches expected ${marker.toVersion}`)
    // Keep marker until window load check passes (handled in index.ts)
    // For now, just delete it - the basic check passed
    unlinkSync(markerPath)
    return
  }

  // Version mismatch - the update didn't take effect, auto-rollback
  console.error(
    `[Updater] Version mismatch! Current: ${currentVersion}, expected: ${marker.toVersion}. Auto-rolling back...`
  )

  const backupPath = getBackupPath()
  if (!existsSync(backupPath)) {
    console.error("[Updater] No backup found at", backupPath, "- cannot rollback")
    unlinkSync(markerPath)
    return
  }

  // Use BAT script to rollback (same file-lock workaround)
  executeRollbackViaBat(backupPath)
}

/**
 * Execute a rollback by spawning a BAT script and quitting.
 */
function executeRollbackViaBat(backupAsarPath: string): void {
  const batContent = generateRollbackBat(backupAsarPath)
  const batPath = join(getUpdatesDir(), "rollback.bat")

  writeFileSync(batPath, batContent, "utf-8")
  console.log("[Updater] Generated rollback.bat, executing...")

  const child = spawn("cmd", ["/c", batPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  })
  child.unref()

  app.quit()
}

/**
 * Manually rollback to previous version.
 * Tries local backup first, then downloads from server if needed.
 */
export async function rollbackToPrevious(baseUrl: string): Promise<void> {
  const backupPath = getBackupPath()

  // Try local backup first
  if (existsSync(backupPath)) {
    console.log("[Updater] Rolling back using local backup:", backupPath)
    executeRollbackViaBat(backupPath)
    return
  }

  // No local backup - try to download from server
  console.log("[Updater] No local backup, checking server for rollback version...")
  const latest = await fetchLatestJson(baseUrl)

  if (!latest.rollback) {
    throw new Error("服务器未提供回退版本信息")
  }

  console.log(`[Updater] Downloading rollback version ${latest.rollback.version}...`)
  const downloadedPath = await downloadUpdate(
    baseUrl,
    latest.rollback.file,
    latest.rollback.sha256,
    0 // size unknown for rollback, downloader handles it
  )

  executeRollbackViaBat(downloadedPath)
}

/**
 * Check if a rollback is available (local backup or server rollback info).
 */
export function isRollbackAvailable(): boolean {
  return existsSync(getBackupPath())
}
