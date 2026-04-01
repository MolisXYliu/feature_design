import type { McpCapabilityTool, McpInvocationResult } from "./capability-types"
import { toCallResult, type McpCallResultValue } from "./result-utils"

export interface McpServerProxy {
  [providerAlias: string]: unknown
}

export type McpServerProxyCaller = (
  idOrAlias: string,
  args: Record<string, unknown>
) => Promise<McpInvocationResult>

function normalizeArgs(args?: Record<string, unknown>): Record<string, unknown> {
  return args ?? {}
}

export function createServerProxy(
  tools: McpCapabilityTool[],
  call: McpServerProxyCaller
): McpServerProxy {
  const proxy = {} as McpServerProxy

  const providers = new Map<string, Record<string, unknown>>()

  for (const tool of tools) {
    const provider = providers.get(tool.providerAlias) ?? {}
    provider[tool.methodAlias] = async (args?: Record<string, unknown>): Promise<McpCallResultValue> => {
      const result = await call(tool.capabilityId, normalizeArgs(args))
      return toCallResult(result)
    }

    providers.set(tool.providerAlias, provider)
    proxy[tool.providerAlias] = provider
  }

  return proxy
}
