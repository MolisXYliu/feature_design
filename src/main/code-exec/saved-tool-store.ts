import { createHash } from "crypto"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { getOpenworkDir } from "../storage"
import type { McpToolSearchMode } from "../mcp/tool-catalog"

const SAVED_CODE_EXEC_TOOLS_VERSION = 1
const SAVED_TOOL_PREFIX = "saved__"
const DEFAULT_TIMEOUT_MS = 20_000

const MAX_STRING_LENGTH = 32
const MAX_ARRAY_ITEMS = 2
const MAX_OBJECT_KEYS = 12
const MAX_DEPTH = 4

const OMITTED_BASE64 = "<base64 omitted>"
const OMITTED_BLOB = "<blob omitted>"
const OMITTED_FILE_TEXT = "<file text omitted>"

export interface SavedCodeExecTool {
  toolId: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  code: string
  timeoutMs: number
  createdAt: string
  updatedAt: string
  codeHash: string
  dependencies: string[]
  resultExample?: unknown
}

export interface SavedCodeExecToolDraft {
  toolId: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  code: string
  timeoutMs: number
  codeHash: string
  dependencies: string[]
  resultExample?: unknown
}

interface SavedCodeExecToolsFile {
  version: number
  entries: SavedCodeExecTool[]
}

interface SavedCodeExecToolIdOptions {
  toolName: string
  codeHash: string
}

function getSavedCodeExecToolsPath(): string {
  return join(getOpenworkDir(), "code-exec-tools.json")
}

function createEmptyStore(): SavedCodeExecToolsFile {
  return {
    version: SAVED_CODE_EXEC_TOOLS_VERSION,
    entries: []
  }
}

let storeCache: SavedCodeExecToolsFile | null = null

function loadStore(): SavedCodeExecToolsFile {
  if (storeCache) return storeCache

  const path = getSavedCodeExecToolsPath()
  if (!existsSync(path)) {
    storeCache = createEmptyStore()
    return storeCache
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === SAVED_CODE_EXEC_TOOLS_VERSION &&
      Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      storeCache = {
        version: SAVED_CODE_EXEC_TOOLS_VERSION,
        entries: ((parsed as { entries: SavedCodeExecTool[] }).entries ?? []).filter((entry) => {
          return Boolean(entry && typeof entry === "object" && typeof entry.toolId === "string")
        })
      }
      return storeCache
    }
  } catch (error) {
    console.warn("[code_exec] failed to read saved tools:", error)
  }

  storeCache = createEmptyStore()
  return storeCache
}

function saveStore(store: SavedCodeExecToolsFile): void {
  store.version = SAVED_CODE_EXEC_TOOLS_VERSION
  writeFileSync(getSavedCodeExecToolsPath(), `${JSON.stringify(store, null, 2)}\n`)
}

export function computeSavedCodeExecToolHash(code: string, timeoutMs?: number): string {
  return createHash("sha256")
    .update(JSON.stringify({
      code,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS
    }))
    .digest("hex")
}

function splitIntoTokens(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()

  return normalized
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function ensureIdentifier(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_]/g, "")
  const base = cleaned || fallback
  return /^[0-9]/.test(base) ? `_${base}` : base
}

function toSnakeCase(value: string, fallback: string): string {
  const tokens = splitIntoTokens(value)
  if (tokens.length === 0) return fallback
  return ensureIdentifier(tokens.map((part) => part.toLowerCase()).join("_"), fallback)
}

function looksLikeBase64(value: string): boolean {
  if (value.length < 128 || value.length % 4 !== 0) return false
  return /^[A-Za-z0-9+/=\s]+$/.test(value)
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value
  return `${value.slice(0, MAX_STRING_LENGTH)}...(${value.length} chars)`
}

function sanitizeString(value: string, key?: string, parentType?: string): string {
  const normalizedKey = key?.toLowerCase()

  if (normalizedKey === "blob") return OMITTED_BLOB
  if (normalizedKey === "data" && looksLikeBase64(value)) return OMITTED_BASE64
  if (normalizedKey === "text" && (parentType === "resource" || parentType === "file")) {
    return OMITTED_FILE_TEXT
  }
  if (looksLikeBase64(value)) return OMITTED_BASE64

  return truncateString(value)
}

function sanitizeValue(
  value: unknown,
  context: {
    depth: number
    key?: string
    parentType?: string
  }
): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value
  }

  if (typeof value === "string") {
    return sanitizeString(value, context.key, context.parentType)
  }

  if (context.depth >= MAX_DEPTH) {
    return Array.isArray(value)
      ? `<array truncated at depth ${MAX_DEPTH}>`
      : `<object truncated at depth ${MAX_DEPTH}>`
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, { depth: context.depth + 1, parentType: context.parentType }))

    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`<${value.length - MAX_ARRAY_ITEMS} more items>`)
    }

    return items
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const parentType = typeof record.type === "string" ? record.type : context.parentType
    const keys = Object.keys(record)
    const entries = keys
      .slice(0, MAX_OBJECT_KEYS)
      .map((key) => [
        key,
        sanitizeValue(record[key], { depth: context.depth + 1, key, parentType })
      ] as const)

    if (keys.length > MAX_OBJECT_KEYS) {
      entries.push(["__truncated_keys__", `<${keys.length - MAX_OBJECT_KEYS} more keys>`])
    }

    return Object.fromEntries(entries)
  }

  return String(value)
}

function inferSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth >= MAX_DEPTH) {
    return {}
  }

  if (value === null) {
    return { type: "null" }
  }

  switch (typeof value) {
    case "string":
      return { type: "string" }
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number" }
    case "boolean":
      return { type: "boolean" }
    case "object":
      break
    default:
      return {}
  }

  if (Array.isArray(value)) {
    const firstDefined = value.find((item) => item !== undefined)
    return firstDefined === undefined
      ? { type: "array" }
      : { type: "array", items: inferSchema(firstDefined, depth + 1) }
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((key) => [key, inferSchema(record[key], depth + 1)])),
    ...(keys.length > 0 ? { required: keys } : {})
  }
}

export function inferSavedCodeExecSchema(value: unknown): Record<string, unknown> {
  return inferSchema(value)
}

export function parseCodeExecDependencies(code: string): string[] {
  const matches = new Set<string>()
  const pattern = /mcp\.([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(code)) !== null) {
    matches.add(`${match[1]}.${match[2]}`)
  }

  return Array.from(matches)
}

function ensureUniqueToolId(baseSlug: string, store: SavedCodeExecToolsFile, codeHash: string): string {
  const existingByHash = store.entries.find((entry) => entry.codeHash === codeHash)
  if (existingByHash) return existingByHash.toolId

  const base = `${SAVED_TOOL_PREFIX}${ensureIdentifier(baseSlug, "workflow")}`
  let candidate = base
  let suffix = 2

  while (store.entries.some((entry) => entry.toolId === candidate)) {
    candidate = `${base}_${suffix}`
    suffix += 1
  }

  return candidate
}

function scoreKeyword(text: string, query: string, toolId: string): number {
  const textLower = text.toLowerCase()
  const queryLower = query.toLowerCase().trim()
  if (!queryLower) return 0

  if (toolId.toLowerCase() === queryLower) return 100
  if (toolId.toLowerCase().includes(queryLower)) return 80
  if (textLower.includes(queryLower)) return 40
  return 0
}

function tokenizeForSearch(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .split(/[\s.,;:!?()[\]{}"'`/\\]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function scoreBm25ish(text: string, query: string): number {
  const tokens = tokenizeForSearch(text)
  const queryTokens = tokenizeForSearch(query)
  if (tokens.length === 0 || queryTokens.length === 0) return 0

  let score = 0
  for (const token of queryTokens) {
    const matches = tokens.filter((item) => item === token).length
    score += matches * 10
    if (matches === 0 && text.toLowerCase().includes(token)) {
      score += 3
    }
  }

  if (text.toLowerCase().includes(query.toLowerCase().trim())) {
    score += 15
  }

  return score
}

function buildSearchText(tool: SavedCodeExecTool): string {
  return [
    tool.toolId,
    tool.description,
    ...tool.dependencies,
    "saved",
    "code_exec",
    "保存",
    "脚本",
    "工具"
  ].join(" ")
}

function scoreSavedTool(tool: SavedCodeExecTool, query: string, mode: McpToolSearchMode): number {
  const text = buildSearchText(tool)
  switch (mode) {
    case "keyword":
      return scoreKeyword(text, query, tool.toolId)
    case "regex":
      try {
        return new RegExp(query, "i").test(text) ? 50 : 0
      } catch {
        return scoreKeyword(text, query, tool.toolId)
      }
    case "bm25":
    default:
      return scoreBm25ish(text, query)
  }
}

export function parseCodeExecOutputValue(output: string): unknown {
  const trimmed = output.trim()
  if (!trimmed) return ""

  try {
    return JSON.parse(trimmed)
  } catch {
    return output
  }
}

export function buildSavedCodeExecResultExample(data: unknown): unknown {
  return {
    ok: true,
    data: sanitizeValue(data, { depth: 0, key: "data" })
  }
}

function buildSavedCodeExecToolId(
  store: SavedCodeExecToolsFile,
  input: SavedCodeExecToolIdOptions
): string {
  const normalizedToolName = input.toolName.replace(/^saved__?/i, "")
  const baseSlug = toSnakeCase(normalizedToolName, "workflow")
  return ensureUniqueToolId(baseSlug, store, input.codeHash)
}

export function buildSavedCodeExecToolDraft(input: {
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  code: string
  timeoutMs?: number
  dependencies: string[]
  resultExample?: unknown
}): SavedCodeExecToolDraft {
  const store = loadStore()
  const codeHash = computeSavedCodeExecToolHash(input.code, input.timeoutMs)

  return {
    toolId: buildSavedCodeExecToolId(store, {
      toolName: input.toolName,
      codeHash
    }),
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    code: input.code,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    codeHash,
    dependencies: input.dependencies,
    resultExample: input.resultExample
  }
}

export function persistSavedCodeExecTool(draft: SavedCodeExecToolDraft): SavedCodeExecTool {
  const store = loadStore()
  const existingByHash = store.entries.find((entry) => entry.codeHash === draft.codeHash)
  if (existingByHash) {
    return existingByHash
  }

  const now = new Date().toISOString()
  const nextEntry: SavedCodeExecTool = {
    toolId: draft.toolId,
    description: draft.description,
    inputSchema: draft.inputSchema,
    outputSchema: draft.outputSchema,
    code: draft.code,
    timeoutMs: draft.timeoutMs,
    createdAt: now,
    updatedAt: now,
    codeHash: draft.codeHash,
    dependencies: draft.dependencies,
    resultExample: draft.resultExample
  }

  store.entries.push(nextEntry)

  saveStore(store)
  return nextEntry
}

export function listSavedCodeExecTools(): SavedCodeExecTool[] {
  return [...loadStore().entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function getSavedCodeExecTool(idOrAlias: string): SavedCodeExecTool | null {
  const normalized = idOrAlias.trim()
  if (!normalized) return null
  return loadStore().entries.find((entry) => entry.toolId === normalized) ?? null
}

export function getSavedCodeExecToolForCode(code: string, timeoutMs?: number): SavedCodeExecTool | null {
  const codeHash = computeSavedCodeExecToolHash(code, timeoutMs)
  return loadStore().entries.find((entry) => entry.codeHash === codeHash) ?? null
}

export function hasSavedCodeExecToolForCode(code: string, timeoutMs?: number): boolean {
  const codeHash = computeSavedCodeExecToolHash(code, timeoutMs)

  return loadStore().entries.some((entry) => entry.codeHash === codeHash)
}

export function searchSavedCodeExecTools(input: {
  query: string
  topK: number
  mode: McpToolSearchMode
  serverFilter?: string[]
}): SavedCodeExecTool[] {
  const filter = input.serverFilter?.map((item) => item.toLowerCase()) ?? []
  if (filter.length > 0 && !filter.includes("saved") && !filter.includes("saved_code_exec")) {
    return []
  }

  return listSavedCodeExecTools()
    .map((tool) => ({
      tool,
      score: scoreSavedTool(tool, input.query, input.mode)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.toolId.localeCompare(right.tool.toolId))
    .slice(0, input.topK)
    .map((item) => item.tool)
}
