import AdmZip from "adm-zip"
import { IpcMain, dialog } from "electron"
import * as fs from "fs/promises"
import * as path from "path"
import { existsSync, mkdirSync, rmSync } from "fs"
import { v4 as uuid } from "uuid"
import {
  getPluginsDir,
  getPlugins,
  upsertPlugin,
  deletePlugin as deletePluginStorage,
  setPluginEnabled,
  invalidateEnabledSkillsCache,
  parseMcpJsonFile
} from "../storage"
import { copyDirRecursive, createAsyncMutex } from "../utils/fs"
import type { PluginManifest, PluginMetadata, PluginMcpServerConfig } from "../types"

interface ParsedPlugin {
  manifest: PluginManifest | null
  skillDirs: string[]
  mcpConfigs: Record<string, PluginMcpServerConfig>
  name: string
}

function sanitizePluginName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9-_.\u4e00-\u9fff]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "plugin"
}

async function parsePluginDir(dirPath: string): Promise<ParsedPlugin> {
  let manifest: PluginManifest | null = null
  const skillDirs: string[] = []
  let mcpConfigs: Record<string, PluginMcpServerConfig> = {}
  let name = path.basename(dirPath)

  // Try reading .claude-plugin/plugin.json
  const manifestPath = path.join(dirPath, ".claude-plugin", "plugin.json")
  if (existsSync(manifestPath)) {
    try {
      const content = await fs.readFile(manifestPath, "utf-8")
      manifest = JSON.parse(content) as PluginManifest
      if (manifest?.name) name = manifest.name
    } catch {
      console.warn("[Plugins] Failed to parse plugin.json at", manifestPath)
    }
  }

  // Also try plugin.json at root level
  if (!manifest) {
    const rootManifestPath = path.join(dirPath, "plugin.json")
    if (existsSync(rootManifestPath)) {
      try {
        const content = await fs.readFile(rootManifestPath, "utf-8")
        manifest = JSON.parse(content) as PluginManifest
        if (manifest?.name) name = manifest.name
      } catch {
        console.warn("[Plugins] Failed to parse plugin.json at", rootManifestPath)
      }
    }
  }

  // Scan skills/ directory
  const skillsDir = path.join(dirPath, "skills")
  if (existsSync(skillsDir)) {
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md")
        if (existsSync(skillMdPath)) {
          skillDirs.push(entry.name)
        }
      }
    } catch {
      console.warn("[Plugins] Failed to scan skills/ in", dirPath)
    }
  }

  // Check for single SKILL.md at root (simple plugin structure)
  if (skillDirs.length === 0) {
    const rootSkillMd = path.join(dirPath, "SKILL.md")
    if (existsSync(rootSkillMd)) {
      skillDirs.push(".")
    }
  }

  // Read .mcp.json
  const mcpJsonPath = path.join(dirPath, ".mcp.json")
  mcpConfigs = parseMcpJsonFile(mcpJsonPath) ?? {}

  return { manifest, skillDirs, mcpConfigs, name }
}

function formatAuthor(author: PluginManifest["author"]): string {
  if (!author) return ""
  if (typeof author === "string") return author
  return author.name || ""
}

async function installPluginFromDir(
  dirPath: string
): Promise<{ success: boolean; pluginName?: string; error?: string }> {
  try {
    const parsed = await parsePluginDir(dirPath)
    if (parsed.skillDirs.length === 0 && Object.keys(parsed.mcpConfigs).length === 0) {
      return { success: false, error: "未检测到有效的 skills 或 MCP 配置" }
    }

    const pluginsDir = getPluginsDir()

    // Check for existing plugin with same name (update scenario)
    const existing = getPlugins().find(
      (p) => p.name === parsed.name
    )

    // Determine unique directory name — avoid collision with other plugins' directories
    let pluginDirName = sanitizePluginName(parsed.name)
    if (!existing) {
      let suffix = 1
      while (existsSync(path.join(pluginsDir, pluginDirName))) {
        suffix++
        pluginDirName = `${sanitizePluginName(parsed.name)}-${suffix}`
      }
    } else {
      // Reuse the existing plugin's directory basename
      pluginDirName = path.basename(existing.path)
    }
    const destDir = path.join(pluginsDir, pluginDirName)

    if (existing) {
      // Update existing: backup old directory, then copy new, restore on failure
      const backupDir = existing.path + `_backup_${Date.now()}`
      if (existsSync(existing.path)) {
        await fs.rename(existing.path, backupDir)
      }
      try {
        await copyDirRecursive(dirPath, destDir)
      } catch (copyErr) {
        // Restore from backup
        if (existsSync(backupDir)) {
          if (existsSync(destDir)) {
            rmSync(destDir, { recursive: true, force: true })
          }
          await fs.rename(backupDir, existing.path)
        }
        throw copyErr
      }
      // Copy succeeded, remove backup
      if (existsSync(backupDir)) {
        rmSync(backupDir, { recursive: true, force: true })
      }
    } else {
      // Fresh install
      await copyDirRecursive(dirPath, destDir)
    }

    const now = new Date().toISOString()
    const meta: PluginMetadata = {
      id: existing?.id ?? uuid(),
      name: parsed.name,
      version: parsed.manifest?.version ?? "1.0.0",
      description: parsed.manifest?.description ?? "",
      author: formatAuthor(parsed.manifest?.author),
      path: destDir,
      enabled: true,
      skillCount: parsed.skillDirs.length,
      mcpServerCount: Object.keys(parsed.mcpConfigs).length,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    upsertPlugin(meta)
    invalidateEnabledSkillsCache()

    return { success: true, pluginName: parsed.name }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "安装失败" }
  }
}

const MAX_EXTRACTED_SIZE = 50 * 1024 * 1024 // 50 MB

async function installPluginFromZip(
  buffer: ArrayBuffer
): Promise<{ success: boolean; pluginName?: string; error?: string }> {
  try {
    const zip = new AdmZip(Buffer.from(buffer))
    const entries = zip.getEntries()

    // Check total uncompressed size before extracting
    let totalSize = 0
    for (const entry of entries) {
      if (!entry.isDirectory) {
        totalSize += entry.header.size
        if (totalSize > MAX_EXTRACTED_SIZE) {
          return { success: false, error: `ZIP 解压后大小超过 ${MAX_EXTRACTED_SIZE / 1024 / 1024}MB 限制` }
        }
      }
    }

    // Determine root prefix — the zip may have a single root directory
    let rootPrefix = ""
    const firstEntry = entries.find((e) => !e.isDirectory)
    if (firstEntry) {
      const parts = firstEntry.entryName.split("/")
      if (parts.length > 1) {
        // Check if all entries share the same root directory
        const candidate = parts[0] + "/"
        const allMatch = entries.every(
          (e) => e.entryName.startsWith(candidate) || e.entryName === candidate.slice(0, -1)
        )
        if (allMatch) rootPrefix = candidate
      }
    }

    // Extract to temp directory
    const pluginsDir = getPluginsDir()
    const tempName = `_temp_${Date.now()}`
    const tempDir = path.join(pluginsDir, tempName)
    mkdirSync(tempDir, { recursive: true })

    try {
      for (const entry of entries) {
        if (entry.isDirectory) continue
        let relativePath = entry.entryName
        if (rootPrefix && relativePath.startsWith(rootPrefix)) {
          relativePath = relativePath.slice(rootPrefix.length)
        }
        if (!relativePath) continue

        const destPath = path.resolve(tempDir, relativePath)
        // Path traversal check — normalize both sides so separator style is consistent
        const normalDest = path.normalize(destPath)
        const normalBase = path.normalize(path.resolve(tempDir))
        if (!normalDest.startsWith(normalBase + path.sep) && normalDest !== normalBase) {
          throw new Error(`ZIP 包含路径穿越条目: ${entry.entryName}`)
        }
        const destDirPath = path.dirname(destPath)
        mkdirSync(destDirPath, { recursive: true })
        await fs.writeFile(destPath, entry.getData())
      }

      // Parse and install
      const result = await installPluginFromDir(tempDir)

      // Clean up temp directory (the real copy is at destDir)
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }

      return result
    } catch (e) {
      // Clean up temp on error
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
      throw e
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "解压失败" }
  }
}

export function registerPluginHandlers(ipcMain: IpcMain): void {
  console.log("[Plugins] Registering plugin handlers...")
  const pluginMutex = createAsyncMutex()

  ipcMain.handle("plugins:list", async (): Promise<PluginMetadata[]> => {
    return getPlugins()
  })

  ipcMain.handle(
    "plugins:install",
    async (
      _event,
      payload: { buffer: ArrayBuffer; fileName: string }
    ): Promise<{ success: boolean; pluginName?: string; error?: string }> => {
      const { buffer, fileName } = payload
      if (!buffer || !fileName) {
        return { success: false, error: "无效的文件" }
      }
      await pluginMutex.acquire()
      try {
      return await installPluginFromZip(buffer)
      } finally {
        pluginMutex.release()
      }
    }
  )

  ipcMain.handle(
    "plugins:installFromDir",
    async (): Promise<{ success: boolean; pluginName?: string; error?: string }> => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "选择 Plugin 目录"
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: "已取消" }
      }
      await pluginMutex.acquire()
      try {
        return await installPluginFromDir(result.filePaths[0])
      } finally {
        pluginMutex.release()
      }
    }
  )

  ipcMain.handle(
    "plugins:delete",
    async (_event, id: string): Promise<{ success: boolean; error?: string }> => {
      if (!id || typeof id !== "string") {
        return { success: false, error: "无效的 Plugin ID" }
      }
      await pluginMutex.acquire()
      try {
        const plugins = getPlugins()
        const plugin = plugins.find((p) => p.id === id)
        if (!plugin) {
          return { success: false, error: "Plugin 不存在" }
        }
        try {
          if (existsSync(plugin.path)) {
            rmSync(plugin.path, { recursive: true, force: true })
          }
          deletePluginStorage(id)
          invalidateEnabledSkillsCache()
          return { success: true }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : "删除失败" }
        }
      } finally {
        pluginMutex.release()
      }
    }
  )

  ipcMain.handle(
    "plugins:setEnabled",
    async (_event, payload: { id: string; enabled: boolean }): Promise<void> => {
      await pluginMutex.acquire()
      try {
        const { id, enabled } = payload
        setPluginEnabled(id, enabled)
        invalidateEnabledSkillsCache()
      } finally {
        pluginMutex.release()
      }
    }
  )

  ipcMain.handle(
    "plugins:getDetail",
    async (
      _event,
      id: string
    ): Promise<{
      skills: string[]
      mcpServers: string[]
      manifest: PluginManifest | null
    }> => {
      const plugins = getPlugins()
      const plugin = plugins.find((p) => p.id === id)
      if (!plugin || !existsSync(plugin.path)) {
        return { skills: [], mcpServers: [], manifest: null }
      }
      const parsed = await parsePluginDir(plugin.path)
      return {
        skills: parsed.skillDirs,
        mcpServers: Object.keys(parsed.mcpConfigs),
        manifest: parsed.manifest
      }
    }
  )
}
