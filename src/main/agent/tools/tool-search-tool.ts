/**
 * Tool Search Tool - MCP Tool Discovery and Lazy Loading
 *
 * This module implements a three-tool architecture for handling large MCP tool libraries:
 * - search_tool: Search for lazily loaded MCP tools
 * - inspect_tool: Inspect tool schemas and script signatures
 * - invoke_discovered_tool: Execute a discovered MCP tool or saved tool
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

const invokeDiscoveredToolSchema = z.object({
  tool_id: z.string().describe("Tool ID of the discovered MCP tool or saved tool to execute"),
  tool_args: z.object({}).passthrough().describe("Tool args, refer to inspect_tool result")
})

interface ToolSearchContext {
  workspacePath: string
  threadId?: string
}

interface ToolSearchOptions {
  codeExecEnabled: boolean
}

type SearchToolEntry = {
  toolId: string
  source: "mcp" | "saved_tool"
  allowCallers: string[]
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
  const availableToolIds = new Set(availableTools.map((tool) => tool.toolId))
  return dependencies.filter((dependency) => !availableToolIds.has(dependency))
}

function createSearchCallerSchema(codeExecEnabled: boolean) {
  return z.object({
    query: z.string().describe("Search query describing the discovered tool capability you need"),
    top_k: z.number().optional().default(5).describe("Maximum number of results to return"),
    mode: z.enum(["bm25", "keyword", "regex"]).optional().default("bm25").describe(
      "Search mode: bm25 (semantic ranking), keyword (contains match), regex (pattern match)"
    ),
    caller: codeExecEnabled
      ? z.enum(["invoke_discovered_tool", "code_exec"]).optional().default("invoke_discovered_tool").describe(
        "Which caller this search is for. Use invoke_discovered_tool for lazy MCP tools and enabled saved tools. Use code_exec to search all enabled MCP tools that code_exec can call."
      )
      : z.enum(["invoke_discovered_tool"]).optional().default("invoke_discovered_tool").describe(
        "Which caller this search is for. code_exec is disabled in this runtime, so invoke_discovered_tool is the only available caller."
      )
  })
}

function createInspectCallerSchema(codeExecEnabled: boolean) {
  return z.object({
    tool_ids: z.array(z.string()).describe("List of discovered tool IDs to inspect"),
    caller: codeExecEnabled
      ? z.enum(["invoke_discovered_tool", "code_exec"]).optional().default("invoke_discovered_tool").describe(
        "Which caller this inspection is for. Use invoke_discovered_tool for direct invocation, or code_exec for script authoring hints."
      )
      : z.enum(["invoke_discovered_tool"]).optional().default("invoke_discovered_tool").describe(
        "Which caller this inspection is for. code_exec is disabled in this runtime, so invoke_discovered_tool is the only available caller."
      )
  })
}

export function createSearchTool(service: McpCapabilityService, options: ToolSearchOptions) {
  const allowMcpCallers = options.codeExecEnabled
    ? ["invoke_discovered_tool", "code_exec"]
    : ["invoke_discovered_tool"]

  return tool(
    async (input) => {
      const caller = String(input.caller ?? "invoke_discovered_tool")
      const isCodeExecCaller = options.codeExecEnabled && caller === "code_exec"
      const mcpTools = (await searchCapabilityTools(service, input.query, {
        topK: input.top_k ?? 5,
        mode: input.mode ?? "bm25",
        visibility: isCodeExecCaller ? "all" : "lazy"
      })).map((tool) => ({
        toolId: tool.toolId,
        source: "mcp" as const,
        allowCallers: allowMcpCallers,
        description: tool.description
      }))
      const savedTools = !options.codeExecEnabled || isCodeExecCaller
        ? []
        : searchSavedCodeExecTools({
            query: input.query,
            topK: input.top_k ?? 5,
            mode: input.mode ?? "bm25"
          }).map((tool) => ({
            toolId: tool.toolId,
            source: "saved_tool" as const,
            allowCallers: ["invoke_discovered_tool"],
            description: tool.description
          }))
      const tools = mergeSearchResults(mcpTools, savedTools, input.top_k ?? 5)

      return JSON.stringify({
        tools: tools.map((tool) => ({
          tool_id: tool.toolId,
          source: tool.source,
          allow_callers: tool.allowCallers,
          description: (tool.description ?? "").slice(0, 200)
        }))
      }, null, 2)
    },
    {
      name: "search_tool",
      description:
        options.codeExecEnabled
          ? "Search for discovered tools by caller. For invoke_discovered_tool, this searches lazy MCP tools plus enabled saved tools. For code_exec, this searches all enabled MCP tools and excludes saved tools. Returns each tool's source and allow_callers."
          : "Search for discovered tools for invoke_discovered_tool. This searches lazy MCP tools only and returns each tool's source and allow_callers.",
      schema: createSearchCallerSchema(options.codeExecEnabled)
    }
  )
}

export function createInspectTool(service: McpCapabilityService, options: ToolSearchOptions) {
  const allowMcpCallers = options.codeExecEnabled
    ? ["invoke_discovered_tool", "code_exec"]
    : ["invoke_discovered_tool"]

  return tool(
    async (input) => {
      const caller = String(input.caller ?? "invoke_discovered_tool")
      const loadedTools = await Promise.all(input.tool_ids.map(async (idOrAlias) => {
        const savedTool = getSavedCodeExecTool(idOrAlias, { includeDisabled: true })
        if (savedTool) {
          if (!options.codeExecEnabled) {
            return {
              tool_id: savedTool.toolId,
              source: "saved_tool",
              allow_callers: ["invoke_discovered_tool"],
              error: "Saved tools are disabled in settings."
            }
          }

          if (!savedTool.enabled) {
            return {
              tool_id: savedTool.toolId,
              source: "saved_tool",
              allow_callers: ["invoke_discovered_tool"],
              error: "Saved tool is disabled."
            }
          }

          if (caller === "code_exec") {
            return {
              tool_id: savedTool.toolId,
              source: "saved_tool",
              allow_callers: ["invoke_discovered_tool"],
              error: "Saved code_exec tools cannot be called from code_exec. Load the underlying MCP tool instead."
            }
          }

          return {
            tool_id: savedTool.toolId,
            source: "saved_tool",
            allow_callers: ["invoke_discovered_tool"],
            schema: savedTool.inputSchema,
            output_schema: savedTool.outputSchema
          }
        }

        const resolved = await service.getTool(idOrAlias)
        if (!resolved) {
          return {
            tool_id: idOrAlias,
            source: "mcp",
            allow_callers: allowMcpCallers,
            error: "Tool not found"
          }
        }

        const loadedTool: Record<string, unknown> = {
          tool_id: resolved.toolId,
          source: "mcp",
          allow_callers: allowMcpCallers,
          schema: resolved.inputSchema,
          output_schema: resolved.outputSchema
        }

        if (caller === "code_exec") {
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
      name: "inspect_tool",
      description:
        options.codeExecEnabled
          ? "Inspect the exact schema and examples for any discovered MCP tool or saved tool. Set caller=code_exec when you need canonical tool_id call examples and result samples for code_exec authoring."
          : "Inspect the exact schema and examples for any discovered MCP tool. Enabled saved tools are hidden because code_exec is disabled in this runtime.",
      schema: createInspectCallerSchema(options.codeExecEnabled)
    }
  )
}

export function createInvokeDiscoveredTool(
  service: McpCapabilityService,
  context: ToolSearchContext,
  options: ToolSearchOptions
) {
  const engine = new CodeExecEngine(new LocalProcessRunner(service))

  return tool(
    async (input) => {
      const savedTool = getSavedCodeExecTool(input.tool_id, { includeDisabled: true })
      if (savedTool) {
        if (!options.codeExecEnabled) {
          return JSON.stringify({
            ok: false,
            error: "Saved tools are disabled in settings."
          }, null, 2)
        }

        if (!savedTool.enabled) {
          return JSON.stringify({
            ok: false,
            error: "Saved tool is disabled."
          }, null, 2)
        }

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
      name: "invoke_discovered_tool",
      description:
        "Execute a discovered MCP tool or saved tool by tool_id. Use search_tool and inspect_tool first so you know the exact schema.",
      schema: invokeDiscoveredToolSchema
    }
  )
}

export async function createToolSearchTools(
  service: McpCapabilityService,
  context: ToolSearchContext,
  options?: Partial<ToolSearchOptions>
): Promise<unknown[]> {
  const codeExecEnabled = options?.codeExecEnabled !== false
  const tools = await service.listTools()
  const savedTools = codeExecEnabled ? listSavedCodeExecTools() : []
  const lazyTools = tools.filter((tool) => tool.visibility === "lazy")
  if (tools.length === 0 && savedTools.length === 0) return []

  if (lazyTools.length === 0 && savedTools.length === 0) {
    return [createInspectTool(service, { codeExecEnabled })]
  }

  return [
    createSearchTool(service, { codeExecEnabled }),
    createInspectTool(service, { codeExecEnabled }),
    createInvokeDiscoveredTool(service, context, { codeExecEnabled })
  ]
}
