import { app } from "electron"
import { spawn } from "child_process"
import { writeFileSync } from "fs"
import { join, dirname } from "path"
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
 * Generate the update.bat script content for ASAR replacement.
 * The BAT script:
 *   1. Waits for the Electron process to exit (up to 30s)
 *   2. Backs up current app.asar → app.asar.bak
 *   3. Copies new app.asar into place
 *   4. Writes update-marker.json for startup self-check
 *   5. Cleans up temp files
 *   6. Restarts the application
 */
function generateUpdateBat(
  newAsarPath: string,
  fromVersion: string,
  toVersion: string
): string {
  const appAsarPath = getAppAsarPath()
  const backupPath = getBackupPath()
  const markerPath = getMarkerPath()
  const exePath = getExePath()
  const exeName = EXE_NAME

  return `@echo off
chcp 65001 >nul
echo [Updater] Waiting for application to exit...

set RETRY=0
:WAIT_EXIT
tasklist /FI "IMAGENAME eq ${exeName}" 2>nul | find /I "${exeName}" >nul
if not %ERRORLEVEL%==0 goto APP_EXITED
if %RETRY% GEQ 30 goto TIMEOUT
set /A RETRY+=1
timeout /t 1 /nobreak >nul
goto WAIT_EXIT

:TIMEOUT
echo [Updater] Timeout waiting for app to exit, aborting
exit /b 1

:APP_EXITED
echo [Updater] Application exited, starting update...

:: Step 1: Backup current version
if not exist "${appAsarPath}" goto SKIP_BACKUP
copy /Y "${appAsarPath}" "${backupPath}" >nul
if not %ERRORLEVEL%==0 goto BACKUP_FAILED
echo [Updater] Backed up current version
goto DO_REPLACE

:BACKUP_FAILED
echo [Updater] Backup failed
exit /b 1

:SKIP_BACKUP
echo [Updater] No existing asar to backup

:DO_REPLACE
:: Step 2: Replace app.asar
copy /Y "${newAsarPath}" "${appAsarPath}" >nul
if not %ERRORLEVEL%==0 goto REPLACE_FAILED
echo [Updater] Replace successful
goto WRITE_MARKER

:REPLACE_FAILED
echo [Updater] Replace failed, rolling back...
copy /Y "${backupPath}" "${appAsarPath}" >nul
echo [Updater] Rolled back to previous version
exit /b 1

:WRITE_MARKER
:: Step 3: Write update marker for startup self-check
echo {"fromVersion":"${fromVersion}","toVersion":"${toVersion}","updatedAt":"%date% %time%"} > "${markerPath}"

:: Step 4: Clean up downloaded temp file
del /Q "${newAsarPath}" >nul 2>&1

:: Step 5: Restart application
echo [Updater] Starting new version...
start "" "${exePath}"
exit /b 0
`
}

/**
 * Generate the rollback.bat script content.
 * Replaces app.asar with app.asar.bak and restarts.
 */
export function generateRollbackBat(backupAsarPath: string): string {
  const appAsarPath = getAppAsarPath()
  const markerPath = getMarkerPath()
  const exePath = getExePath()
  const exeName = EXE_NAME

  return `@echo off
chcp 65001 >nul
echo [Updater] Rolling back...

set RETRY=0
:WAIT_EXIT
tasklist /FI "IMAGENAME eq ${exeName}" 2>nul | find /I "${exeName}" >nul
if not %ERRORLEVEL%==0 goto DO_ROLLBACK
if %RETRY% GEQ 30 goto TIMEOUT
set /A RETRY+=1
timeout /t 1 /nobreak >nul
goto WAIT_EXIT

:TIMEOUT
echo [Updater] Timeout, aborting rollback
exit /b 1

:DO_ROLLBACK
:: Replace with backup
copy /Y "${backupAsarPath}" "${appAsarPath}" >nul
if not %ERRORLEVEL%==0 goto ROLLBACK_FAILED
goto DONE

:ROLLBACK_FAILED
echo [Updater] Rollback failed
exit /b 1

:DONE
:: Remove update marker
if exist "${markerPath}" del /Q "${markerPath}" >nul 2>&1

echo [Updater] Rollback complete, restarting...
start "" "${exePath}"
exit /b 0
`
}

/**
 * Execute ASAR replacement update.
 * Generates update.bat, spawns it detached, and quits the app.
 */
export function installAsarUpdate(newAsarPath: string, toVersion: string): void {
  const fromVersion = app.getVersion()
  console.log(`[Updater] Installing ASAR update: ${fromVersion} → ${toVersion}`)
  console.log("[Updater] New ASAR source:", newAsarPath)
  console.log("[Updater] Target ASAR:", getAppAsarPath())
  console.log("[Updater] Backup path:", getBackupPath())
  console.log("[Updater] EXE path:", getExePath())

  const batContent = generateUpdateBat(newAsarPath, fromVersion, toVersion)
  const batPath = join(getUpdatesDir(), "update.bat")

  writeFileSync(batPath, batContent, "utf-8")
  console.log("[Updater] Generated update.bat at", batPath)

  // Spawn BAT script in detached mode so it survives app exit
  const child = spawn("cmd", ["/c", batPath, "&&", "pause"], {
    detached: true,
    stdio: "ignore",
    windowsHide: false  // temporarily visible for debugging
  })
  child.unref()

  console.log("[Updater] Spawned update script, quitting app...")
  app.quit()
}

/**
 * Generate the full-zip update BAT script content.
 * The BAT script:
 *   1. Waits for the Electron process to exit
 *   2. Backs up current app directory → appDir.bak/
 *   3. Extracts the zip to a temp directory via PowerShell
 *   4. Copies all extracted files over the app directory
 *   5. Writes update-marker.json for startup self-check
 *   6. Cleans up temp dir and zip file
 *   7. Restarts the application
 */
function generateFullZipUpdateBat(
  zipPath: string,
  appDir: string,
  exePath: string,
  fromVersion: string,
  toVersion: string
): string {
  const backupDir = `${appDir}.bak`
  const tempDir = `%TEMP%\\cmbdevclaw_update_tmp`
  const markerPath = join(appDir, "update-marker.json")
  const exeName = EXE_NAME

  return `@echo off
chcp 65001 >nul
echo [Updater] Waiting for application to exit...

set RETRY=0
:WAIT_EXIT
tasklist /FI "IMAGENAME eq ${exeName}" 2>nul | find /I "${exeName}" >nul
if %ERRORLEVEL%==0 (
    if %RETRY% LSS 30 (
        set /A RETRY+=1
        timeout /t 1 /nobreak >nul
        goto WAIT_EXIT
    ) else (
        echo [Updater] Timeout waiting for app to exit, aborting
        exit /b 1
    )
)

echo [Updater] Application exited, starting full update...

:: Step 1: Backup current installation
if exist "${backupDir}" rmdir /s /q "${backupDir}"
xcopy /e /i /h /y "${appDir}\\" "${backupDir}\\" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [Updater] Backup failed
    exit /b 1
)
echo [Updater] Backup complete

:: Step 2: Extract zip to temp dir
if exist "${tempDir}" rmdir /s /q "${tempDir}"
powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"
if %ERRORLEVEL% NEQ 0 (
    echo [Updater] Extraction failed
    exit /b 1
)
echo [Updater] Extraction complete

:: Step 3: Copy new files over app directory
xcopy /e /i /h /y "${tempDir}\\*" "${appDir}\\" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [Updater] Copy failed, rolling back from backup...
    xcopy /e /i /h /y "${backupDir}\\" "${appDir}\\" >nul
    exit /b 1
)
echo [Updater] Copy complete

:: Step 4: Write update marker for startup self-check
echo {"fromVersion":"${fromVersion}","toVersion":"${toVersion}","updatedAt":"%date% %time%","updateType":"full"} > "${markerPath}"

:: Step 5: Clean up
rmdir /s /q "${tempDir}"
del /Q "${zipPath}" >nul 2>&1

:: Step 6: Restart application
echo [Updater] Starting new version...
start "" "${exePath}"

:: Self-delete
(goto) 2>nul & del "%~f0"
`
}

/**
 * Execute full update.
 * - If the file is a .zip: generates a BAT script to extract and replace the entire app directory.
 * - If the file is a .exe: launches the NSIS setup installer directly (requires company whitelist).
 */
export function installFullUpdate(filePath: string, toVersion: string): void {
  const isZip = filePath.toLowerCase().endsWith(".zip")

  if (isZip) {
    const exePath = getExePath()
    const appDir = dirname(exePath)
    const fromVersion = app.getVersion()
    const batContent = generateFullZipUpdateBat(filePath, appDir, exePath, fromVersion, toVersion)
    const batPath = join(getUpdatesDir(), "full-update.bat")

    writeFileSync(batPath, batContent, "utf-8")
    console.log("[Updater] Generated full-update.bat at", batPath)

    const child = spawn("cmd", ["/c", batPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    })
    child.unref()

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
