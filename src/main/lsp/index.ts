import { existsSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { BrowserWindow } from "electron"
import { spawnJdtls, checkJdtlsAvailable, getJavaHome } from "./server"
import { LspClient } from "./client"
import { getLspConfig, saveLspConfig } from "../storage"
import type {
  LspDiagnostic, LspLocation, LspHoverResult, LspSymbol,
  LspCallHierarchyItem, LspCallHierarchyIncomingCall, LspCallHierarchyOutgoingCall
} from "../types"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_RESTARTS = 3
const RESTART_COOLDOWN = 5_000 // 5s between restarts
const CRASH_RESET_WINDOW = 60_000 // crashes outside this window reset count

// --- State ---

type ServerState = "stopped" | "starting" | "running" | "error"

interface ServerEntry {
  client: LspClient
  state: ServerState
}

interface CrashRecord {
  count: number
  lastTime: number
}

const servers = new Map<string, ServerEntry>()
const broken = new Set<string>() // projectRoots that failed spawn/init
const spawning = new Map<string, Promise<void>>() // in-flight spawn dedup
// Crash counts keyed by projectRoot — survives entry replacement during restart
const crashCounts = new Map<string, CrashRecord>()

// --- Broadcast ---

function broadcastDiagnostics(diagnostics: LspDiagnostic[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("lsp:diagnostics", diagnostics)
  }
}

function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("lsp:changed")
  }
}

// --- Crash recovery ---

function setupCrashRecovery(projectRoot: string, entry: ServerEntry): void {
  const proc = entry.client["process"] // access ChildProcess
  if (!proc) return

  proc.once("exit", (code: number | null, signal: string | null) => {
    // Only handle unexpected exits (not our own shutdown)
    if (entry.state !== "running") return

    console.warn(`[LSP] JDTLS crashed for ${projectRoot} (code=${code}, signal=${signal})`)
    entry.state = "error"

    // Crash count lives in projectRoot-keyed Map, survives entry replacement
    const record = crashCounts.get(projectRoot) ?? { count: 0, lastTime: 0 }
    const now = Date.now()
    if (now - record.lastTime > CRASH_RESET_WINDOW) {
      // Last crash was outside the reset window — start fresh
      record.count = 0
    }
    record.count++
    record.lastTime = now
    crashCounts.set(projectRoot, record)

    if (record.count > MAX_RESTARTS) {
      console.error(`[LSP] Max restarts (${MAX_RESTARTS}) exceeded for ${projectRoot}, marking broken`)
      broken.add(projectRoot)
      servers.delete(projectRoot)
      broadcastChanged()
      return
    }

    console.log(`[LSP] Restarting JDTLS for ${projectRoot} (attempt ${record.count}/${MAX_RESTARTS})...`)
    servers.delete(projectRoot)
    broadcastChanged()

    setTimeout(() => {
      startLsp(projectRoot).catch((e) => {
        console.error(`[LSP] Restart failed for ${projectRoot}:`, e)
        broken.add(projectRoot)
        broadcastChanged()
      })
    }, RESTART_COOLDOWN)
  })
}

// --- Lifecycle ---

export async function startLsp(projectRoot: string): Promise<void> {
  // Already running
  const existing = servers.get(projectRoot)
  if (existing && (existing.state === "running" || existing.state === "starting")) {
    console.log("[LSP] Already running for:", projectRoot)
    return
  }

  // Broken — don't retry
  if (broken.has(projectRoot)) {
    throw new Error(`LSP server for ${projectRoot} is broken (too many failures). Restart the app to retry.`)
  }

  // Spawn dedup: if another caller is already starting this server, wait for it
  const inflight = spawning.get(projectRoot)
  if (inflight) {
    return inflight
  }

  const task = doStartLsp(projectRoot)
  spawning.set(projectRoot, task)
  task.finally(() => {
    if (spawning.get(projectRoot) === task) {
      spawning.delete(projectRoot)
    }
  })
  return task
}

async function doStartLsp(projectRoot: string): Promise<void> {
  const check = checkJdtlsAvailable()
  if (!check.available) {
    const errMsg = check.error ?? "JDTLS not available"
    saveLspConfig({ lastError: errMsg })
    broadcastChanged()
    throw new Error(errMsg)
  }

  const config = getLspConfig()
  const maxHeapMb = config.maxHeapMb || 1024

  // Track state as "starting"
  const entry: ServerEntry = {
    client: null as unknown as LspClient,
    state: "starting"
  }

  try {
    const child = spawnJdtls({ projectRoot, maxHeapMb })
    const javaHome = getJavaHome()
    const client = new LspClient(child, projectRoot, javaHome)

    entry.client = client
    servers.set(projectRoot, entry)

    client.setDiagnosticsCallback((diags) => {
      broadcastDiagnostics(diags)
    })

    await client.initialize()

    entry.state = "running"
    saveLspConfig({ lastError: null })
    broadcastChanged()
    console.log("[LSP] Started for:", projectRoot)

    // Watch for unexpected crashes
    setupCrashRecovery(projectRoot, entry)
  } catch (e) {
    entry.state = "error"
    servers.delete(projectRoot)
    const errMsg = e instanceof Error ? e.message : String(e)
    saveLspConfig({ lastError: errMsg })
    broadcastChanged()
    throw e
  }
}

export async function stopLsp(projectRoot: string): Promise<void> {
  const entry = servers.get(projectRoot)
  if (!entry) return

  entry.state = "stopped" // prevent crash recovery from firing
  try {
    await entry.client.shutdown()
  } catch (e) {
    console.warn("[LSP] Error during shutdown:", e)
  } finally {
    servers.delete(projectRoot)
    broadcastChanged()
  }
}

export async function stopAllLsp(): Promise<void> {
  const shutdowns = Array.from(servers.entries()).map(async ([root, entry]) => {
    entry.state = "stopped"
    try {
      await entry.client.shutdown()
    } catch (e) {
      console.warn(`[LSP] Error shutting down for ${root}:`, e)
    }
  })
  await Promise.all(shutdowns)
  servers.clear()
}

export function isLspRunning(projectRoot: string): boolean {
  const entry = servers.get(projectRoot)
  return entry?.state === "running"
}

export function getLspState(projectRoot: string): ServerState | null {
  return servers.get(projectRoot)?.state ?? null
}

export function getClient(projectRoot: string): LspClient | null {
  const entry = servers.get(projectRoot)
  return entry?.state === "running" ? entry.client : null
}

// --- File helpers ---

async function ensureFileOpen(client: LspClient, filePath: string): Promise<void> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
  const stat = statSync(filePath)
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(
      `File too large for LSP: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 10 MB)`
    )
  }
  const content = readFileSync(filePath, "utf-8")
  await client.openFile(filePath, content)
}

// --- High-level operations ---

export async function lspDefinition(projectRoot: string, filePath: string, line: number, column: number): Promise<LspLocation[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.definition(filePath, line, column)
}

export async function lspReferences(projectRoot: string, filePath: string, line: number, column: number): Promise<LspLocation[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.references(filePath, line, column)
}

export async function lspHover(projectRoot: string, filePath: string, line: number, column: number): Promise<LspHoverResult | null> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.hover(filePath, line, column)
}

export async function lspImplementation(projectRoot: string, filePath: string, line: number, column: number): Promise<LspLocation[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.implementation(filePath, line, column)
}

export async function lspDocumentSymbols(projectRoot: string, filePath: string): Promise<LspSymbol[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.documentSymbols(filePath)
}

export async function lspWorkspaceSymbol(projectRoot: string, query: string): Promise<LspSymbol[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  return client.workspaceSymbol(query)
}

export function lspDiagnostics(projectRoot: string, filePath?: string): LspDiagnostic[] {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  return client.getDiagnostics(filePath)
}

export async function lspPrepareCallHierarchy(projectRoot: string, filePath: string, line: number, column: number): Promise<LspCallHierarchyItem[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.prepareCallHierarchy(filePath, line, column)
}

export async function lspIncomingCalls(projectRoot: string, filePath: string, line: number, column: number): Promise<LspCallHierarchyIncomingCall[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.incomingCalls(filePath, line, column)
}

export async function lspOutgoingCalls(projectRoot: string, filePath: string, line: number, column: number): Promise<LspCallHierarchyOutgoingCall[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.outgoingCalls(filePath, line, column)
}

/** Detect if a directory is a Java project */
export function detectJavaProject(dirPath: string): boolean {
  const markers = ["pom.xml", "build.gradle", "build.gradle.kts", ".classpath"]
  return markers.some((m) => existsSync(join(dirPath, m)))
}
