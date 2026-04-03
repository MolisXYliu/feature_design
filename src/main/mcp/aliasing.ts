import type { McpCapabilityAliasMaps, McpCapabilityTool, McpToolVisibility } from "./capability-types"

export interface McpCapabilitySeed {
  capabilityId: string
  providerKey: string
  providerDisplayName: string
  toolName: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  visibility: McpToolVisibility
}

const RESERVED_HELPER_NAMES = new Set(["$call", "$meta"])

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

function toLowerCamelCase(value: string, fallback: string): string {
  const tokens = splitIntoTokens(value)
  if (tokens.length === 0) return fallback

  const [first, ...rest] = tokens
  const normalized = [
    first.toLowerCase(),
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
  ].join("")

  return ensureIdentifier(normalized, fallback)
}

function toSnakeCase(value: string, fallback: string): string {
  const tokens = splitIntoTokens(value)
  if (tokens.length === 0) return fallback
  return ensureIdentifier(tokens.map((part) => part.toLowerCase()).join("_"), fallback)
}

function makeUniqueAlias(baseAlias: string, used: Set<string>, fallback: string): string {
  const sanitizedBase = ensureIdentifier(baseAlias, fallback)
  let candidate = sanitizedBase
  let suffix = 2

  while (used.has(candidate) || RESERVED_HELPER_NAMES.has(candidate)) {
    candidate = `${sanitizedBase}_${suffix}`
    suffix += 1
  }

  used.add(candidate)
  return candidate
}

export function toMcpToolId(providerAlias: string, displayMethodAlias: string): string {
  return `${providerAlias}__${displayMethodAlias}`
}

export function buildCapabilityAliases(seeds: McpCapabilitySeed[]): McpCapabilityTool[] {
  const providerAliasByKey = new Map<string, string>()
  const usedProviderAliases = new Set<string>()

  const uniqueProviders = Array.from(
    new Map(seeds.map((seed) => [seed.providerKey, seed.providerDisplayName])).entries()
  ).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))

  for (const [providerKey, providerDisplayName] of uniqueProviders) {
    const baseAlias = toLowerCamelCase(providerDisplayName, "provider")
    providerAliasByKey.set(
      providerKey,
      makeUniqueAlias(baseAlias, usedProviderAliases, "provider")
    )
  }

  const toolsByProvider = new Map<string, McpCapabilitySeed[]>()
  for (const seed of seeds) {
    const bucket = toolsByProvider.get(seed.providerKey)
    if (bucket) {
      bucket.push(seed)
    } else {
      toolsByProvider.set(seed.providerKey, [seed])
    }
  }

  const resolved = new Map<string, McpCapabilityTool>()

  for (const [providerKey, providerTools] of Array.from(toolsByProvider.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    const providerAlias = providerAliasByKey.get(providerKey) ?? "provider"
    const usedDisplayAliases = new Set<string>()

    for (const seed of [...providerTools].sort((left, right) => {
      if (left.toolName === right.toolName) {
        return left.capabilityId.localeCompare(right.capabilityId)
      }
      return left.toolName.localeCompare(right.toolName)
    })) {
      const displayMethodAlias = makeUniqueAlias(
        toSnakeCase(seed.toolName, "tool"),
        usedDisplayAliases,
        "tool"
      )

      resolved.set(seed.capabilityId, {
        capabilityId: seed.capabilityId,
        toolId: toMcpToolId(providerAlias, displayMethodAlias),
        providerKey: seed.providerKey,
        providerAlias,
        providerDisplayName: seed.providerDisplayName,
        toolName: seed.toolName,
        description: seed.description,
        inputSchema: seed.inputSchema,
        outputSchema: seed.outputSchema,
        visibility: seed.visibility
      })
    }
  }

  return seeds
    .map((seed) => resolved.get(seed.capabilityId))
    .filter((tool): tool is McpCapabilityTool => Boolean(tool))
}

export function buildAliasMaps(tools: McpCapabilityTool[]): McpCapabilityAliasMaps {
  const maps: McpCapabilityAliasMaps = {
    capabilityById: new Map(),
    toolIds: new Map()
  }

  for (const tool of tools) {
    maps.capabilityById.set(tool.capabilityId, tool)
    maps.toolIds.set(tool.toolId, tool)
  }

  return maps
}
