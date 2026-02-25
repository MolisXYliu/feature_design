import { homedir } from "os"
import { join } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs"
const OPENWORK_DIR = join(homedir(), ".openwork")
const ENV_FILE = join(OPENWORK_DIR, ".env")

const CUSTOM_API_KEY_ENV = "CUSTOM_API_KEY"

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

// API key management (custom provider only)
export function getApiKey(provider: string): string | undefined {
  if (provider !== "custom") return undefined

  const env = parseEnvFile()
  if (env[CUSTOM_API_KEY_ENV]) return env[CUSTOM_API_KEY_ENV]

  return process.env[CUSTOM_API_KEY_ENV]
}

export function setApiKey(provider: string, apiKey: string): void {
  if (provider !== "custom") return

  const env = parseEnvFile()
  env[CUSTOM_API_KEY_ENV] = apiKey
  writeEnvFile(env)

  process.env[CUSTOM_API_KEY_ENV] = apiKey
}

export function deleteApiKey(provider: string): void {
  if (provider !== "custom") return

  const env = parseEnvFile()
  delete env[CUSTOM_API_KEY_ENV]
  writeEnvFile(env)

  delete process.env[CUSTOM_API_KEY_ENV]
}

export function hasApiKey(provider: string): boolean {
  return !!getApiKey(provider)
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

// Custom model configuration stored as JSON in ~/.openwork/custom-model.json
export interface CustomModelConfig {
  baseUrl: string
  model: string
  apiKey?: string
  maxTokens?: number
}

export const DEFAULT_MAX_TOKENS = 128_000
export const MIN_MAX_TOKENS = 32_000
export const MAX_MAX_TOKENS = 128_000

export interface CustomModelPublicConfig {
  baseUrl: string
  model: string
  hasApiKey: boolean
  maxTokens: number
}

const CUSTOM_MODEL_FILE = join(OPENWORK_DIR, "custom-model.json")

function normalizeMaxTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_TOKENS
  }

  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.floor(value)))
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

export function getCustomModelConfig(): CustomModelConfig | null {
  getOpenworkDir()
  if (!existsSync(CUSTOM_MODEL_FILE)) return null
  try {
    const content = readFileSync(CUSTOM_MODEL_FILE, "utf-8")
    const config = JSON.parse(content) as CustomModelConfig
    if (!config.baseUrl || !config.model) return null

    // Migrate legacy API key from custom-model.json to .env if needed.
    const existingKey = getApiKey("custom")
    if (!existingKey && config.apiKey) {
      setApiKey("custom", config.apiKey)
    }

    return {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: getApiKey("custom"),
      maxTokens: normalizeMaxTokens(config.maxTokens)
    }
  } catch {
    return null
  }
}

export function setCustomModelConfig(config: CustomModelConfig): void {
  getOpenworkDir()
  const validatedMaxTokens = assertValidMaxTokens(config.maxTokens)
  // Keep model metadata in JSON and keep secret in .env only.
  writeFileSync(
    CUSTOM_MODEL_FILE,
    JSON.stringify(
      {
        baseUrl: config.baseUrl,
        model: config.model,
        maxTokens: validatedMaxTokens
      },
      null,
      2
    )
  )

  if (config.apiKey?.trim()) {
    setApiKey("custom", config.apiKey.trim())
  }
}

export function getCustomModelPublicConfig(): CustomModelPublicConfig | null {
  const config = getCustomModelConfig()
  if (!config) return null
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: hasApiKey("custom"),
    maxTokens: normalizeMaxTokens(config.maxTokens)
  }
}

export function deleteCustomModelConfig(): void {
  if (existsSync(CUSTOM_MODEL_FILE)) {
    unlinkSync(CUSTOM_MODEL_FILE)
  }
  deleteApiKey("custom")
}
