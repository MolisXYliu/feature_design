import { IpcMain, dialog, app, BrowserWindow } from "electron"
import Store from "electron-store"
import * as fs from "fs/promises"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import type {
  ModelConfig,
  Provider,
  WorkspaceSetParams,
  WorkspaceLoadParams,
  WorkspaceFileParams
} from "../types"
import { startWatching, stopWatching } from "../services/workspace-watcher"

const execFileAsync = promisify(execFile)

const MAX_WORKTREES = 10

export interface WorktreeInfo {
  path: string
  branch: string
  isMain: boolean
  createdAt?: Date
}

interface GitPanelFileDiff {
  path: string
  diff: string
  additions: number
  deletions: number
}

interface ExecFileError extends Error {
  stderr?: string | Buffer
  stdout?: string | Buffer
}

interface FileHistorySnapshot {
  exists: boolean
  content: string | null
  ts: string
}

type PushStepStatus = "ok" | "failed" | "skipped"
interface PushStepResult {
  step: "pull" | "commit" | "push" | "verify" | "final"
  status: PushStepStatus
  detail: string
}

function normalizeTrackedPath(input: string): string {
  return String(input || "").trim().replace(/^"(.*)"$/, "$1").replace(/\\/g, "/")
}

function normalizeGitRelativePath(input: string): string {
  return String(input || "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
}

function toPosixRelative(input: string): string {
  return normalizeGitRelativePath(input)
}

function isAbsoluteLikePath(input: string): boolean {
  return path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input)
}

function toWorktreeRelativePath(worktreePath: string, rawPath: string): string[] {
  const result = new Set<string>()
  const trimmed = normalizeTrackedPath(rawPath)
  if (!trimmed) return []
  const worktreeAbs = path.resolve(worktreePath)

  // Direct relative candidate (only for non-absolute paths)
  if (!isAbsoluteLikePath(trimmed)) {
    const relDirect = toPosixRelative(trimmed)
    if (relDirect) result.add(relDirect)

    // Recovery for previously stored broken absolute paths (e.g. "Users/xxx" without leading "/").
    const rootedAbs = path.resolve(path.sep, trimmed)
    const rootedRel = path.relative(worktreeAbs, rootedAbs)
    if (rootedRel && !rootedRel.startsWith("..") && !path.isAbsolute(rootedRel)) {
      result.add(toPosixRelative(rootedRel))
    }
  }

  // Absolute candidate under worktree
  const candidateAbs = isAbsoluteLikePath(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(worktreeAbs, trimmed)
  const rel = path.relative(worktreeAbs, candidateAbs)
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    result.add(toPosixRelative(rel))
  }

  return Array.from(result).filter(Boolean)
}

function parsePorcelainPaths(output: string): string[] {
  const lines = output.split("\n").map((line) => line.trimEnd()).filter(Boolean)
  const files: string[] = []
  for (const line of lines) {
    if (line.length < 4) continue
    let rawPath = line.slice(3).trim()
    if (!rawPath) continue
    if (rawPath.includes(" -> ")) {
      rawPath = rawPath.split(" -> ").pop() || rawPath
    }
    rawPath = rawPath.replace(/^"(.*)"$/, "$1").replace(/\\"/g, "\"")
    files.push(normalizeGitRelativePath(rawPath))
  }
  return files
}

function getExecErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error || "")
  const execError = error as ExecFileError
  const stderr = typeof execError.stderr === "string"
    ? execError.stderr
    : execError.stderr
      ? execError.stderr.toString("utf-8")
      : ""
  const stdout = typeof execError.stdout === "string"
    ? execError.stdout
    : execError.stdout
      ? execError.stdout.toString("utf-8")
      : ""
  return [stderr, stdout, execError.message].filter(Boolean).join("\n").trim()
}

function isDubiousOwnershipError(error: unknown): boolean {
  return getExecErrorText(error).toLowerCase().includes("detected dubious ownership")
}

async function addSafeDirectory(worktreePath: string): Promise<void> {
  await execFileAsync("git", ["config", "--global", "--add", "safe.directory", worktreePath])
}

async function runGit(worktreePath: string, args: string[]): Promise<string> {
  const baseArgs = ["-C", worktreePath, ...args]
  try {
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }
    })
    return stdout
  } catch (error) {
    if (!isDubiousOwnershipError(error)) {
      throw error
    }
    // Auto-heal ownership trust issue for this specific worktree, then retry once.
    await addSafeDirectory(worktreePath)
    const { stdout } = await execFileAsync("git", baseArgs, {
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }
    })
    return stdout
  }
}

function parseRemoteHead(lsRemoteOutput: string, branch: string): string | null {
  const target = `refs/heads/${branch}`
  for (const line of lsRemoteOutput.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length >= 2 && parts[1] === target) {
      return parts[0]
    }
  }
  return null
}

function isPathspecNoMatchError(error: unknown): boolean {
  return getExecErrorText(error).toLowerCase().includes("pathspec")
}

function isRebaseConflictError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return text.includes("could not apply") ||
    text.includes("conflict") ||
    text.includes("resolve all conflicts manually")
}

function isMissingRemoteBranchError(error: unknown): boolean {
  const text = getExecErrorText(error).toLowerCase()
  return text.includes("couldn't find remote ref") ||
    text.includes("no such ref was fetched") ||
    text.includes("couldn't find remote branch")
}

async function resolveThreadWorkspaceContext(threadId: string): Promise<{
  metadata: Record<string, unknown>
  workspacePath: string | null
  isWorktree: boolean
  worktreeBaseCommit: string | null
  worktreeBranch: string | null
}> {
  const { getThread } = await import("../db")
  const thread = getThread(threadId)
  let metadata: Record<string, unknown> = {}
  try {
    metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
  } catch {
    metadata = {}
  }
  const workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
  const isWorktree = Boolean(metadata.isWorktree)
  const worktreeBaseCommit =
    typeof metadata.worktreeBaseCommit === "string" ? metadata.worktreeBaseCommit : null
  const worktreeBranch =
    typeof metadata.worktreeBranch === "string" ? metadata.worktreeBranch : null
  return { metadata, workspacePath, isWorktree, worktreeBaseCommit, worktreeBranch }
}

function getFileHistoryMap(metadata: Record<string, unknown>): Record<string, FileHistorySnapshot[]> {
  const raw = metadata.llmFileHistory
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const map: Record<string, FileHistorySnapshot[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    map[key] = value
      .filter(
        (v): v is FileHistorySnapshot =>
          Boolean(v) &&
          typeof v === "object" &&
          typeof (v as FileHistorySnapshot).exists === "boolean" &&
          typeof (v as FileHistorySnapshot).ts === "string" &&
          (((v as FileHistorySnapshot).content === null) || typeof (v as FileHistorySnapshot).content === "string")
      )
  }
  return map
}

async function readFileSnapshot(worktreePath: string, relPath: string): Promise<FileHistorySnapshot> {
  const absPath = path.join(worktreePath, relPath)
  try {
    const stat = await fs.stat(absPath)
    if (!stat.isFile()) {
      return { exists: false, content: null, ts: new Date().toISOString() }
    }
    const content = await fs.readFile(absPath, "utf-8")
    return { exists: true, content, ts: new Date().toISOString() }
  } catch {
    return { exists: false, content: null, ts: new Date().toISOString() }
  }
}

function shouldAppendSnapshot(history: FileHistorySnapshot[], next: FileHistorySnapshot): boolean {
  const last = history[history.length - 1]
  if (!last) return true
  if (last.exists !== next.exists) return true
  if (!last.exists && !next.exists) return false
  return last.content !== next.content
}

async function applyFileSnapshot(worktreePath: string, relPath: string, snapshot: FileHistorySnapshot): Promise<void> {
  const absPath = path.join(worktreePath, relPath)
  if (!snapshot.exists) {
    await fs.rm(absPath, { force: true })
    return
  }
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, snapshot.content ?? "", "utf-8")
}

function getTrackedLlmFiles(metadata: Record<string, unknown>): string[] {
  const raw = metadata.llmModifiedFiles
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeTrackedPath(item))
    .filter(Boolean)
}

async function buildGitPanelState(worktreePath: string, trackedFiles: string[]): Promise<{
  files: GitPanelFileDiff[]
  changedFiles: string[]
  totals: { additions: number; deletions: number; fileCount: number }
}> {
  const trackedSet = new Set<string>()
  for (const tracked of trackedFiles) {
    for (const rel of toWorktreeRelativePath(worktreePath, tracked)) {
      trackedSet.add(rel)
    }
  }
  const normalizedTrackedFiles = Array.from(trackedSet)

  if (normalizedTrackedFiles.length === 0) {
    return { files: [], changedFiles: [], totals: { additions: 0, deletions: 0, fileCount: 0 } }
  }

  const statusOut = await runGit(worktreePath, ["status", "--porcelain", "--", ...normalizedTrackedFiles])
  const changedFiles = Array.from(new Set(parsePorcelainPaths(statusOut))).filter((p) =>
    trackedSet.has(p)
  )
  if (changedFiles.length === 0) {
    return { files: [], changedFiles: [], totals: { additions: 0, deletions: 0, fileCount: 0 } }
  }

  const fileDiffs: GitPanelFileDiff[] = []
  let additionsTotal = 0
  let deletionsTotal = 0

  for (const relPath of changedFiles) {
    let diffText = ""
    let additions = 0
    let deletions = 0

    try {
      diffText = await runGit(worktreePath, ["diff", "--", relPath])
    } catch {
      diffText = ""
    }

    const numstatOut = await runGit(worktreePath, ["diff", "--numstat", "--", relPath]).catch(() => "")
    if (numstatOut.trim()) {
      const first = numstatOut.trim().split("\n")[0].split("\t")
      const a = Number(first[0])
      const d = Number(first[1])
      additions = Number.isFinite(a) ? a : 0
      deletions = Number.isFinite(d) ? d : 0
    } else {
      // New untracked file: synthesize a minimal unified diff and stats.
      const absPath = path.join(worktreePath, relPath)
      try {
        const content = await fs.readFile(absPath, "utf-8")
        const lines = content.split("\n")
        additions = lines.length
        deletions = 0
        const body = lines.map((line) => `+${line}`).join("\n")
        diffText = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}`
      } catch {
        // Keep empty if file disappeared between scans.
      }
    }

    additionsTotal += additions
    deletionsTotal += deletions
    fileDiffs.push({
      path: relPath,
      diff: diffText,
      additions,
      deletions
    })
  }

  return {
    files: fileDiffs,
    changedFiles,
    totals: {
      additions: additionsTotal,
      deletions: deletionsTotal,
      fileCount: fileDiffs.length
    }
  }
}

async function getGitRoot(folderPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", folderPath, "rev-parse", "--show-toplevel"])
    return stdout.trim()
  } catch {
    return null
  }
}

async function listWorktrees(gitRoot: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execFileAsync("git", ["-C", gitRoot, "worktree", "list", "--porcelain"])
  const worktrees: WorktreeInfo[] = []
  const blocks = stdout.trim().split(/\n\n+/)

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block.trim()) continue
    const lines = block.trim().split("\n")
    const worktreePath = lines.find((l) => l.startsWith("worktree "))?.slice(9).trim() ?? ""
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).trim().replace("refs/heads/", "") ?? "(detached)"
    const isMain = lines.some((l) => l === "bare") || i === 0

    let createdAt: Date | undefined
    try {
      const stat = await fs.stat(worktreePath)
      createdAt = stat.birthtime
    } catch {
      createdAt = undefined
    }

    if (worktreePath) {
      worktrees.push({ path: worktreePath, branch, isMain, createdAt })
    }
  }

  return worktrees
}

import {
  getOpenworkDir,
  getCustomModelPublicConfigById,
  getCustomModelPublicConfigs,
  getCustomModelConfigById,
  setCustomModelConfig,
  upsertCustomModelConfig,
  deleteCustomModelConfig,
  upsertUserInfoConfig,
  getUserInfo,
  DEFAULT_MAX_TOKENS,
  MIN_MAX_TOKENS,
  MAX_MAX_TOKENS
} from "../storage"
import type { CustomModelConfig } from "../storage"

// Store for non-sensitive settings only (no encryption needed)
const store = new Store({
  name: "settings",
  cwd: getOpenworkDir()
})

const PROVIDERS: Omit<Provider, "hasAnyModelApiKey">[] = [
  { id: "custom", name: "Custom" }
]

function resolveDefaultModelId(): string {
  const customConfigs = getCustomModelPublicConfigs()
  return customConfigs.length > 0 ? `custom:${customConfigs[0].id}` : ""
}

export function registerModelHandlers(ipcMain: IpcMain): void {
  // List available models (custom only)
  ipcMain.handle("models:list", async () => {
    const customConfigs = getCustomModelPublicConfigs()
    const models: ModelConfig[] = customConfigs.map((customConfig) => ({
      id: `custom:${customConfig.id}`,
      name: customConfig.name,
      provider: "custom",
      model: customConfig.model,
      description: customConfig.baseUrl,
      available: customConfig.hasApiKey,
      ...(customConfig.tier !== undefined && { tier: customConfig.tier })
    }))

    return models
  })

  ipcMain.handle("models:getCustomConfigs", async () => {
    return getCustomModelPublicConfigs()
  })

  ipcMain.handle("models:getCustomConfig", async (_event, id?: string) => {
    if (id) {
      return getCustomModelPublicConfigById(id)
    }
    const all = getCustomModelPublicConfigs()
    return all[0] || null
  })

  ipcMain.handle("models:setCustomConfig", async (_event, config: CustomModelConfig) => {
    setCustomModelConfig(config)
  })

  ipcMain.handle(
    "models:upsertCustomConfig",
    async (_event, config: Omit<CustomModelConfig, "id"> & { id?: string }) => {
      const id = upsertCustomModelConfig(config)
      return { id }
    }
  )

  ipcMain.handle(
    "models:upsertUserInfo",
    async (_event, config: Omit<CustomModelConfig, "id"> & { id?: string }) => {
      const id = upsertUserInfoConfig(config)
      return { id }
    }
  )

  ipcMain.handle(
    "models:getUserInfo",
    async () => {
      const userInfo = getUserInfo()
      return userInfo
    }
  )

  ipcMain.handle("models:deleteCustomConfig", async (_event, id: string) => {
    if (!id) throw new Error("Model id is required for deletion")
    deleteCustomModelConfig(id)
  })

  // Get default model
  ipcMain.handle("models:getDefault", async () => {
    const stored = store.get("defaultModel", "") as string
    return stored || resolveDefaultModelId()
  })

  // Set default model
  ipcMain.handle("models:setDefault", async (_event, modelId: string) => {
    store.set("defaultModel", modelId)
  })

  // List providers with whether any model has a key configured.
  ipcMain.handle("models:listProviders", async () => {
    const hasAnyModelApiKey = getCustomModelPublicConfigs().some((config) => config.hasApiKey)
    return PROVIDERS.map((provider) => ({
      ...provider,
      hasAnyModelApiKey
    }))
  })

  ipcMain.handle("models:getTokenLimits", async () => {
    return {
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      minMaxTokens: MIN_MAX_TOKENS,
      maxMaxTokens: MAX_MAX_TOKENS
    }
  })

  // Test model connection by sending a minimal chat completions request
  ipcMain.handle(
    "models:testConnection",
    async (
      _event,
      params: { id?: string; baseUrl?: string; model?: string; apiKey?: string }
    ): Promise<{ success: boolean; error?: string; latencyMs?: number }> => {
      let baseUrl: string
      let model: string
      let apiKey: string

      if (params.id) {
        // Test an existing saved config — read API key from storage
        const saved = getCustomModelConfigById(params.id)
        if (!saved) return { success: false, error: "未找到该模型配置" }
        baseUrl = params.baseUrl || saved.baseUrl
        model = params.model || saved.model
        apiKey = params.apiKey || saved.apiKey || ""
      } else {
        baseUrl = params.baseUrl || ""
        model = params.model || ""
        apiKey = params.apiKey || ""
      }

      if (!baseUrl) return { success: false, error: "接口地址不能为空" }
      if (!model) return { success: false, error: "模型名称不能为空" }
      if (!apiKey) return { success: false, error: "API 密钥不能为空" }

      // Normalise URL: parse first, then operate on pathname to handle query params correctly
      let urlObj: URL
      try {
        urlObj = new URL(baseUrl.replace(/\/+$/, ""))
      } catch {
        return { success: false, error: "接口地址格式无效" }
      }
      if (!["http:", "https:"].includes(urlObj.protocol)) {
        return { success: false, error: "仅支持 http/https 协议" }
      }
      urlObj.pathname = urlObj.pathname
        .replace(/\/chat\/completions\/?$/, "")
        .replace(/\/+$/, "") + "/chat/completions"
      const url = urlObj.toString()

      const start = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Hi" }],
            max_tokens: 1,
            stream: false
          }),
          signal: controller.signal
        })

        const latencyMs = Date.now() - start

        if (!res.ok) {
          const body = await res.text().catch(() => "")
          let detail = ""
          try {
            const json = JSON.parse(body)
            detail = json.error?.message || json.message || ""
          } catch {
            detail = body.slice(0, 200)
          }
          return {
            success: false,
            error: `HTTP ${res.status}${detail ? ": " + detail : ""}`,
            latencyMs
          }
        }

        return { success: true, latencyMs }
      } catch (e) {
        const latencyMs = Date.now() - start
        const msg =
          e instanceof Error
            ? e.name === "AbortError"
              ? "连接超时（15 秒）"
              : e.message
            : "未知错误"
        return { success: false, error: msg, latencyMs }
      } finally {
        clearTimeout(timeout)
      }
    }
  )

  // Sync version info
  ipcMain.on("app:version", (event) => {
    event.returnValue = app.getVersion()
  })

  // Get workspace path for a thread (from thread metadata)
  ipcMain.handle("workspace:get", async (_event, threadId?: string) => {
    if (!threadId) {
      // Fallback to global setting for backwards compatibility
      return store.get("workspacePath", null) as string | null
    }

    // Get from thread metadata via threads:get
    const { getThread } = await import("../db")
    const thread = getThread(threadId)
    if (!thread?.metadata) return null

    const metadata = JSON.parse(thread.metadata)
    return metadata.workspacePath || null
  })

  // Set workspace path for a thread (stores in thread metadata)
  ipcMain.handle(
    "workspace:set",
    async (_event, { threadId, path: newPath }: WorkspaceSetParams) => {
      if (!threadId) {
        // Fallback to global setting
        if (newPath) {
          store.set("workspacePath", newPath)
        } else {
          store.delete("workspacePath")
        }
        return newPath
      }

      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (!thread) return null

      const metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
      metadata.workspacePath = newPath
      updateThread(threadId, { metadata: JSON.stringify(metadata) })

      // Update file watcher
      if (newPath) {
        startWatching(threadId, newPath)
      } else {
        stopWatching(threadId)
      }

      return newPath
    }
  )

  // Select workspace folder via dialog (for a specific thread)
  ipcMain.handle("workspace:select", async (_event, threadId?: string) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Select Workspace Folder",
      message: "Choose a folder for the agent to work in"
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const selectedPath = result.filePaths[0]

    if (threadId) {
      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (thread) {
        const metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
        metadata.workspacePath = selectedPath
        updateThread(threadId, { metadata: JSON.stringify(metadata) })

        // Start watching the new workspace
        startWatching(threadId, selectedPath)
      }
    } else {
      // Fallback to global
      store.set("workspacePath", selectedPath)
    }

    return selectedPath
  })

  // Load files from disk into the workspace view
  ipcMain.handle("workspace:loadFromDisk", async (_event, { threadId }: WorkspaceLoadParams) => {
    const { getThread } = await import("../db")

    // Get workspace path from thread metadata
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | null

    if (!workspacePath) {
      return { success: false, error: "No workspace folder linked", files: [] }
    }

    try {
      const files: Array<{
        path: string
        is_dir: boolean
        size?: number
        modified_at?: string
      }> = []

      // Recursively read directory
      async function readDir(dirPath: string, relativePath: string = ""): Promise<void> {
        const entries = await fs.readdir(dirPath, { withFileTypes: true })

        for (const entry of entries) {
          // Skip hidden files and common non-project files
          if (entry.name.startsWith(".") || entry.name === "node_modules") {
            continue
          }

          const fullPath = path.join(dirPath, entry.name)
          const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

          if (entry.isDirectory()) {
            files.push({
              path: "/" + relPath,
              is_dir: true
            })
            await readDir(fullPath, relPath)
          } else {
            const stat = await fs.stat(fullPath)
            files.push({
              path: "/" + relPath,
              is_dir: false,
              size: stat.size,
              modified_at: stat.mtime.toISOString()
            })
          }
        }
      }

      await readDir(workspacePath)

      // Start watching for file changes
      startWatching(threadId, workspacePath)

      return {
        success: true,
        files,
        workspacePath
      }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Unknown error",
        files: []
      }
    }
  })

  // Read a single file's contents from disk
  ipcMain.handle(
    "workspace:readFile",
    async (_event, { threadId, filePath }: WorkspaceFileParams) => {
      const { getThread } = await import("../db")

      // Get workspace path from thread metadata
      const thread = getThread(threadId)
      const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
      const workspacePath = metadata.workspacePath as string | null

      if (!workspacePath) {
        return {
          success: false,
          error: "No workspace folder linked"
        }
      }

      try {
        // Convert virtual path to full disk path
        const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath
        const fullPath = path.join(workspacePath, relativePath)

        // Security check: ensure the resolved path is within the workspace
        const resolvedPath = path.resolve(fullPath)
        const resolvedWorkspace = path.resolve(workspacePath)
        if (!resolvedPath.startsWith(resolvedWorkspace)) {
          return { success: false, error: "Access denied: path outside workspace" }
        }

        // Check if file exists
        const stat = await fs.stat(fullPath)
        if (stat.isDirectory()) {
          return { success: false, error: "Cannot read directory as file" }
        }

        // Read file contents
        const content = await fs.readFile(fullPath, "utf-8")

        return {
          success: true,
          content,
          size: stat.size,
          modified_at: stat.mtime.toISOString()
        }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "Unknown error"
        }
      }
    }
  )

  // Check if a folder is a git repo and return root path + worktrees
  ipcMain.handle("workspace:isGit", async (_event, folderPath: string) => {
    const gitRoot = await getGitRoot(folderPath)
    if (!gitRoot) return { isGit: false, gitRoot: null, worktrees: [], isWorktreePath: false }

    // Detect if folderPath is itself a worktree (not the main repo).
    // In a worktree, "git rev-parse --git-dir" returns a path like /repo/.git/worktrees/<name>
    let isWorktreePath = false
    try {
      const { stdout } = await execFileAsync("git", ["-C", folderPath, "rev-parse", "--git-dir"])
      isWorktreePath = stdout.trim().includes(`${path.sep}worktrees${path.sep}`) ||
                       stdout.trim().includes("/.git/worktrees/")
    } catch { /* ignore */ }

    const worktrees = await listWorktrees(gitRoot)
    return { isGit: true, gitRoot, worktrees, isWorktreePath }
  })

  // List worktrees for a git repo
  ipcMain.handle("workspace:listWorktrees", async (_event, gitRoot: string) => {
    try {
      return await listWorktrees(gitRoot)
    } catch {
      return []
    }
  })

  // Create a new worktree; enforces MAX_WORKTREES limit
  ipcMain.handle(
    "workspace:createWorktree",
    async (_event, { gitRoot, branch }: { gitRoot: string; branch: string }) => {
      const worktrees = await listWorktrees(gitRoot)
      const nonMain = worktrees.filter((w) => !w.isMain)

      if (nonMain.length >= MAX_WORKTREES) {
        return {
          success: false,
          error: `已达到 Worktree 数量上限（${MAX_WORKTREES} 个），请先删除不用的 Worktree 后再创建。`
        }
      }

      const safeBranch = branch.replace(/[^a-zA-Z0-9\-_./]/g, "-")

      // Check if branch is already checked out in an existing worktree
      const branchConflict = worktrees.find((w) => w.branch === safeBranch)
      if (branchConflict) {
        return {
          success: false,
          error: `分支 "${safeBranch}" 已在 Worktree 中使用（${branchConflict.path}），同一分支不能同时被两个 Worktree 检出。`
        }
      }

      const repoName = path.basename(gitRoot)
      const baseDir = path.join(gitRoot, "..")
      const baseName = `${repoName}-wt-${safeBranch.replace(/\//g, "-")}`

      // Resolve unique path by appending -2, -3... if directory already exists
      let worktreePath = path.join(baseDir, baseName)
      let suffix = 2
      while (true) {
        try {
          await fs.access(worktreePath)
          worktreePath = path.join(baseDir, `${baseName}-${suffix}`)
          suffix++
        } catch {
          break
        }
      }

      try {
        // Get the current branch of the main repo as the base branch
        let baseBranch = "main"
        let baseCommit = ""
        try {
          const r = await execFileAsync("git", ["-C", gitRoot, "rev-parse", "--abbrev-ref", "HEAD"])
          baseBranch = r.stdout.trim() || "main"
        } catch { /* ignore */ }
        try {
          const r = await execFileAsync("git", ["-C", gitRoot, "rev-parse", "HEAD"])
          baseCommit = r.stdout.trim()
        } catch { /* ignore */ }

        await execFileAsync("git", ["-C", gitRoot, "worktree", "add", "-b", safeBranch, worktreePath])
        return { success: true, path: worktreePath, branch: safeBranch, baseBranch, baseCommit }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "创建 Worktree 失败"
        }
      }
    }
  )

  // Save worktree context (gitRoot, branch, baseBranch) into thread metadata
  ipcMain.handle(
    "workspace:saveWorktreeContext",
    async (
      _event,
      {
        threadId,
        gitRoot,
        branch,
        baseBranch,
        baseCommit
      }: {
        threadId: string
        gitRoot: string
        branch: string
        baseBranch?: string
        baseCommit?: string
      }
    ) => {
      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (!thread) return
      let metadata: Record<string, unknown> = {}
      try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { /* corrupted, reset */ }
      metadata.gitRoot = gitRoot
      metadata.isWorktree = true
      metadata.worktreeBranch = branch
      if (baseBranch) metadata.worktreeBaseBranch = baseBranch
      if (baseCommit) metadata.worktreeBaseCommit = baseCommit
      metadata.llmModifiedFiles = []
      metadata.llmFileHistory = {}
      updateThread(threadId, { metadata: JSON.stringify(metadata) })
    }
  )

  // Clear worktree context from thread metadata
  ipcMain.handle("workspace:clearWorktreeContext", async (_event, threadId: string) => {
    const { getThread, updateThread } = await import("../db")
    const thread = getThread(threadId)
    if (!thread) return
    let metadata: Record<string, unknown> = {}
    try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { /* corrupted, reset */ }
    delete metadata.isWorktree
    delete metadata.gitRoot
    delete metadata.worktreeBranch
    delete metadata.worktreeBaseBranch
    delete metadata.worktreeBaseCommit
    delete metadata.llmModifiedFiles
    delete metadata.llmFileHistory
    updateThread(threadId, { metadata: JSON.stringify(metadata) })
  })

  ipcMain.handle(
    "workspace:recordLlmModifiedFiles",
    async (_event, { threadId, files }: { threadId: string; files: string[] }) => {
      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (!thread) return { success: false, error: "Thread not found" }
      let metadata: Record<string, unknown> = {}
      try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
      const workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
      const existing = new Set(getTrackedLlmFiles(metadata))
      const fileHistory = getFileHistoryMap(metadata)
      for (const file of files || []) {
        const normalized = normalizeTrackedPath(file)
        if (normalized) existing.add(normalized)
        if (!workspacePath) continue
        const relCandidates = toWorktreeRelativePath(workspacePath, normalized)
        for (const relPath of relCandidates) {
          const snapshot = await readFileSnapshot(workspacePath, relPath)
          const history = fileHistory[relPath] || []
          if (shouldAppendSnapshot(history, snapshot)) {
            history.push(snapshot)
          }
          fileHistory[relPath] = history
        }
      }
      metadata.llmModifiedFiles = Array.from(existing)
      metadata.llmFileHistory = fileHistory
      updateThread(threadId, { metadata: JSON.stringify(metadata) })
      return { success: true, files: Array.from(existing) }
    }
  )

  ipcMain.handle("workspace:getGitPanelState", async (_event, { threadId }: { threadId: string }) => {
    try {
      const context = await resolveThreadWorkspaceContext(threadId)
      if (!context.workspacePath) {
        return {
          success: false,
          isWorktree: false,
          taskId: threadId,
          files: [],
          totals: { additions: 0, deletions: 0, fileCount: 0 },
          hasPendingDiff: false,
          error: "未配置工作区"
        }
      }
      if (!context.isWorktree) {
        return {
          success: false,
          isWorktree: false,
          taskId: threadId,
          files: [],
          totals: { additions: 0, deletions: 0, fileCount: 0 },
          hasPendingDiff: false,
          error: "当前任务未使用 worktree，无法打开 Git Panel"
        }
      }

      const tracked = getTrackedLlmFiles(context.metadata)
      const state = await buildGitPanelState(context.workspacePath, tracked)
      return {
        success: true,
        isWorktree: true,
        taskId: threadId,
        files: state.files,
        totals: state.totals,
        hasPendingDiff: state.files.length > 0,
        trackedFiles: tracked,
        worktreeBranch: context.worktreeBranch,
        suggestedCommitMessage:
          state.files.length > 0
            ? `feat(task:${threadId.slice(0, 8)}): update ${state.files.length} llm-modified file(s)`
            : ""
      }
    } catch (e) {
      return {
        success: false,
        isWorktree: false,
        taskId: threadId,
        files: [],
        totals: { additions: 0, deletions: 0, fileCount: 0 },
        hasPendingDiff: false,
        error: e instanceof Error ? e.message : "加载 Git Panel 失败"
      }
    }
  })

  ipcMain.handle("workspace:getGitPanelSummary", async (_event, { threadId }: { threadId: string }) => {
    try {
      const context = await resolveThreadWorkspaceContext(threadId)
      if (!context.workspacePath || !context.isWorktree) {
        return { success: true, isWorktree: false, hasPendingDiff: false, changedFiles: 0 }
      }
      const tracked = getTrackedLlmFiles(context.metadata)
      const state = await buildGitPanelState(context.workspacePath, tracked)
      return {
        success: true,
        isWorktree: true,
        hasPendingDiff: state.files.length > 0,
        changedFiles: state.files.length
      }
    } catch {
      return { success: true, isWorktree: false, hasPendingDiff: false, changedFiles: 0 }
    }
  })

  // Commit only LLM-tracked files in a worktree with a user-provided message.
  ipcMain.handle(
    "workspace:commitWorktree",
    async (
      _event,
      { threadId, message }: { threadId: string; message: string }
    ) => {
      try {
        const context = await resolveThreadWorkspaceContext(threadId)
        const worktreePath = context.workspacePath
        if (!worktreePath || !context.isWorktree) {
          return { success: false, error: "当前任务不在 worktree 中" }
        }
        const tracked = getTrackedLlmFiles(context.metadata)
        if (tracked.length === 0) {
          return { success: false, error: "没有可提交的 LLM 改动文件" }
        }
        const state = await buildGitPanelState(worktreePath, tracked)
        if (state.changedFiles.length === 0) {
          return { success: false, error: "没有需要提交的改动" }
        }

        await runGit(worktreePath, ["add", "--", ...state.changedFiles])
        await runGit(worktreePath, ["commit", "-m", message])
        const { getThread, updateThread } = await import("../db")
        const thread = getThread(threadId)
        if (thread) {
          let metadata: Record<string, unknown> = {}
          try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
          metadata.llmModifiedFiles = []
          metadata.llmFileHistory = {}
          updateThread(threadId, { metadata: JSON.stringify(metadata) })
        }
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "提交失败" }
      }
    }
  )

  ipcMain.handle(
    "workspace:pushWorktree",
    async (_event, { threadId, message }: { threadId: string; message?: string }) => {
      let autoCommitted = false
      let autoCommitHead: string | null = null
      const steps: PushStepResult[] = []
      try {
        const context = await resolveThreadWorkspaceContext(threadId)
        const worktreePath = context.workspacePath
        if (!worktreePath || !context.isWorktree) {
          steps.push({ step: "final", status: "failed", detail: "当前任务不在 worktree 中" })
          return { success: false, error: "当前任务不在 worktree 中", steps }
        }

        const rollbackAutoCommit = async (): Promise<void> => {
          if (!autoCommitted || !autoCommitHead) return
          try {
            const currentHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim()
            if (currentHead === autoCommitHead) {
              await runGit(worktreePath, ["reset", "--mixed", "HEAD~1"])
            }
          } catch {
            // ignore rollback failure; return original error to user
          }
        }

        const branch =
          context.worktreeBranch || (await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()

        // Step 1: Pull first (always).
        try {
          await runGit(worktreePath, ["pull", "--rebase", "--autostash", "origin", branch])
          steps.push({ step: "pull", status: "ok", detail: `pull --rebase origin ${branch} 成功` })
        } catch (pullError) {
          if (isMissingRemoteBranchError(pullError)) {
            steps.push({ step: "pull", status: "skipped", detail: `远端不存在分支 ${branch}，将直接 push 创建` })
          } else {
            const detail = getExecErrorText(pullError)
            if (isRebaseConflictError(pullError)) {
              steps.push({ step: "pull", status: "failed", detail: "pull --rebase 发生冲突，请先手动解决冲突" })
              steps.push({ step: "final", status: "failed", detail: "流程中断：pull 冲突" })
              return {
                success: false,
                error: "远端分支同步时发生冲突，请先解决冲突后再 Push。",
                steps
              }
            }
            steps.push({ step: "pull", status: "failed", detail: detail || "pull 失败" })
            steps.push({ step: "final", status: "failed", detail: "流程中断：pull 失败" })
            return {
              success: false,
              error: `Pull 失败：${detail || "unknown error"}`,
              steps
            }
          }
        }

        // Step 2: Auto-commit only pending tracked changes.
        const tracked = getTrackedLlmFiles(context.metadata)
        if (tracked.length > 0) {
          const pending = await buildGitPanelState(worktreePath, tracked)
          if (pending.changedFiles.length > 0) {
            const commitMessage = (message || "").trim() ||
              `chore(task:${threadId.slice(0, 8)}): auto commit before push`
            try {
              await runGit(worktreePath, ["add", "--", ...pending.changedFiles])
              await runGit(worktreePath, ["commit", "-m", commitMessage])
              autoCommitted = true
              autoCommitHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim()
              steps.push({ step: "commit", status: "ok", detail: `自动提交成功：${commitMessage}` })
            } catch (commitError) {
              const detail = getExecErrorText(commitError)
              steps.push({ step: "commit", status: "failed", detail: detail || "自动提交失败" })
              steps.push({ step: "final", status: "failed", detail: "流程中断：commit 失败" })
              return { success: false, error: detail || "自动提交失败", steps }
            }
          } else {
            steps.push({ step: "commit", status: "skipped", detail: "无待提交改动，跳过自动提交" })
          }
        } else {
          steps.push({ step: "commit", status: "skipped", detail: "无 LLM 追踪文件，跳过自动提交" })
        }

        // Step 3: Push
        try {
          await runGit(worktreePath, ["push", "-u", "origin", branch])
          steps.push({ step: "push", status: "ok", detail: `push origin ${branch} 成功` })
        } catch (pushError) {
          await rollbackAutoCommit()
          const detail = getExecErrorText(pushError)
          if (detail.toLowerCase().includes("detected dubious ownership")) {
            steps.push({ step: "push", status: "failed", detail: "Git safe.directory 校验失败" })
            steps.push({ step: "final", status: "failed", detail: "流程中断：仓库权限校验失败" })
            return {
              success: false,
              error: `Git 安全目录校验失败，请执行：git config --global --add safe.directory "${worktreePath}"`,
              steps
            }
          }
          steps.push({ step: "push", status: "failed", detail: detail || "push 失败" })
          steps.push({ step: "final", status: "failed", detail: "流程结束：push 失败" })
          return { success: false, error: detail || "推送失败", steps }
        }

        // Step 4: Verify remote head
        const localHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim()
        const remoteHeads = await runGit(worktreePath, ["ls-remote", "--heads", "origin", branch])
        const remoteHead = parseRemoteHead(remoteHeads, branch)
        if (!remoteHead) {
          await rollbackAutoCommit()
          steps.push({ step: "verify", status: "failed", detail: `远端未找到分支 ${branch}` })
          steps.push({ step: "final", status: "failed", detail: "流程结束：push 后校验失败" })
          return { success: false, error: `推送后未在远端找到分支 ${branch}`, steps }
        }
        if (remoteHead !== localHead) {
          await rollbackAutoCommit()
          steps.push({
            step: "verify",
            status: "failed",
            detail: `远端提交 ${remoteHead.slice(0, 8)} 与本地 ${localHead.slice(0, 8)} 不一致`
          })
          steps.push({ step: "final", status: "failed", detail: "流程结束：push 后校验失败" })
          return { success: false, error: `推送校验失败：远端 ${branch} 未更新到最新提交`, steps }
        }
        steps.push({ step: "verify", status: "ok", detail: `远端 ${branch} 已同步到 ${localHead.slice(0, 8)}` })

        if (autoCommitted) {
          const { getThread, updateThread } = await import("../db")
          const thread = getThread(threadId)
          if (thread) {
            let metadata: Record<string, unknown> = {}
            try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
            metadata.llmModifiedFiles = []
            metadata.llmFileHistory = {}
            updateThread(threadId, { metadata: JSON.stringify(metadata) })
          }
        }

        steps.push({ step: "final", status: "ok", detail: autoCommitted ? "自动提交并推送成功" : "推送成功" })
        return { success: true, autoCommitted, steps }
      } catch (e) {
        const detail = getExecErrorText(e)
        steps.push({ step: "final", status: "failed", detail: detail || "流程异常中断" })
        return {
          success: false,
          error: detail || (e instanceof Error ? e.message : "推送失败"),
          steps
        }
      }
    }
  )

  ipcMain.handle("workspace:rejectWorktreeChanges", async (_event, { threadId }: { threadId: string }) => {
    try {
      const context = await resolveThreadWorkspaceContext(threadId)
      const worktreePath = context.workspacePath
      if (!worktreePath || !context.isWorktree) {
        return { success: false, error: "当前任务不在 worktree 中" }
      }
      const target = context.worktreeBaseCommit || "HEAD"
      await runGit(worktreePath, ["reset", "--hard", target])
      await runGit(worktreePath, ["clean", "-fd"])

      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (thread) {
        let metadata: Record<string, unknown> = {}
        try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
        metadata.llmModifiedFiles = []
        metadata.llmFileHistory = {}
        updateThread(threadId, { metadata: JSON.stringify(metadata) })
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "回滚失败" }
    }
  })

  ipcMain.handle(
    "workspace:rejectWorktreeFile",
    async (_event, { threadId, filePath }: { threadId: string; filePath: string }) => {
      try {
        const context = await resolveThreadWorkspaceContext(threadId)
        const worktreePath = context.workspacePath
        if (!worktreePath || !context.isWorktree) {
          return { success: false, error: "当前任务不在 worktree 中" }
        }

        const tracked = getTrackedLlmFiles(context.metadata)
        const historyMap = getFileHistoryMap(context.metadata)
        const candidates = toWorktreeRelativePath(worktreePath, filePath)
        const targetPath = candidates.find((c) => tracked.some((t) => toWorktreeRelativePath(worktreePath, t).includes(c)))
          || candidates[0]
        if (!targetPath) {
          return { success: false, error: "无法解析待回退文件路径" }
        }

        const fileHistory = historyMap[targetPath] || []
        if (fileHistory.length >= 2) {
          // Revert to previous edited version (one-step undo), not to base commit.
          const previous = fileHistory[fileHistory.length - 2]
          await applyFileSnapshot(worktreePath, targetPath, previous)
          fileHistory.pop()
          historyMap[targetPath] = fileHistory
        } else {
          const target = context.worktreeBaseCommit || "HEAD"
          try {
            await runGit(worktreePath, ["restore", "--source", target, "--staged", "--worktree", "--", targetPath])
          } catch (error) {
            if (!isPathspecNoMatchError(error)) {
              throw error
            }
          }
          // Remove untracked variant for this file if it exists.
          await runGit(worktreePath, ["clean", "-f", "--", targetPath]).catch(() => {})
        }

        const postState = await buildGitPanelState(worktreePath, tracked)
        const { getThread, updateThread } = await import("../db")
        const thread = getThread(threadId)
        if (thread) {
          let metadata: Record<string, unknown> = {}
          try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { metadata = {} }
          metadata.llmModifiedFiles = postState.changedFiles
          metadata.llmFileHistory = historyMap
          updateThread(threadId, { metadata: JSON.stringify(metadata) })
        }

        return { success: true }
      } catch (e) {
        return { success: false, error: getExecErrorText(e) || (e instanceof Error ? e.message : "文件回滚失败") }
      }
    }
  )

  // Read a binary file (images, PDFs, etc.) and return as base64
  ipcMain.handle(
    "workspace:readBinaryFile",
    async (_event, { threadId, filePath }: WorkspaceFileParams) => {
      const { getThread } = await import("../db")

      // Get workspace path from thread metadata
      const thread = getThread(threadId)
      const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
      const workspacePath = metadata.workspacePath as string | null

      if (!workspacePath) {
        return {
          success: false,
          error: "No workspace folder linked"
        }
      }

      try {
        // Convert virtual path to full disk path
        const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath
        const fullPath = path.join(workspacePath, relativePath)

        // Security check: ensure the resolved path is within the workspace
        const resolvedPath = path.resolve(fullPath)
        const resolvedWorkspace = path.resolve(workspacePath)
        if (!resolvedPath.startsWith(resolvedWorkspace)) {
          return { success: false, error: "Access denied: path outside workspace" }
        }

        // Check if file exists
        const stat = await fs.stat(fullPath)
        if (stat.isDirectory()) {
          return { success: false, error: "Cannot read directory as file" }
        }

        // Read file as binary and convert to base64
        const buffer = await fs.readFile(fullPath)
        const base64 = buffer.toString("base64")

        return {
          success: true,
          content: base64,
          size: stat.size,
          modified_at: stat.mtime.toISOString()
        }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "Unknown error"
        }
      }
    }
  )

  // Read a text file from any absolute path (outside workspace allowed)
  ipcMain.handle("workspace:readExternalFile", async (_event, filePath: string) => {
    try {
      const fullPath = path.resolve(filePath)
      const stat = await fs.stat(fullPath)
      if (stat.isDirectory()) {
        return { success: false, error: "Cannot read directory as file" }
      }
      const content = await fs.readFile(fullPath, "utf-8")
      return {
        success: true,
        content,
        size: stat.size,
        modified_at: stat.mtime.toISOString()
      }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Unknown error"
      }
    }
  })

  // Read a binary file from any absolute path (outside workspace allowed)
  ipcMain.handle("workspace:readExternalBinaryFile", async (_event, filePath: string) => {
    try {
      const fullPath = path.resolve(filePath)
      const stat = await fs.stat(fullPath)
      if (stat.isDirectory()) {
        return { success: false, error: "Cannot read directory as file" }
      }
      const buffer = await fs.readFile(fullPath)
      const base64 = buffer.toString("base64")
      return {
        success: true,
        content: base64,
        size: stat.size,
        modified_at: stat.mtime.toISOString()
      }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Unknown error"
      }
    }
  })

  // Parse a file and extract text content for chat attachments
  ipcMain.handle(
    "file:parse",
    async (_event, filePath: string, maxLength?: number): Promise<{
      success: boolean
      attachment?: import("../file-parser").ParsedAttachment
      error?: string
    }> => {
      try {
        const { parseFile, isSupportedFile } = await import("../file-parser")
        if (!isSupportedFile(filePath)) {
          return { success: false, error: "不支持的文件类型，仅支持 txt、md、csv、docx、xlsx、xls" }
        }
        if (typeof maxLength === "number" && maxLength <= 0) {
          return { success: false, error: "附件字符预算已用尽" }
        }
        const attachment = await parseFile(filePath, maxLength)
        return { success: true, attachment }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "文件解析失败"
        }
      }
    }
  )

  // Open native file picker for chat attachments
  ipcMain.handle("file:select", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { canceled: true, filePaths: [] }
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      title: "选择附件",
      filters: [
        { name: "支持的文件", extensions: ["txt", "md", "csv", "docx", "xlsx", "xls"] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePaths: [] }
    }
    return { canceled: false, filePaths: result.filePaths }
  })

  // Get supported file extensions
  ipcMain.handle("file:supportedExtensions", async () => {
    const { getSupportedExtensions } = await import("../file-parser")
    return getSupportedExtensions()
  })
}

export function getDefaultModel(): string {
  const stored = store.get("defaultModel", "") as string
  return stored || resolveDefaultModelId()
}
