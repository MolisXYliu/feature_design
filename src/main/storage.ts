import { homedir } from "os"
import { join } from "path"
import { createHash } from "crypto"
import { v4 as uuid } from "uuid"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "fs"
import { readdir, readFile, rm, mkdir, copyFile, stat, chmod } from "fs/promises"
import { app } from "electron"
const OPENWORK_DIR = join(homedir(), ".cmbcoworkagent")
const ENV_FILE = join(OPENWORK_DIR, ".env")

const CUSTOM_API_KEY_PREFIX = "CUSTOM_API_KEY__"

export function getOpenworkDir(): string {
  if (!existsSync(OPENWORK_DIR)) {
    mkdirSync(OPENWORK_DIR, { recursive: true })
  }
  return OPENWORK_DIR
}

export function getDbPath(): string {
  return join(getOpenworkDir(), "cmbcoworkagent.sqlite")
}

export function getCheckpointDbPath(): string {
  return join(getOpenworkDir(), "langgraph.sqlite")
}

export function getThreadCheckpointDir(): string {
  const dir = join(getOpenworkDir(), "threads")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getThreadCheckpointPath(threadId: string): string {
  return join(getThreadCheckpointDir(), `${threadId}.sqlite`)
}

export function deleteThreadCheckpoint(threadId: string): void {
  const path = getThreadCheckpointPath(threadId)
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

export function getEnvFilePath(): string {
  return ENV_FILE
}

// Read .env file and parse into object
function parseEnvFile(): Record<string, string> {
  const envPath = getEnvFilePath()
  if (!existsSync(envPath)) return {}

  const content = readFileSync(envPath, "utf-8")
  const result: Record<string, string> = {}

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIndex = trimmed.indexOf("=")
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed.slice(eqIndex + 1).trim()
      result[key] = value
    }
  }
  return result
}

// Write object back to .env file
function writeEnvFile(env: Record<string, string>): void {
  getOpenworkDir() // ensure dir exists
  const lines = Object.entries(env)
    .filter((entry) => entry[1])
    .map(([k, v]) => `${k}=${v}`)
  writeFileSync(getEnvFilePath(), lines.join("\n") + "\n")
}

// Skills directory — bundled with the app at project root /skills/
export function getSkillsDir(): string {

  // 1) Packaged: skills 在 app.asar 的 /out/skills（你已经验证过）
  if (app?.isPackaged) {
    // app.getAppPath() => .../Contents/Resources/app.asar
    const asarOutSkills = join(app.getAppPath(), "out", "skills");
    if (existsSync(asarOutSkills)) return asarOutSkills;

    // 有些打包方式会把 out 放在 Resources 目录下（非 asar）
    const resourcesOutSkills = join(process.resourcesPath, "out", "skills");
    if (existsSync(resourcesOutSkills)) return resourcesOutSkills;

    // 如果你未来改成 extraResources: Resources/skills
    const resourcesSkills = join(process.resourcesPath, "skills");
    if (existsSync(resourcesSkills)) return resourcesSkills;
  }

  // Prefer workspace root /skills in development (cwd is project root in electron-vite dev).
  const workspaceSkillsDir = join(process.cwd(), "skills")
  if (existsSync(workspaceSkillsDir)) return workspaceSkillsDir

  // Fallbacks for packaged/bundled layouts.
  const bundledDir = join(__dirname, "..", "..", "skills")
  if (existsSync(bundledDir)) return bundledDir

  const resourcesDir = join(__dirname, "..", "..", "..", "skills")
  if (existsSync(resourcesDir)) return resourcesDir

  return workspaceSkillsDir
}

const CUSTOM_SKILLS_DIR = join(OPENWORK_DIR, "skills")

export function getCustomSkillsDir(): string {
  getOpenworkDir()
  return CUSTOM_SKILLS_DIR
}

export function getSkillsSources(): string[] {
  const builtin = getSkillsDir()
  const custom = getCustomSkillsDir()
  const sources: string[] = []
  if (existsSync(builtin)) sources.push(builtin)
  if (existsSync(custom)) sources.push(custom)
  return sources
}

const DISABLED_SKILLS_FILE = join(OPENWORK_DIR, "disabled-skills.json")

export function getDisabledSkills(): string[] {
  getOpenworkDir()
  if (!existsSync(DISABLED_SKILLS_FILE)) return []
  try {
    const content = readFileSync(DISABLED_SKILLS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : []
  } catch {
    return []
  }
}

export function setDisabledSkills(skillNames: string[]): void {
  getOpenworkDir()
  writeFileSync(DISABLED_SKILLS_FILE, JSON.stringify(skillNames, null, 2))
  invalidateEnabledSkillsCache()
}

function parseSkillNameFromFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0 && line.slice(0, colonIdx).trim().toLowerCase() === "name") {
      return line.slice(colonIdx + 1).trim()
    }
  }
  return null
}

const ENABLED_SKILLS_DIR = join(OPENWORK_DIR, "enabled-skills")

// Fingerprint of the last successful enabled-skills rebuild
let _enabledSkillsFingerprint: string | null = null

function computeEnabledSkillsFingerprint(disabledList: string[], sourceDirs: string[]): string {
  const parts = [disabledList.sort().join(","), sourceDirs.join("|")]
  for (const dir of sourceDirs) {
    if (!existsSync(dir)) continue
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      const dirNames: string[] = []
      for (const e of entries) {
        if (!e.isDirectory()) continue
        dirNames.push(e.name)
        const skillMdPath = join(dir, e.name, "SKILL.md")
        try {
          const st = statSync(skillMdPath)
          dirNames.push(String(st.mtimeMs))
        } catch { /* no SKILL.md or unreadable */ }
      }
      parts.push(dirNames.sort().join(","))
    } catch { /* ignore */ }
  }
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 16)
}

/**
 * Recursively copy a directory tree from src to dest.
 * Uses copyFile + mkdir instead of fs.promises.cp (experimental in Node < 22).
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
      // Preserve executable permission bits (e.g. .py / .sh scripts in skills)
      // chmod is a no-op on Windows but harmless
      try {
        const srcStat = await stat(srcPath)
        await chmod(destPath, srcStat.mode)
      } catch { /* ignore permission errors on restricted filesystems */ }
    }
  }
}

async function copyEnabledSkillsFromSourceAsync(sourceDir: string, disabled: Set<string>): Promise<number> {
  let count = 0
  const entries = await readdir(sourceDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillMdPath = join(sourceDir, entry.name, "SKILL.md")
    if (!existsSync(skillMdPath)) continue

    try {
      const content = await readFile(skillMdPath, "utf-8")
      const name = parseSkillNameFromFrontmatter(content) || entry.name
      if (disabled.has(name.trim().toLowerCase())) continue
    } catch {
      continue
    }

    const srcSkillDir = join(sourceDir, entry.name)
    const destPath = join(ENABLED_SKILLS_DIR, entry.name)
    try {
      await copyDirRecursive(srcSkillDir, destPath)
      count++
    } catch (e) {
      console.warn(`[Storage] Failed to copy skill ${entry.name}:`, e)
      // Clean up partial directory so it doesn't look like a valid skill
      try { await rm(destPath, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
  return count
}

let _enabledSkillsBuildLock: Promise<string> | null = null

/**
 * Ensures ~/.cmbcoworkagent/enabled-skills/ exists with copies of enabled skills only.
 * Uses async I/O to avoid blocking the main process event loop.
 * Skips rebuild if the disabled list and source dirs haven't changed.
 * Serialized via a Promise lock to prevent concurrent rm/mkdir/copyFile races.
 */
async function ensureEnabledSkillsDirAsync(): Promise<string> {
  if (_enabledSkillsBuildLock) return _enabledSkillsBuildLock
  _enabledSkillsBuildLock = _ensureEnabledSkillsDirImpl()
  try {
    return await _enabledSkillsBuildLock
  } finally {
    _enabledSkillsBuildLock = null
  }
}

async function _ensureEnabledSkillsDirImpl(): Promise<string> {
  getOpenworkDir()
  const builtinDir = getSkillsDir()
  const customDir = getCustomSkillsDir()
  const disabled = getDisabledSkills()
  const sourceDirs = [builtinDir, customDir]

  const fingerprint = computeEnabledSkillsFingerprint(disabled, sourceDirs)
  if (_enabledSkillsFingerprint === fingerprint && existsSync(ENABLED_SKILLS_DIR)) {
    return ENABLED_SKILLS_DIR
  }

  if (existsSync(ENABLED_SKILLS_DIR)) {
    await rm(ENABLED_SKILLS_DIR, { recursive: true })
  }
  await mkdir(ENABLED_SKILLS_DIR, { recursive: true })

  const disabledSet = new Set(disabled.map((s) => s.trim().toLowerCase()))
  let total = 0
  if (existsSync(builtinDir)) total += await copyEnabledSkillsFromSourceAsync(builtinDir, disabledSet)
  if (existsSync(customDir)) total += await copyEnabledSkillsFromSourceAsync(customDir, disabledSet)

  _enabledSkillsFingerprint = fingerprint
  return ENABLED_SKILLS_DIR
}

/**
 * Invalidate the enabled-skills cache so the next call rebuilds.
 * Should be called when disabled skills list changes.
 */
export function invalidateEnabledSkillsCache(): void {
  _enabledSkillsFingerprint = null
}

/**
 * Returns skills sources for the agent: either the filtered enabled-skills dir
 * or the full skills dirs if no skills are disabled.
 */
export async function getEnabledSkillsSources(): Promise<string[]> {
  const disabled = getDisabledSkills()
  if (disabled.length === 0) return getSkillsSources()

  await ensureEnabledSkillsDirAsync()
  try {
    const entries = await readdir(ENABLED_SKILLS_DIR)
    if (entries.length > 0) return [ENABLED_SKILLS_DIR]
  } catch { /* fall through */ }

  console.warn("[Storage] No enabled skills copied; using all skills")
  return getSkillsSources()
}

// Custom model configurations stored as JSON in ~/.cmbcoworkagent/custom-models.json
export interface CustomModelConfig {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  maxTokens?: number
}

export const DEFAULT_MAX_TOKENS = 128_000
export const MIN_MAX_TOKENS = 32_000
export const MAX_MAX_TOKENS = 128_000

export interface CustomModelPublicConfig {
  id: string
  name: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  maxTokens: number
}

interface StoredCustomModelRecord {
  id: string
  name: string
  baseUrl: string
  model: string
  maxTokens?: number
}

const CUSTOM_MODEL_FILE = join(OPENWORK_DIR, "custom-model.json")
const CUSTOM_MODELS_FILE = join(OPENWORK_DIR, "custom-models.json")

function normalizeMaxTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_TOKENS
  }

  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.floor(value)))
}

function getCustomApiKeyEnvName(id: string): string {
  const hash = createHash("sha256").update(id.trim()).digest("hex").slice(0, 12)
  return `${CUSTOM_API_KEY_PREFIX}${hash}`
}

function getCustomModelApiKey(id: string, env?: Record<string, string>): string | undefined {
  const resolved = env ?? parseEnvFile()
  const keyName = getCustomApiKeyEnvName(id)
  if (resolved[keyName]) return resolved[keyName]
  return process.env[keyName]
}

function setCustomModelApiKey(id: string, apiKey: string): void {
  const keyName = getCustomApiKeyEnvName(id)
  const env = parseEnvFile()
  env[keyName] = apiKey
  writeEnvFile(env)
  process.env[keyName] = apiKey
}

function deleteCustomModelApiKey(id: string): void {
  const keyName = getCustomApiKeyEnvName(id)
  const env = parseEnvFile()
  delete env[keyName]
  writeEnvFile(env)
  delete process.env[keyName]
}

function deleteAllCustomModelApiKeys(): void {
  const env = parseEnvFile()
  for (const key of Object.keys(env)) {
    if (key.startsWith(CUSTOM_API_KEY_PREFIX)) {
      delete env[key]
    }
  }
  writeEnvFile(env)
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(CUSTOM_API_KEY_PREFIX)) {
      delete process.env[key]
    }
  }
}

function assertValidMaxTokens(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_TOKENS
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`maxTokens 必须是数字，范围为 ${MIN_MAX_TOKENS} 到 ${MAX_MAX_TOKENS}`)
  }

  const parsed = Math.floor(value)
  if (parsed < MIN_MAX_TOKENS || parsed > MAX_MAX_TOKENS) {
    throw new Error(`maxTokens 超出范围，必须在 ${MIN_MAX_TOKENS} 到 ${MAX_MAX_TOKENS} 之间`)
  }

  return parsed
}

function assertValidBaseUrl(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error("接口地址不能为空")
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error("接口地址格式无效，请输入完整 URL（例如 https://api.example.com/v1）")
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("接口地址必须以 http:// 或 https:// 开头")
  }

  return normalized
}

export function getCustomModelConfig(): CustomModelConfig | null {
  const configs = getCustomModelConfigs()
  return configs[0] ?? null
}

function readCustomModelsRaw(): StoredCustomModelRecord[] {
  getOpenworkDir()
  if (!existsSync(CUSTOM_MODELS_FILE)) return []
  try {
    const content = readFileSync(CUSTOM_MODELS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is StoredCustomModelRecord =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { baseUrl?: unknown }).baseUrl === "string" &&
        typeof (item as { model?: unknown }).model === "string"
    )
  } catch {
    return []
  }
}

function writeCustomModelsRaw(items: StoredCustomModelRecord[]): void {
  writeFileSync(CUSTOM_MODELS_FILE, JSON.stringify(items, null, 2))
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

let _legacyMigrated = false
function migrateLegacyCustomModel(): void {
  if (_legacyMigrated) return
  _legacyMigrated = true

  getOpenworkDir()
  if (existsSync(CUSTOM_MODELS_FILE) || !existsSync(CUSTOM_MODEL_FILE)) return

  try {
    const content = readFileSync(CUSTOM_MODEL_FILE, "utf-8")
    const legacy = JSON.parse(content) as {
      baseUrl?: string
      model?: string
      maxTokens?: number
    }
    if (!legacy.baseUrl || !legacy.model) return

    const baseId = slugify(`${legacy.model}-${legacy.baseUrl}`) || "custom-model"
    const migrated: StoredCustomModelRecord = {
      id: baseId,
      name: legacy.model,
      baseUrl: legacy.baseUrl,
      model: legacy.model,
      maxTokens: normalizeMaxTokens(legacy.maxTokens)
    }
    writeCustomModelsRaw([migrated])

  } catch {
    // Ignore migration failures and keep legacy behavior.
  }
}

function toPublicConfig(config: StoredCustomModelRecord, env?: Record<string, string>): CustomModelPublicConfig {
  return {
    id: config.id,
    name: config.name || config.model,
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: !!getCustomModelApiKey(config.id, env),
    maxTokens: normalizeMaxTokens(config.maxTokens)
  }
}

export function getCustomModelConfigs(): CustomModelConfig[] {
  migrateLegacyCustomModel()
  const env = parseEnvFile()
  return readCustomModelsRaw().map((item) => ({
    id: item.id,
    name: item.name || item.model,
    baseUrl: item.baseUrl,
    model: item.model,
    apiKey: getCustomModelApiKey(item.id, env),
    maxTokens: normalizeMaxTokens(item.maxTokens)
  }))
}

export function getCustomModelConfigById(id: string): CustomModelConfig | null {
  migrateLegacyCustomModel()
  const record = readCustomModelsRaw().find((item) => item.id === id)
  if (!record) return null
  return {
    id: record.id,
    name: record.name || record.model,
    baseUrl: record.baseUrl,
    model: record.model,
    apiKey: getCustomModelApiKey(record.id),
    maxTokens: normalizeMaxTokens(record.maxTokens)
  }
}

export function upsertCustomModelConfig(
  config: Omit<CustomModelConfig, "id"> & { id?: string }
): string {
  getOpenworkDir()
  migrateLegacyCustomModel()

  const validatedMaxTokens = assertValidMaxTokens(config.maxTokens)
  const validatedBaseUrl = assertValidBaseUrl(config.baseUrl)
  const normalizedName = config.name.trim()
  const normalizedModel = config.model.trim()
  if (!normalizedName) {
    throw new Error("显示名称不能为空")
  }
  if (!normalizedModel) {
    throw new Error("模型名称不能为空")
  }
  const items = readCustomModelsRaw()
  let targetId: string

  if (config.id) {
    targetId = config.id
  } else {
    const baseId = slugify(normalizedName || normalizedModel || "custom-model") || "custom-model"
    targetId = baseId
    let suffix = 1
    while (items.some((item) => item.id === targetId)) {
      suffix += 1
      targetId = `${baseId}-${suffix}`
    }
  }

  const duplicate = items.find((item) => item.name === normalizedName && item.id !== targetId)
  if (duplicate) {
    throw new Error("显示名称不能重复，请使用不同的显示名称")
  }

  const nextRecord: StoredCustomModelRecord = {
    id: targetId,
    name: normalizedName,
    baseUrl: validatedBaseUrl,
    model: normalizedModel,
    maxTokens: validatedMaxTokens
  }

  const index = items.findIndex((item) => item.id === targetId)
  if (index >= 0) {
    items[index] = nextRecord
  } else {
    items.push(nextRecord)
  }

  writeCustomModelsRaw(items)

  if (config.apiKey?.trim()) {
    setCustomModelApiKey(targetId, config.apiKey.trim())
  }

  return targetId
}

export function getCustomModelPublicConfig(): CustomModelPublicConfig | null {
  const configs = getCustomModelPublicConfigs()
  return configs[0] ?? null
}

export function getCustomModelPublicConfigById(id: string): CustomModelPublicConfig | null {
  migrateLegacyCustomModel()
  const target = readCustomModelsRaw().find((item) => item.id === id)
  return target ? toPublicConfig(target) : null
}

export function getCustomModelPublicConfigs(): CustomModelPublicConfig[] {
  migrateLegacyCustomModel()
  const env = parseEnvFile()
  return readCustomModelsRaw().map((item) => toPublicConfig(item, env))
}

export function setCustomModelConfig(config: CustomModelConfig): void {
  upsertCustomModelConfig(config)
}

export function deleteCustomModelConfig(id: string): void {
  migrateLegacyCustomModel()

  const items = readCustomModelsRaw()
  const existed = items.some((item) => item.id === id)
  const next = items.filter((item) => item.id !== id)
  writeCustomModelsRaw(next)
  if (existed) {
    deleteCustomModelApiKey(id)
  }
}

export function deleteAllCustomModelConfigs(): void {
  migrateLegacyCustomModel()
  if (existsSync(CUSTOM_MODELS_FILE)) {
    unlinkSync(CUSTOM_MODELS_FILE)
  }
  if (existsSync(CUSTOM_MODEL_FILE)) {
    unlinkSync(CUSTOM_MODEL_FILE)
  }
  deleteAllCustomModelApiKeys()
}

// MCP Connectors
const MCP_CONNECTORS_FILE = join(OPENWORK_DIR, "mcp-connectors.json")

export function getMcpConnectorsPath(): string {
  getOpenworkDir()
  return MCP_CONNECTORS_FILE
}

export function getMcpConnectors(): import("./types").McpConnectorConfig[] {
  getOpenworkDir()
  if (!existsSync(MCP_CONNECTORS_FILE)) return []
  try {
    const content = readFileSync(MCP_CONNECTORS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is import("./types").McpConnectorConfig =>
        item != null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).url === "string"
    )
  } catch {
    return []
  }
}

export function getEnabledMcpConnectors(): import("./types").McpConnectorConfig[] {
  return getMcpConnectors().filter((c) => c.enabled)
}

export function upsertMcpConnector(
  config: import("./types").McpConnectorUpsert & { id?: string }
): string {
  getOpenworkDir()
  const items = getMcpConnectors()
  const now = new Date().toISOString()
  const id = config.id ?? uuid()
  const existing = items.find((i) => i.id === id)
  const next: import("./types").McpConnectorConfig = {
    id,
    name: config.name.trim(),
    url: config.url.trim(),
    enabled: config.enabled ?? true,
    advanced: config.advanced,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  const index = items.findIndex((i) => i.id === id)
  if (index >= 0) {
    items[index] = next
  } else {
    items.push(next)
  }
  writeFileSync(MCP_CONNECTORS_FILE, JSON.stringify(items, null, 2))
  return id
}

export function deleteMcpConnector(id: string): void {
  getOpenworkDir()
  const items = getMcpConnectors().filter((i) => i.id !== id)
  writeFileSync(MCP_CONNECTORS_FILE, JSON.stringify(items, null, 2))
}

export function setMcpConnectorEnabled(id: string, enabled: boolean): void {
  getOpenworkDir()
  const items = getMcpConnectors()
  const target = items.find((i) => i.id === id)
  if (!target) return
  const next = items.map((i) => (i.id === id ? { ...i, enabled, updatedAt: new Date().toISOString() } : i))
  writeFileSync(MCP_CONNECTORS_FILE, JSON.stringify(next, null, 2))
}
