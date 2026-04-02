import { app } from "electron"
import { spawn } from "child_process"
import { writeFileSync } from "fs"
import { basename, join, dirname } from "path"
import { getUpdatesDir } from "./downloader"

const EXE_NAME = "CMBDevClaw.exe"

/**
 * Get the path to app.asar in the installation directory.
 */
function getAppAsarPath(): string {
  return join(process.resourcesPath, "app.asar")
}

/**
 * Get the path to app.asar.bak (backup) in the installation directory.
 */
function getBackupPath(): string {
  return join(process.resourcesPath, "app.asar.bak")
}

/**
 * Get the path to the main executable.
 */
function getExePath(): string {
  return app.getPath("exe")
}

/**
 * Get the path to update-marker.json in the installation directory.
 */
function getMarkerPath(): string {
  return join(process.resourcesPath, "update-marker.json")
}

/**
 * Escape values for PowerShell single-quoted string literals.
 */
function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function toPsString(value: string): string {
  return `'${escapePowerShellLiteral(value)}'`
}

/**
 * Windows PowerShell 5.1 treats BOM-less scripts as ANSI.
 * Prefix with BOM so install paths containing non-ASCII characters are safe.
 */
export function writePowerShellScript(ps1Path: string, content: string): void {
  const normalized = content.startsWith("\n") ? content.slice(1) : content
  writeFileSync(ps1Path, `\uFEFF${normalized}`, "utf-8")
}

function writePs1Launcher(ps1Path: string): string {
  const ps1FileName = basename(ps1Path)
  const logFileName = `${basename(ps1Path, ".ps1")}.launcher.log`
  const launcherPath = ps1Path.replace(/\.ps1$/i, ".cmd")
  const launcherContent = `@echo off\r
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0${ps1FileName}" > "%~dp0${logFileName}" 2>&1\r
`
  writeFileSync(launcherPath, launcherContent, "ascii")
  return launcherPath
}

/**
 * Launch the PowerShell installer through a cmd wrapper.
 * Directly detaching powershell.exe proved unreliable in production, while
 * the existing detached cmd/bat flow is stable on Windows.
 */
export function launchDetachedPowerShellScript(ps1Path: string): void {
  const launcherPath = writePs1Launcher(ps1Path)
  const child = spawn("cmd.exe", ["/c", launcherPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  })
  child.on("error", (err) => {
    console.error("[Updater] Failed to spawn PowerShell launcher:", err)
  })
  child.unref()
}

/**
 * Generate the update.ps1 script content for ASAR replacement.
 *   1. Waits for the Electron process to exit (up to 30s)
 *   2. Backs up current app.asar → app.asar.bak
 *   3. Copies new app.asar into place (retries up to 5 times)
 *   4. Writes update-marker.json for startup self-check
 *   5. Cleans up temp file
 *   6. Restarts the application
 */
function generateUpdatePs1(
  newAsarPath: string,
  fromVersion: string,
  toVersion: string
): string {
  const appAsarPath = getAppAsarPath()
  const backupPath = getBackupPath()
  const markerPath = getMarkerPath()
  const exePath = getExePath()
  const exeBaseName = EXE_NAME.replace(".exe", "")

  return `
$exeBaseName = ${toPsString(exeBaseName)}
$appAsarPath = ${toPsString(appAsarPath)}
$backupPath  = ${toPsString(backupPath)}
$newAsarPath = ${toPsString(newAsarPath)}
$markerPath  = ${toPsString(markerPath)}
$exePath     = ${toPsString(exePath)}

# Wait for process to exit (up to 30s)
$n = 0
while ((Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) -and $n -lt 30) {
  Start-Sleep -Seconds 1
  $n++
}
if (Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) {
  exit 1
}

# Backup
if (Test-Path $appAsarPath) {
  try {
    Copy-Item -Path $appAsarPath -Destination $backupPath -Force -ErrorAction Stop
  } catch {
    exit 1
  }
}

# Replace with retry
if (-not (Test-Path $newAsarPath)) { exit 1 }
$retry = 0
$ok = $false
while ($retry -lt 5 -and -not $ok) {
  try {
    Copy-Item -Path $newAsarPath -Destination $appAsarPath -Force -ErrorAction Stop
    $ok = $true
  } catch {
    $retry++
    Start-Sleep -Seconds 2
  }
}
if (-not $ok) {
  if (Test-Path $backupPath) { Copy-Item -Path $backupPath -Destination $appAsarPath -Force -ErrorAction SilentlyContinue }
  exit 1
}

# Write marker
Set-Content -Path $markerPath -Value '{"fromVersion":"${fromVersion}","toVersion":"${toVersion}"}' -Encoding UTF8

# Cleanup
if (Test-Path $newAsarPath) { Remove-Item -Path $newAsarPath -Force -ErrorAction SilentlyContinue }

# Restart
Start-Process -FilePath $exePath -WindowStyle Normal
`
}

/**
 * Generate the rollback.ps1 script content.
 * Replaces app.asar with app.asar.bak and restarts.
 */
export function generateRollbackPs1(backupAsarPath: string): string {
  const appAsarPath = getAppAsarPath()
  const markerPath = getMarkerPath()
  const exePath = getExePath()
  const exeBaseName = EXE_NAME.replace(".exe", "")

  return `
$exeBaseName    = ${toPsString(exeBaseName)}
$backupAsarPath = ${toPsString(backupAsarPath)}
$appAsarPath    = ${toPsString(appAsarPath)}
$markerPath     = ${toPsString(markerPath)}
$exePath        = ${toPsString(exePath)}

# Wait for process to exit (up to 30s)
$n = 0
while ((Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) -and $n -lt 30) {
  Start-Sleep -Seconds 1
  $n++
}
if (Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) {
  exit 1
}

# Rollback
try {
  Copy-Item -Path $backupAsarPath -Destination $appAsarPath -Force -ErrorAction Stop
} catch {
  exit 1
}

# Remove marker
if (Test-Path $markerPath) { Remove-Item -Path $markerPath -Force -ErrorAction SilentlyContinue }

# Restart
Start-Process -FilePath $exePath -WindowStyle Normal
`
}

/**
 * Generate the full-zip update ps1 script content.
 *   1. Waits for the Electron process to exit
 *   2. Backs up current app directory → appDir.bak\
 *   3. Extracts the zip to a temp directory
 *   4. Copies all extracted files over the app directory
 *   5. Writes update-marker.json for startup self-check
 *   6. Cleans up temp dir and zip file
 *   7. Restarts the application
 */
function generateFullZipUpdatePs1(
  zipPath: string,
  appDir: string,
  exePath: string,
  fromVersion: string,
  toVersion: string
): string {
  const backupDir = `${appDir}.bak`
  const markerPath = join(appDir, "resources", "update-marker.json")
  const exeBaseName = EXE_NAME.replace(".exe", "")

  return `
$exeBaseName = ${toPsString(exeBaseName)}
$zipPath     = ${toPsString(zipPath)}
$appDir      = ${toPsString(appDir)}
$backupDir   = ${toPsString(backupDir)}
$markerPath  = ${toPsString(markerPath)}
$exePath     = ${toPsString(exePath)}
$tempDir     = Join-Path $env:TEMP 'cmbdevclaw_update_tmp'

# Wait for process to exit (up to 30s)
$n = 0
while ((Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) -and $n -lt 30) {
  Start-Sleep -Seconds 1
  $n++
}
if (Get-Process -Name $exeBaseName -ErrorAction SilentlyContinue) {
  exit 1
}

# Backup current installation (copy contents, not the folder itself)
if (Test-Path $backupDir) { Remove-Item -Path $backupDir -Recurse -Force }
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
try {
  Get-ChildItem -Path $appDir -Force | Copy-Item -Destination $backupDir -Recurse -Force -ErrorAction Stop
} catch {
  exit 1
}

# Extract zip
if (Test-Path $tempDir) { Remove-Item -Path $tempDir -Recurse -Force }
try {
  Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force -ErrorAction Stop
} catch {
  exit 1
}

# Copy extracted files over app directory (include hidden files)
try {
  Get-ChildItem -Path $tempDir -Force | Copy-Item -Destination $appDir -Recurse -Force -ErrorAction Stop
} catch {
  Get-ChildItem -Path $backupDir -Force | Copy-Item -Destination $appDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}

# Write marker
Set-Content -Path $markerPath -Value '{"fromVersion":"${fromVersion}","toVersion":"${toVersion}","updateType":"full"}' -Encoding UTF8

# Cleanup
Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

# Restart
Start-Process -FilePath $exePath -WindowStyle Normal
`
}

/**
 * Execute ASAR replacement update.
 * Generates update.ps1, spawns it detached, and quits the app.
 */
export function installAsarUpdate(newAsarPath: string, toVersion: string): void {
  const fromVersion = app.getVersion()
  console.log(`[Updater] Installing ASAR update: ${fromVersion} → ${toVersion}`)
  console.log("[Updater] New ASAR source:", newAsarPath)
  console.log("[Updater] Target ASAR:", getAppAsarPath())
  console.log("[Updater] Backup path:", getBackupPath())
  console.log("[Updater] EXE path:", getExePath())

  const ps1Content = generateUpdatePs1(newAsarPath, fromVersion, toVersion)
  const ps1Path = join(getUpdatesDir(), "update.ps1")

  writePowerShellScript(ps1Path, ps1Content)
  console.log("[Updater] Generated update.ps1 at", ps1Path)

  launchDetachedPowerShellScript(ps1Path)

  console.log("[Updater] Spawned update script, quitting app...")
  app.quit()
}

/**
 * Execute full update.
 * - If the file is a .zip: generates a ps1 script to extract and replace the entire app directory.
 * - If the file is a .exe: launches the NSIS setup installer directly (requires company whitelist).
 */
export function installFullUpdate(filePath: string, toVersion: string): void {
  const isZip = filePath.toLowerCase().endsWith(".zip")

  if (isZip) {
    const exePath = getExePath()
    const appDir = dirname(exePath)
    const fromVersion = app.getVersion()
    console.log(`[Updater] Installing full zip update: ${fromVersion} → ${toVersion}`)
    console.log("[Updater] zip path:", filePath)
    console.log("[Updater] app dir:", appDir)
    console.log("[Updater] exe path:", exePath)

    const ps1Content = generateFullZipUpdatePs1(filePath, appDir, exePath, fromVersion, toVersion)
    const ps1Path = join(getUpdatesDir(), "full-update.ps1")

    writePowerShellScript(ps1Path, ps1Content)
    console.log("[Updater] Generated full-update.ps1 at", ps1Path)

    launchDetachedPowerShellScript(ps1Path)

    console.log("[Updater] Spawned full-update script, quitting app...")
  } else {
    // .exe mode: launch NSIS installer directly (requires company whitelist)
    console.log("[Updater] Launching NSIS installer:", filePath)

    const child = spawn(filePath, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false // Show the NSIS UI
    })
    child.unref()

    console.log("[Updater] Spawned installer, quitting app...")
  }

  app.quit()
}

export { getAppAsarPath, getBackupPath, getMarkerPath, getExePath }
