/**
 * Tool Search Tool - MCP Tool Discovery and Lazy Loading
 *
 * This module implements a three-tool architecture for handling large MCP tool libraries:
 * - search_tool: Search for lazily loaded MCP tools
 * - inspect_tool: Inspect tool schemas and script signatures
 * - invoke_deferred_tool: Execute a deferred MCP tool or saved tool
 */

import { tool } from "langchain"
import { z } from "zod"
import { CodeExecEngine } from "../../code-exec/engine"
import { LocalProcessRunner } from "../../code-exec/runner"
import {
  getSavedCodeExecTool,
  listSavedCodeExecTools,
  parseCodeExecOutputValue,
  type SavedCodeExecTool
} from "../../code-exec/saved-tool-store"
import type { McpCapabilityService, McpInvocationResult, McpCapabilityTool } from "../../mcp/capability-types"
import { getMcpErrorMessage, getUsefulMcpResultData } from "../../mcp/result-utils"
import { renderToolHints } from "../../mcp/type-hints"
import { getStoredToolExample } from "../../mcp/tool-example-store"
import {
  buildMcpToolSearchDoc,
  buildSavedToolSearchDoc,
  findExactToolIdOrNameMatches,
  matchesExactSearchValue,
  searchToolDocs,
  type ToolSearchDoc,
  type ToolSearchCaller
} from "./tool-search/search-strategy"

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

const invokeDeferredToolSchema = z.object({
  tool_id: z.string().describe("Tool ID of the deferred MCP tool or saved tool to execute"),
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
  allowCallers: ToolSearchCaller[]
  description?: string
}

interface SearchDocCacheEntry {
  snapshot: string
  docs: ToolSearchDoc[]
}

function buildMcpSearchSnapshot(tools: McpCapabilityTool[]): string {
  return JSON.stringify(tools.map((tool) => ([
    tool.capabilityId,
    tool.toolId,
    tool.toolName,
    tool.providerDisplayName,
    tool.providerAlias,
    tool.description ?? "",
    tool.visibility
  ])))
}

function buildSavedToolSearchSnapshot(tools: SavedCodeExecTool[]): string {
  return JSON.stringify(tools.map((tool) => ([
    tool.toolId,
    tool.description,
    tool.dependencies
  ])))
}

function getCachedMcpSearchDocs(
  cache: SearchDocCacheEntry,
  tools: McpCapabilityTool[],
  allowMcpCallers: ToolSearchCaller[]
): ToolSearchDoc[] {
  const snapshot = buildMcpSearchSnapshot(tools)
  if (cache.snapshot === snapshot) return cache.docs

  cache.snapshot = snapshot
  cache.docs = tools.map((tool) => buildMcpToolSearchDoc(tool, { allowCallers: allowMcpCallers }))
  return cache.docs
}

function getCachedSavedToolSearchDocs(
  cache: SearchDocCacheEntry,
  tools: SavedCodeExecTool[]
): ToolSearchDoc[] {
  const snapshot = buildSavedToolSearchSnapshot(tools)
  if (cache.snapshot === snapshot) return cache.docs

  cache.snapshot = snapshot
  cache.docs = tools.map((tool) => buildSavedToolSearchDoc(tool))
  return cache.docs
}

function toMcpSearchToolEntry(
  tool: McpCapabilityTool,
  allowCallers: ToolSearchCaller[]
): SearchToolEntry {
  return {
    toolId: tool.toolId,
    source: "mcp",
    allowCallers,
    description: tool.description
  }
}

function toSavedSearchToolEntry(tool: SavedCodeExecTool): SearchToolEntry {
  return {
    toolId: tool.toolId,
    source: "saved_tool",
    allowCallers: ["invoke_deferred_tool"],
    description: tool.description
  }
}

function findExactSearchMatches(
  query: string,
  searchableMcpTools: McpCapabilityTool[],
  fallbackMcpTools: McpCapabilityTool[],
  savedTools: SavedCodeExecTool[],
  allowMcpCallers: ToolSearchCaller[],
  maxResults: number
): SearchToolEntry[] {
  const exactMatches = new Map<string, SearchToolEntry>()

  const addMcpMatches = (tools: McpCapabilityTool[]): void => {
    for (const tool of findExactToolIdOrNameMatches(tools, query)) {
      exactMatches.set(tool.toolId, toMcpSearchToolEntry(tool, allowMcpCallers))
    }
  }

  const addSavedToolMatches = (): void => {
    for (const tool of savedTools) {
      if (!matchesExactSearchValue(tool.toolId, query)) continue
      exactMatches.set(tool.toolId, toSavedSearchToolEntry(tool))
    }
  }

  addMcpMatches(searchableMcpTools)
  addSavedToolMatches()
  if (exactMatches.size > 0) return Array.from(exactMatches.values()).slice(0, maxResults)

  addMcpMatches(fallbackMcpTools)
  return Array.from(exactMatches.values()).slice(0, maxResults)
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
    query: z.string().describe(
      "Standardized search query describing the capability you need. Prefer provider + resource + action + qualifiers with full words, for example: 'github pull request list', 'github pull request read details', 'notion database query'. Prefix a term with + when it must be present, for example 'github +issue create'. Avoid short abbreviations like 'pr' when a full phrase is available. Deferred tools appear by exact tool_id in <available-deferred-tools> messages."
    ),
    max_results: z.number().optional().default(5).describe("Maximum number of results to return"),
    caller: codeExecEnabled
      ? z.enum(["invoke_deferred_tool", "code_exec"]).optional().default("invoke_deferred_tool").describe(
        "Which caller this search is for. Use invoke_deferred_tool for lazy MCP tools and enabled saved tools. Use code_exec to search all enabled MCP tools that code_exec can call. Non-MCP and built-in tools are never eligible for code_exec."
      )
      : z.enum(["invoke_deferred_tool"]).optional().default("invoke_deferred_tool").describe(
        "Which caller this search is for. code_exec is disabled in this runtime, so invoke_deferred_tool is the only available caller."
      )
  })
}

function createInspectCallerSchema(codeExecEnabled: boolean) {
  return z.object({
    tool_ids: z.array(z.string()).describe("List of discovered tool IDs to inspect"),
    caller: codeExecEnabled
      ? z.enum(["invoke_deferred_tool", "code_exec"]).optional().default("invoke_deferred_tool").describe(
        "Which caller this inspection is for. Use invoke_deferred_tool for direct invocation, or code_exec for MCP-only script authoring hints."
      )
      : z.enum(["invoke_deferred_tool"]).optional().default("invoke_deferred_tool").describe(
        "Which caller this inspection is for. code_exec is disabled in this runtime, so invoke_deferred_tool is the only available caller."
      )
  })
}

export function createSearchTool(service: McpCapabilityService, options: ToolSearchOptions) {
  const allowMcpCallers: ToolSearchCaller[] = options.codeExecEnabled
    ? ["invoke_deferred_tool", "code_exec"]
    : ["invoke_deferred_tool"]
  const lazyMcpDocCache: SearchDocCacheEntry = { snapshot: "", docs: [] }
  const allMcpDocCache: SearchDocCacheEntry = { snapshot: "", docs: [] }
  const savedToolDocCache: SearchDocCacheEntry = { snapshot: "", docs: [] }

  return tool(
    async (input) => {
      const caller = String(input.caller ?? "invoke_deferred_tool")
      const isCodeExecCaller = options.codeExecEnabled && caller === "code_exec"
      const allMcpTools = await service.listTools()
      const searchableMcpTools = allMcpTools.filter((tool) => isCodeExecCaller || tool.visibility === "lazy")
      const fallbackMcpTools = isCodeExecCaller
        ? []
        : allMcpTools.filter((tool) => tool.visibility !== "lazy")
      const savedTools = !options.codeExecEnabled || isCodeExecCaller
        ? []
        : listSavedCodeExecTools()
      const exactMatches = findExactSearchMatches(
        input.query,
        searchableMcpTools,
        fallbackMcpTools,
        savedTools,
        allowMcpCallers,
        input.max_results ?? 5
      )

      if (exactMatches.length > 0) {
        return JSON.stringify({
          tools: exactMatches.map((tool) => ({
            tool_id: tool.toolId,
            source: tool.source,
            allow_callers: tool.allowCallers,
            description: (tool.description ?? "").slice(0, 200)
          }))
        }, null, 2)
      }

      const mcpDocs = getCachedMcpSearchDocs(
        isCodeExecCaller ? allMcpDocCache : lazyMcpDocCache,
        searchableMcpTools,
        allowMcpCallers
      )
      const savedDocs = savedTools.length > 0
        ? getCachedSavedToolSearchDocs(savedToolDocCache, savedTools)
        : []

      const tools: SearchToolEntry[] = searchToolDocs(
        [...mcpDocs, ...savedDocs],
        input.query,
        input.max_results ?? 5
      ).map((doc) => ({
        toolId: doc.toolId,
        source: doc.source,
        allowCallers: doc.allowCallers,
        description: doc.description
      }))

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
          ? "Search for discovered tools by caller. Write normalized queries using provider + resource + action + qualifiers, and prefer full words over abbreviations, for example 'github pull request list' or 'github pull request read details' instead of 'github pr list'. Prefix a term with + when it must be present, for example 'github +issue create'. Deferred tools appear by exact tool_id in <available-deferred-tools> messages. For invoke_deferred_tool, this searches lazy MCP tools plus enabled saved tools. For code_exec, this searches all enabled MCP tools and excludes saved tools and all non-MCP tools. Returns each tool's source and allow_callers."
          : "Search for discovered tools for invoke_deferred_tool. Write normalized queries using provider + resource + action + qualifiers, and prefer full words over abbreviations, for example 'github pull request list' instead of 'github pr list'. Prefix a term with + when it must be present, for example 'github +issue create'. Deferred tools appear by exact tool_id in <available-deferred-tools> messages. This searches lazy MCP tools only and returns each tool's source and allow_callers.",
      schema: createSearchCallerSchema(options.codeExecEnabled)
    }
  )
}

export function createInspectTool(service: McpCapabilityService, options: ToolSearchOptions) {
  const allowMcpCallers: ToolSearchCaller[] = options.codeExecEnabled
    ? ["invoke_deferred_tool", "code_exec"]
    : ["invoke_deferred_tool"]

  return tool(
    async (input) => {
      const caller = String(input.caller ?? "invoke_deferred_tool")
      const loadedTools = await Promise.all(input.tool_ids.map(async (idOrAlias) => {
        const savedTool = getSavedCodeExecTool(idOrAlias, { includeDisabled: true })
        if (savedTool) {
          if (!options.codeExecEnabled) {
            return {
              tool_id: savedTool.toolId,
              source: "saved_tool",
              allow_callers: ["invoke_deferred_tool"],
              error: "Saved tools are disabled in settings."
            }
          }

          if (!savedTool.enabled) {
            return {
              tool_id: savedTool.toolId,
              source: "saved_tool",
              allow_callers: ["invoke_deferred_tool"],
              error: "Saved tool is disabled."
            }
          }

          if (caller === "code_exec") {
            return {
              tool_id: savedTool.toolId,
              source: "saved_tool",
              allow_callers: ["invoke_deferred_tool"],
              error: "Saved code_exec tools cannot be called from code_exec. Load the underlying MCP tool instead."
            }
          }

          return {
            tool_id: savedTool.toolId,
            source: "saved_tool",
            allow_callers: ["invoke_deferred_tool"],
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
            error:
              caller === "code_exec"
                ? "Only MCP tools may be inspected for code_exec. Saved tools, built-in tools, and other non-MCP tools are not allowed."
                : "Tool not found"
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
          ? "Inspect the exact schema and examples for any discovered MCP tool or saved tool. Set caller=code_exec only for MCP tools when you need canonical tool_id call examples and result samples for code_exec authoring."
          : "Inspect the exact schema and examples for any discovered MCP tool. Enabled saved tools are hidden because code_exec is disabled in this runtime.",
      schema: createInspectCallerSchema(options.codeExecEnabled)
    }
  )
}

export function createInvokeDeferredTool(
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
      name: "invoke_deferred_tool",
      description:
        "Execute a deferred MCP tool or saved tool by tool_id. Use search_tool and inspect_tool first so you know the exact schema.",
      schema: invokeDeferredToolSchema
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
  const hasMcpTools = tools.length > 0
  const hasLazyTools = lazyTools.length > 0
  const hasSavedTools = savedTools.length > 0
  const needsDeferredBridge = hasLazyTools || hasSavedTools
  const shouldInjectInspectTool = needsDeferredBridge || (codeExecEnabled && hasMcpTools)

  if (!shouldInjectInspectTool) return []

  if (!needsDeferredBridge) {
    return [createInspectTool(service, { codeExecEnabled })]
  }

  return [
    createSearchTool(service, { codeExecEnabled }),
    createInspectTool(service, { codeExecEnabled }),
    createInvokeDeferredTool(service, context, { codeExecEnabled })
  ]
}
