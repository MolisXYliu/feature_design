import { spawn, ChildProcess } from "child_process"
import { join } from "path"
import { existsSync, readdirSync, mkdirSync, chmodSync } from "fs"
import { createHash } from "crypto"
import { homedir } from "os"
import { app } from "electron"
import AdmZip from "adm-zip"

export interface JdtlsServerOptions {
  projectRoot: string
  maxHeapMb: number
}

/** Where the VSIX zip files live (shipped with the app) */
function getVsixDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "lsp-vsix")
    : join(__dirname, "../../resources/lsp-vsix")
}

/** Where we extract the VSIX contents (user data dir, persistent) */
function getRuntimeDir(): string {
  const dir = join(homedir(), ".cmbcoworkagent", "lsp-runtime")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Get the platform-specific VSIX filename */
function getVsixFilename(): string {
  if (process.platform === "darwin") return "java-darwin-arm64.vsix"
  if (process.platform === "win32") return "java-win32-x64.vsix"
  if (process.platform === "linux") return "java-linux-x64.vsix"
  throw new Error(`Unsupported platform: ${process.platform}. Only macOS, Windows, and Linux are supported.`)
}

/** Ensure VSIX is extracted; returns the extension root (e.g. ~/.cmbcoworkagent/lsp-runtime/extension/) */
function ensureExtracted(): string {
  const runtimeDir = getRuntimeDir()
  const extensionDir = join(runtimeDir, "extension")
  const markerFile = join(runtimeDir, ".extracted")

  if (existsSync(markerFile) && existsSync(extensionDir)) {
    return extensionDir
  }

  const vsixPath = join(getVsixDir(), getVsixFilename())
  if (!existsSync(vsixPath)) {
    throw new Error(`VSIX not found: ${vsixPath}. Please ensure lsp-vsix resources are bundled.`)
  }

  console.log(`[LSP] Extracting VSIX: ${vsixPath} → ${runtimeDir}`)
  const zip = new AdmZip(vsixPath)
  zip.extractAllTo(runtimeDir, true)

  // Mark as extracted
  require("fs").writeFileSync(markerFile, new Date().toISOString())

  // Make java binary executable on macOS
  if (process.platform !== "win32") {
    const jreBinDir = findJreBinDir(extensionDir)
    if (jreBinDir) {
      for (const name of readdirSync(jreBinDir)) {
        try { chmodSync(join(jreBinDir, name), 0o755) } catch { /* ignore */ }
      }
    }
  }

  console.log("[LSP] VSIX extracted successfully")
  return extensionDir
}

function findJreBinDir(extensionDir: string): string | null {
  const jreDir = join(extensionDir, "jre")
  if (!existsSync(jreDir)) return null
  // Find the JRE version directory (e.g., 21.0.7-macosx-aarch64)
  const entries = readdirSync(jreDir)
  for (const entry of entries) {
    const binDir = join(jreDir, entry, "bin")
    if (existsSync(binDir)) return binDir
  }
  return null
}

function getJavaPath(extensionDir: string): string {
  const jreBinDir = findJreBinDir(extensionDir)
  if (!jreBinDir) {
    throw new Error("JRE not found in extracted VSIX")
  }
  const javaBin = process.platform === "win32"
    ? join(jreBinDir, "java.exe")
    : join(jreBinDir, "java")
  if (!existsSync(javaBin)) {
    throw new Error(`Java binary not found: ${javaBin}`)
  }
  return javaBin
}

function findLauncherJar(extensionDir: string): string {
  const pluginsDir = join(extensionDir, "server", "plugins")
  if (!existsSync(pluginsDir)) {
    throw new Error(`JDTLS plugins directory not found: ${pluginsDir}`)
  }
  const entries = readdirSync(pluginsDir)
  const launcher = entries.find((f) => f.startsWith("org.eclipse.equinox.launcher_") && f.endsWith(".jar"))
  if (!launcher) {
    throw new Error("JDTLS launcher JAR not found in plugins directory")
  }
  return join(pluginsDir, launcher)
}

function getConfigDir(extensionDir: string): string {
  const serverDir = join(extensionDir, "server")
  const isArm = process.arch === "arm64"

  const candidates = process.platform === "darwin"
    ? (isArm ? ["config_mac_arm", "config_mac"] : ["config_mac"])
    : process.platform === "linux"
    ? (isArm ? ["config_linux_arm", "config_linux"] : ["config_linux"])
    : ["config_win"]

  for (const name of candidates) {
    const dir = join(serverDir, name)
    if (existsSync(dir)) return dir
  }
  throw new Error(`JDTLS config directory not found in: ${candidates.join(", ")}`)
}

function getLombokJar(extensionDir: string): string | null {
  const lombokDir = join(extensionDir, "lombok")
  if (!existsSync(lombokDir)) return null
  const entries = readdirSync(lombokDir)
  const jar = entries.find((f) => f.startsWith("lombok") && f.endsWith(".jar"))
  return jar ? join(lombokDir, jar) : null
}

function getDataDir(projectRoot: string): string {
  const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12)
  const dataDir = join(homedir(), ".cmbcoworkagent", "lsp-data", hash)
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }
  return dataDir
}

export function spawnJdtls(options: JdtlsServerOptions): ChildProcess {
  const { projectRoot, maxHeapMb } = options

  const extensionDir = ensureExtracted()
  const javaBin = getJavaPath(extensionDir)
  const launcherJar = findLauncherJar(extensionDir)
  const configDir = getConfigDir(extensionDir)
  const dataDir = getDataDir(projectRoot)
  const lombokJar = getLombokJar(extensionDir)

  // Shared index location: reuse Java class indexes across projects
  const sharedIndexDir = join(homedir(), ".cmbcoworkagent", "lsp-shared-index")
  if (!existsSync(sharedIndexDir)) mkdirSync(sharedIndexDir, { recursive: true })

  const args = [
    `-Xmx${maxHeapMb}m`,
    `-Xms100m`,
    // GC tuning: reduce memory footprint and pause times
    "-XX:+UseParallelGC",
    "-XX:GCTimeRatio=4",
    "-XX:AdaptiveSizePolicyWeight=90",
    "-Dsun.zip.disableMemoryMapping=true",
    "-Xlog:disable",
    // Shared index for cross-project reuse
    `-Djdt.core.sharedIndexLocation=${sharedIndexDir}`,
    "--add-modules=ALL-SYSTEM",
    "--add-opens", "java.base/java.util=ALL-UNNAMED",
    "--add-opens", "java.base/java.lang=ALL-UNNAMED",
    "--add-opens", "java.base/sun.nio.fs=ALL-UNNAMED",
  ]

  // Add Lombok support if available
  if (lombokJar) {
    args.push(`-javaagent:${lombokJar}`)
  }

  args.push(
    "-jar", launcherJar,
    "-configuration", configDir,
    "-data", dataDir
  )

  console.log(`[LSP] Spawning JDTLS: ${javaBin}`)
  console.log(`[LSP] Project root: ${projectRoot}`)
  console.log(`[LSP] Data dir: ${dataDir}`)

  // Resolve JAVA_HOME from jre bin dir
  const jreBinDir = findJreBinDir(extensionDir)
  const javaHome = jreBinDir ? join(jreBinDir, "..") : undefined

  const child = spawn(javaBin, args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32", // Create process group for tree kill
    env: {
      ...process.env,
      ...(javaHome ? { JAVA_HOME: javaHome } : {}),
      CLIENT_HOST: projectRoot,
      syntaxserver: "false"
    }
  })

  child.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) console.warn(`[LSP/stderr] ${msg}`)
  })

  // Early failure detection
  if (child.exitCode !== null) {
    throw new Error(`JDTLS process terminated immediately with exit code ${child.exitCode}`)
  }

  return child
}

export function getJavaHome(): string | undefined {
  try {
    const runtimeDir = getRuntimeDir()
    const extensionDir = join(runtimeDir, "extension")
    const jreBinDir = findJreBinDir(extensionDir)
    return jreBinDir ? join(jreBinDir, "..") : undefined
  } catch {
    return undefined
  }
}

export function checkJdtlsAvailable(): { available: boolean; error?: string } {
  try {
    const vsixPath = join(getVsixDir(), getVsixFilename())
    if (!existsSync(vsixPath)) {
      return { available: false, error: `VSIX not found: ${vsixPath}` }
    }
    // If already extracted, verify key files
    const runtimeDir = getRuntimeDir()
    const extensionDir = join(runtimeDir, "extension")
    if (existsSync(join(runtimeDir, ".extracted")) && existsSync(extensionDir)) {
      getJavaPath(extensionDir)
      findLauncherJar(extensionDir)
      getConfigDir(extensionDir)
    }
    return { available: true }
  } catch (e) {
    return { available: false, error: e instanceof Error ? e.message : String(e) }
  }
}
