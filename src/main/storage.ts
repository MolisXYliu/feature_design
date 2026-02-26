import { homedir } from "os"
import { join } from "path"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs"
const OPENWORK_DIR = join(homedir(), ".openwork")
const ENV_FILE = join(OPENWORK_DIR, ".env")

const CUSTOM_API_KEY_PREFIX = "CUSTOM_API_KEY__"

export function getOpenworkDir(): string {
  if (!existsSync(OPENWORK_DIR)) {
    mkdirSync(OPENWORK_DIR, { recursive: true })
  }
  return OPENWORK_DIR
}

export function getDbPath(): string {
  return join(getOpenworkDir(), "openwork.sqlite")
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

export function getSkillsSources(): string[] {
  const dir = getSkillsDir()
  return existsSync(dir) ? [dir] : []
}

// Custom model configurations stored as JSON in ~/.openwork/custom-models.json
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
