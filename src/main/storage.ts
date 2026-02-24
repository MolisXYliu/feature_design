import { homedir } from "os"
import { join } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import type { ProviderId } from "./types"

const OPENWORK_DIR = join(homedir(), ".openwork")
const ENV_FILE = join(OPENWORK_DIR, ".env")

// Environment variable names for each provider
const ENV_VAR_NAMES: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  ollama: "",
  custom: "CUSTOM_API_KEY"
}

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

// API key management
export function getApiKey(provider: string): string | undefined {
  const envVarName = ENV_VAR_NAMES[provider]
  if (!envVarName) return undefined

  // Check .env file first
  const env = parseEnvFile()
  if (env[envVarName]) return env[envVarName]

  // Fall back to process environment
  return process.env[envVarName]
}

export function setApiKey(provider: string, apiKey: string): void {
  const envVarName = ENV_VAR_NAMES[provider]
  if (!envVarName) return

  const env = parseEnvFile()
  env[envVarName] = apiKey
  writeEnvFile(env)

  // Also set in process.env for current session
  process.env[envVarName] = apiKey
}

export function deleteApiKey(provider: string): void {
  const envVarName = ENV_VAR_NAMES[provider]
  if (!envVarName) return

  const env = parseEnvFile()
  delete env[envVarName]
  writeEnvFile(env)

  // Also clear from process.env
  delete process.env[envVarName]
}

export function hasApiKey(provider: string): boolean {
  return !!getApiKey(provider)
}

// Skills directory — bundled with the app at project root /skills/
export function getSkillsDir(): string {
  // In dev: project root /skills/
  // In production: {app resources}/skills/ (copied by build)
  const devDir = join(__dirname, "..", "..", "skills")
  if (existsSync(devDir)) return devDir

  const prodDir = join(__dirname, "..", "..", "..", "skills")
  if (existsSync(prodDir)) return prodDir

  return devDir
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
}

export interface CustomModelPublicConfig {
  baseUrl: string
  model: string
  hasApiKey: boolean
}

const CUSTOM_MODEL_FILE = join(OPENWORK_DIR, "custom-model.json")

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
      apiKey: getApiKey("custom")
    }
  } catch {
    return null
  }
}

export function setCustomModelConfig(config: CustomModelConfig): void {
  getOpenworkDir()
  // Keep model metadata in JSON and keep secret in .env only.
  writeFileSync(
    CUSTOM_MODEL_FILE,
    JSON.stringify(
      {
        baseUrl: config.baseUrl,
        model: config.model
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
    hasApiKey: hasApiKey("custom")
  }
}

export function deleteCustomModelConfig(): void {
  if (existsSync(CUSTOM_MODEL_FILE)) {
    unlinkSync(CUSTOM_MODEL_FILE)
  }
  deleteApiKey("custom")
}
