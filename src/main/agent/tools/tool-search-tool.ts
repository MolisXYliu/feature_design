/**
 * Tool Search Tool - MCP Tool Discovery and Lazy Loading
 *
 * This module implements a three-tool architecture for handling large MCP tool libraries:
 * - search_tool: Search for lazily loaded MCP tools
 * - load_tool: Load tool schemas and script signatures
 * - mcp_call: Execute tools via indirect call
 */

import { tool } from "langchain"
import { z } from "zod"
import { CodeExecEngine } from "../../code-exec/engine"
import { LocalProcessRunner } from "../../code-exec/runner"
import {
  getSavedCodeExecTool,
  listSavedCodeExecTools,
  parseCodeExecOutputValue,
  searchSavedCodeExecTools
} from "../../code-exec/saved-tool-store"
import type { McpCapabilityService, McpInvocationResult } from "../../mcp/capability-types"
import { getMcpErrorMessage, getUsefulMcpResultData } from "../../mcp/result-utils"
import { searchCapabilityTools } from "../../mcp/tool-catalog"
import { renderToolHints } from "../../mcp/type-hints"
import { getStoredToolExample } from "../../mcp/tool-example-store"

async function invokeWithRetry(
  service: McpCapabilityService,
  idOrAlias: string,
  args: Record<string, unknown>,
  retries = 1
): Promise<McpInvocationResult> {
  try {
    return await service.invoke(idOrAlias, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const shouldRetry = retries > 0 && (
      message.includes("terminated") ||
      message.includes("disconnected") ||
      message.includes("ECONN")
    )

    if (!shouldRetry) throw error
    await new Promise((resolve) => setTimeout(resolve, 500))
    return invokeWithRetry(service, idOrAlias, args, retries - 1)
  }
}

const searchToolSchema = z.object({
  query: z.string().describe("Search query describing the MCP capability you need"),
  top_k: z.number().optional().default(5).describe("Maximum number of results to return"),
  mode: z.enum(["bm25", "keyword", "regex"]).optional().default("bm25").describe(
    "Search mode: bm25 (semantic ranking), keyword (contains match), regex (pattern match)"
  ),
  server_filter: z.array(z.string()).optional().describe(
    "Optional provider alias/display-name filters"
  )
})

const loadToolSchema = z.object({
  tool_ids: z.array(z.string()).describe("List of MCP tool IDs to inspect"),
  usage: z.enum(["mcp_call", "code_exec"]).optional().default("mcp_call").describe(
    "How the loaded tool info will be used. Use mcp_call for direct tool calls, or code_exec for script authoring hints."
  )
})

const mcpCallSchema = z.object({
  tool_id: z.string().describe("MCP tool ID of the tool to execute"),
  tool_args: z.object({}).passthrough().describe("MCP tool args, refer to load_tool result")
})

interface ToolSearchContext {
  workspacePath: string
  threadId?: string
}

type SearchToolEntry = {
  toolId: string
  description?: string
}

function mergeSearchResults(
  primary: SearchToolEntry[],
  secondary: SearchToolEntry[],
  limit: number
): SearchToolEntry[] {
  const ranked = new Map<string, { tool: SearchToolEntry; score: number }>()

  const addRankedItems = (items: SearchToolEntry[]): void => {
    items.forEach((tool, index) => {
      const score = Math.max(items.length - index, 1)
      const existing = ranked.get(tool.toolId)
      if (!existing || score > existing.score) {
        ranked.set(tool.toolId, { tool, score })
      }
    })
  }

  addRankedItems(primary)
  addRankedItems(secondary)

  return Array.from(ranked.values())
    .sort((left, right) => right.score - left.score || left.tool.toolId.localeCompare(right.tool.toolId))
    .slice(0, limit)
    .map((item) => item.tool)
}

async function getMissingSavedToolDependencies(
  service: McpCapabilityService,
  dependencies: string[]
): Promise<string[]> {
  if (dependencies.length === 0) return []

  const availableTools = await service.listTools()
  const availableScriptAliases = new Set(availableTools.map((tool) => tool.scriptAlias))
  return dependencies.filter((dependency) => !availableScriptAliases.has(dependency))
}

export function createSearchTool(service: McpCapabilityService) {
  return tool(
    async (input) => {
      const mcpTools = await searchCapabilityTools(service, input.query, {
        topK: input.top_k ?? 5,
        mode: input.mode ?? "bm25",
        serverFilter: input.server_filter,
        visibility: "lazy"
      })
      const savedTools = searchSavedCodeExecTools({
        query: input.query,
        topK: input.top_k ?? 5,
        mode: input.mode ?? "bm25",
        serverFilter: input.server_filter
      })
      const tools = mergeSearchResults(mcpTools, savedTools, input.top_k ?? 5)

      return JSON.stringify({
        tools: tools.map((tool) => ({
          tool_id: tool.toolId,
          description: (tool.description ?? "").slice(0, 200)
        }))
      }, null, 2)
    },
    {
      name: "search_tool",
      description:
        "Search for available lazy tools, including MCP tools and saved code_exec tools. Use this to discover provider-specific tools before calling load_tool, " +
        "and then use mcp_call to invoke them, or code_exec when you need to compose MCP tools in a script.",
      schema: searchToolSchema
    }
  )
}

export function createLoadTool(service: McpCapabilityService) {
  return tool(
    async (input) => {
      const loadedTools = await Promise.all(input.tool_ids.map(async (idOrAlias) => {
        const savedTool = getSavedCodeExecTool(idOrAlias)
        if (savedTool) {
          if (input.usage === "code_exec") {
            return {
              tool_id: savedTool.toolId,
              error: "Saved code_exec tools cannot be called from code_exec. Load the underlying MCP tool instead."
            }
          }

          return {
            tool_id: savedTool.toolId,
            schema: savedTool.inputSchema,
            output_schema: savedTool.outputSchema
          }
        }

        const resolved = await service.getTool(idOrAlias)
        if (!resolved) {
          return {
            tool_id: idOrAlias,
            error: "Tool not found"
          }
        }

        const loadedTool: Record<string, unknown> = {
          tool_id: resolved.toolId,
          schema: resolved.inputSchema,
          output_schema: resolved.outputSchema
        }

        if (input.usage === "code_exec") {
          const storedExample = getStoredToolExample(resolved)
          const hints = renderToolHints(resolved)

          loadedTool.code_exec = {
            call_example: hints.callExample,
            ...(storedExample ? { result_example: storedExample.resultExample } : {})
          }
        }

        return loadedTool
      }))

      return JSON.stringify({
        loaded_tools: loadedTools
      }, null, 2)
    },
    {
      name: "load_tool",
      description:
        "Load exact lazy-tool schemas for any available MCP tool or saved code_exec tool. " +
        "Set usage=code_exec when you need MCP call examples and result samples for code_exec authoring.",
      schema: loadToolSchema
    }
  )
}

export function createMcpCallTool(service: McpCapabilityService, context: ToolSearchContext) {
  const engine = new CodeExecEngine(new LocalProcessRunner(service))

  return tool(
    async (input) => {
      const savedTool = getSavedCodeExecTool(input.tool_id)
      if (savedTool) {
        const missingDependencies = await getMissingSavedToolDependencies(service, savedTool.dependencies)
        if (missingDependencies.length > 0) {
          const dependencyList = missingDependencies.join(", ")
          return JSON.stringify({
            ok: false,
            error:
              `Saved tool dependency unavailable: ${dependencyList}. ` +
              "The underlying MCP connector or tool is not currently enabled. " +
              "Re-enable the connector, then retry this saved tool."
          }, null, 2)
        }

        const result = await engine.execute({
          code: savedTool.code,
          params: input.tool_args ?? {},
          timeoutMs: savedTool.timeoutMs,
          workspacePath: context.workspacePath,
          threadId: context.threadId
        })

        if (!result.ok) {
          return JSON.stringify({
            ok: false,
            error: result.error || result.output
          }, null, 2)
        }

        return JSON.stringify({
          ok: true,
          data: parseCodeExecOutputValue(result.output)
        }, null, 2)
      }

      if (!(await service.getTool(input.tool_id))) {
        return JSON.stringify({
          ok: false,
          error: `Tool not found: ${input.tool_id}`
        }, null, 2)
      }

      try {
        const result = await invokeWithRetry(service, input.tool_id, input.tool_args ?? {})

        if (result.isError) {
          return JSON.stringify({
            ok: false,
            error: getMcpErrorMessage(result)
          }, null, 2)
        }

        return JSON.stringify({
          ok: true,
          data: getUsefulMcpResultData(result)
        }, null, 2)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return JSON.stringify({
          ok: false,
          error: message
        }, null, 2)
      }
    },
    {
      name: "mcp_call",
      description:
        "Execute a lazy MCP tool or saved code_exec tool by tool_id. Use search_tool and load_tool first so you know the exact schema.",
      schema: mcpCallSchema
    }
  )
}

export async function createToolSearchTools(
  service: McpCapabilityService,
  context: ToolSearchContext
): Promise<unknown[]> {
  const tools = await service.listTools()
  const savedTools = listSavedCodeExecTools()
  const lazyTools = tools.filter((tool) => tool.visibility === "lazy")
  if (tools.length === 0 && savedTools.length === 0) return []

  if (lazyTools.length === 0 && savedTools.length === 0) {
    return [createLoadTool(service)]
  }

  return [
    createSearchTool(service),
    createLoadTool(service),
    createMcpCallTool(service, context)
  ]
}
