import type { McpCapabilityTool } from "./capability-types"

export interface RenderedToolHints {
  callExample: string
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
}

function formatPropertyKey(key: string): string {
  return isIdentifier(key) ? key : JSON.stringify(key)
}

function buildParamReference(key: string): string {
  return isIdentifier(key) ? `params.${key}` : `params[${JSON.stringify(key)}]`
}

function buildExampleArgs(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "params"

  const source = schema as Record<string, unknown>

  if (source.type === "object" || source.properties) {
    const properties = source.properties && typeof source.properties === "object"
      ? (source.properties as Record<string, unknown>)
      : {}
    const required = new Set(
      Array.isArray(source.required)
        ? source.required.filter((item): item is string => typeof item === "string")
        : []
    )

    const requiredKeys = Object.keys(properties).filter((key) => required.has(key))
    const keys = requiredKeys.length > 0 ? requiredKeys : Object.keys(properties).slice(0, 2)
    if (keys.length === 0) return "{}"

    const lines = keys.map((key) => `  ${formatPropertyKey(key)}: ${buildParamReference(key)}`)
    return `{\n${lines.join(",\n")}\n}`
  }

  return "params"
}

function buildCallExample(tool: McpCapabilityTool): string {
  return `const result = await mcp.${tool.scriptAlias}(${buildExampleArgs(tool.inputSchema ?? { type: "object" })})`
}

export function renderToolHints(tool: McpCapabilityTool): RenderedToolHints {
  const callExample = buildCallExample(tool)

  return {
    callExample
  }
}
