/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createSkillsMiddleware,
  createMemoryMiddleware,
  createSummarizationMiddleware,
  StateBackend
} from "deepagents"
import {
  getThreadCheckpointPath,
  getSkillsSources,
  getCustomModelConfigs,
  DEFAULT_MAX_TOKENS
} from "../storage"

import { ChatOpenAI } from "@langchain/openai"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { LocalSandbox } from "./local-sandbox"
import {
  createAgent,
  SystemMessage,
  todoListMiddleware,
  anthropicPromptCachingMiddleware,
  humanInTheLoopMiddleware
} from "langchain"
import { Runnable } from "@langchain/core/runnables"

import type * as _lcTypes from "langchain"
import type * as _lcMessages from "@langchain/core/messages"
import type * as _lcLanggraph from "@langchain/langgraph"
import type * as _lcZodTypes from "@langchain/core/utils/types"

import { BASE_SYSTEM_PROMPT } from "./system-prompt"

const BASE_PROMPT =
  "In order to complete the objective that the user asks of you, you have access to a number of standard tools."

/**
 * Custom version of deepagents' createDeepAgent.
 *
 * Aligned with official 1.8.1 except:
 *   - `defaultInterruptOn` is always null — subagents run autonomously without HITL.
 *   - Accepts `summarizationTrigger` / `summarizationKeep` for explicit overrides
 *     (useful for custom models without a profile).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createDeepAgent(params: Record<string, any> = {}) {
  const {
    model = "claude-sonnet-4-5-20250929",
    tools = [],
    systemPrompt,
    middleware: customMiddleware = [],
    subagents = [],
    responseFormat,
    contextSchema,
    checkpointer,
    store,
    backend,
    interruptOn,
    name,
    memory,
    skills,
    filesystemSystemPrompt,
    summarizationTrigger,
    summarizationKeep,
    toolTokenLimitBeforeEvict,
    trimTokensToSummarize
  } = params

  // --- systemPrompt handling (identical to original) ---
  const finalSystemPrompt = systemPrompt
    ? typeof systemPrompt === "string"
      ? `${systemPrompt}\n\n${BASE_PROMPT}`
      : new SystemMessage({
          content: [
            { type: "text" as const, text: BASE_PROMPT },
            ...(typeof systemPrompt.content === "string"
              ? [{ type: "text" as const, text: systemPrompt.content }]
              : systemPrompt.content)
          ]
        })
    : BASE_PROMPT

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filesystemBackend = backend ? backend : (config: any) => new StateBackend(config)

  const skillsMiddlewareArray =
    skills != null && skills.length > 0
      ? [createSkillsMiddleware({ backend: filesystemBackend, sources: skills })]
      : []

  const memoryMiddlewareArray =
    memory != null && memory.length > 0
      ? [createMemoryMiddleware({ backend: filesystemBackend, sources: memory })]
      : []

  // Process subagents: auto-inject SkillsMiddleware for subagents with their own skills
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processedSubagents = subagents.map((subagent: any) => {
    if (Runnable.isRunnable(subagent)) return subagent
    if (!("skills" in subagent) || subagent.skills?.length === 0) return subagent
    const subagentSkillsMiddleware = createSkillsMiddleware({
      backend: filesystemBackend,
      sources: subagent.skills ?? []
    })
    return {
      ...subagent,
      middleware: [subagentSkillsMiddleware, ...(subagent.middleware || [])]
    }
  })

  // Summarization options: pass explicit trigger/keep if provided, otherwise let
  // createSummarizationMiddleware auto-compute from the model profile.
  const summarizationOptions = {
    model,
    backend: filesystemBackend,
    historyPathPrefix: ".cmbcoworkagent/conversation_history",
    ...(trimTokensToSummarize != null && { trimTokensToSummarize }),
    ...(summarizationTrigger != null && { trigger: summarizationTrigger }),
    ...(summarizationKeep != null && { keep: summarizationKeep }),
    truncateArgsSettings: {
      trigger: { type: "messages" as const, value: 20 },
      keep: { type: "messages" as const, value: 20 },
      maxLength: 1000
    }
  }

  // Base middleware for custom subagents (no skills — custom subagents must define their own)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subagentMiddleware: any[] = [
    todoListMiddleware(),
    createFilesystemMiddleware({
      backend: filesystemBackend,
      ...(filesystemSystemPrompt && { systemPrompt: filesystemSystemPrompt }),
      ...(toolTokenLimitBeforeEvict != null && { toolTokenLimitBeforeEvict })
    }),
    createSummarizationMiddleware(summarizationOptions),
    anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    createPatchToolCallsMiddleware()
  ]

  return createAgent({
    model,
    systemPrompt: finalSystemPrompt,
    tools,
    middleware: [
      todoListMiddleware(),
      createFilesystemMiddleware({
        backend: filesystemBackend,
        ...(filesystemSystemPrompt && { systemPrompt: filesystemSystemPrompt }),
        ...(toolTokenLimitBeforeEvict != null && { toolTokenLimitBeforeEvict })
      }),
      createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: tools,
        defaultMiddleware: subagentMiddleware,
        generalPurposeMiddleware: [...subagentMiddleware, ...skillsMiddlewareArray],
        defaultInterruptOn: null, // FIX: subagents run without HITL
        subagents: processedSubagents,
        generalPurposeAgent: true
      } as Parameters<typeof createSubAgentMiddleware>[0]),
      createSummarizationMiddleware(summarizationOptions),
      anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
      createPatchToolCallsMiddleware(),
      ...skillsMiddlewareArray,
      ...memoryMiddlewareArray,
      ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : []),
      ...customMiddleware
    ],
    ...(responseFormat != null && { responseFormat }),
    contextSchema,
    checkpointer,
    store,
    name
  } as unknown as Parameters<typeof createAgent>[0])
}

/**
 * Generate the full system prompt for the agent.
 *
 * @param workspacePath - The workspace path the agent is operating in
 * @returns The complete system prompt
 */
function getSystemPrompt(workspacePath: string): string {
  const isWindows = process.platform === "win32"
  const platform = isWindows ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"
  const shell = isWindows ? "PowerShell" : process.env.SHELL?.split("/").pop() || "bash"
  const examplePath = isWindows
    ? `${workspacePath}\\src\\index.ts`
    : `${workspacePath}/src/index.ts`

  const workingDirSection = `
### System Environment
- Operating system: ${platform} (${process.arch})
- Default shell: ${shell}
${isWindows ? "- Use PowerShell syntax for shell commands (e.g., Get-ChildItem instead of ls, Get-Content instead of cat)" : "- Use Unix commands for shell operations (ls, cat, grep, etc.)"}

### File System and Paths

**IMPORTANT - Path Handling:**
- All file paths use fully qualified absolute system paths
- The workspace root is: \`${workspacePath}\`
- Example: \`${examplePath}\`
- To list the workspace root, use \`ls("${workspacePath}")\`
- Always use full absolute paths for all file operations
`

  return workingDirSection + BASE_SYSTEM_PROMPT
}

// Per-thread checkpointer cache
const checkpointers = new Map<string, SqlJsSaver>()

export async function getCheckpointer(threadId: string): Promise<SqlJsSaver> {
  let checkpointer = checkpointers.get(threadId)
  if (!checkpointer) {
    const dbPath = getThreadCheckpointPath(threadId)
    checkpointer = new SqlJsSaver(dbPath)
    await checkpointer.initialize()
    checkpointers.set(threadId, checkpointer)
  }
  return checkpointer
}

export async function closeCheckpointer(threadId: string): Promise<void> {
  const checkpointer = checkpointers.get(threadId)
  if (checkpointer) {
    await checkpointer.close()
    checkpointers.delete(threadId)
  }
}

// Get the model instance from custom model configuration
function getModelInstance(
  customConfig: {
    id: string
    model: string
    baseUrl: string
    apiKey?: string
  }
): ChatOpenAI {
  const apiKey = customConfig.apiKey
  if (!apiKey) {
    throw new Error("Custom API key not configured")
  }

  const resolvedModel = customConfig.model
  if (!resolvedModel.trim()) {
    throw new Error("Custom model name is empty. Please configure a valid model name in Settings.")
  }
  console.log("[Runtime] Custom model:", resolvedModel, "baseUrl:", customConfig.baseUrl)

  return new ChatOpenAI({
    model: resolvedModel,
    apiKey,
    configuration: {
      baseURL: customConfig.baseUrl
    }
  })
}

export interface CreateAgentRuntimeOptions {
  /** Thread ID - REQUIRED for per-thread checkpointing */
  threadId: string
  /** Optional model ID from thread/runtime config */
  modelId?: string
  /** Workspace path - REQUIRED for agent to operate on files */
  workspacePath: string
}

// Create agent runtime with configured model and checkpointer
export type AgentRuntime = ReturnType<typeof createAgent>

export async function createAgentRuntime(options: CreateAgentRuntimeOptions) {
  const { threadId, workspacePath, modelId } = options

  if (!threadId) {
    throw new Error("Thread ID is required for checkpointing.")
  }

  if (!workspacePath) {
    throw new Error(
      "Workspace path is required. Please select a workspace folder before running the agent."
    )
  }

  console.log("[Runtime] Creating agent runtime...")
  console.log("[Runtime] Thread ID:", threadId)
  console.log("[Runtime] Workspace path:", workspacePath)

  const selectedModelId = modelId?.startsWith("custom:") ? modelId.slice("custom:".length) : undefined

  const allCustomConfigs = getCustomModelConfigs()
  const customConfig = selectedModelId
    ? (allCustomConfigs.find((item) => item.id === selectedModelId) ||
      allCustomConfigs.find((item) => item.model === selectedModelId) ||
      null)
    : (allCustomConfigs[0] ?? null)
  if (!customConfig) {
    throw new Error("Custom model not configured. Please configure a model in Settings.")
  }

  const model = getModelInstance(customConfig)
  console.log("[Runtime] Model instance created")

  const checkpointer = await getCheckpointer(threadId)
  console.log("[Runtime] Checkpointer ready for thread:", threadId)

  const maxTokens = customConfig?.maxTokens ?? DEFAULT_MAX_TOKENS
  // Tune shell output cap for 32K~64K context windows to reduce context pressure.
  const maxOutputBytes = Math.max(30_000, Math.min(80_000, Math.floor(maxTokens * 4 * 0.2)))
  const backend = new LocalSandbox({
    rootDir: workspacePath,
    virtualMode: false,
    timeout: 120_000,
    maxOutputBytes
  })

  const systemPrompt = getSystemPrompt(workspacePath)

  const isWindows = process.platform === "win32"
  const platform = isWindows ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"
  const shell = isWindows ? "PowerShell" : process.env.SHELL?.split("/").pop() || "bash"

  const filesystemSystemPrompt = `You have access to a filesystem. All file paths use fully qualified absolute system paths.

### System Environment
- Operating system: ${platform} (${process.arch})
- Default shell: ${shell}
${isWindows ? "- Use PowerShell syntax for shell commands (e.g., Get-ChildItem instead of ls, Get-Content instead of cat)" : "- Use Unix commands for shell operations (ls, cat, grep, etc.)"}

### Available Tools
- ls: list files in a directory (e.g., ls("${workspacePath}"))
- read_file: read a file from the filesystem
- write_file: write to a file in the filesystem
- edit_file: edit a file in the filesystem
- glob: find files matching a pattern (e.g., "**/*.py")
- grep: search for text within files

The workspace root is: ${workspacePath}`

  const skillsSources = getSkillsSources()
  console.log("[Runtime] Skills sources:", skillsSources)

  const triggerTokens = Math.floor(maxTokens * 0.75)
  const keepTokens = Math.max(Math.floor(maxTokens * 0.08), 4_000)
  const toolEvictLimit = Math.min(6_000, Math.max(Math.floor(maxTokens * 0.05), 3_000))
  const trimForSummary = Math.min(12_000, Math.floor(maxTokens * 0.25))
  console.log("[Runtime] Context window:", maxTokens, "→ summarization trigger:", triggerTokens, "→ keep:", keepTokens, "→ tool evict limit:", toolEvictLimit, "→ trim for summary:", trimForSummary, "→ max output bytes:", maxOutputBytes)

  const agent = createDeepAgent({
    model,
    checkpointer,
    backend,
    systemPrompt,
    filesystemSystemPrompt,
    skills: skillsSources.length > 0 ? skillsSources : undefined,
    interruptOn: { execute: true },
    summarizationTrigger: { type: "tokens", value: triggerTokens },
    summarizationKeep: { type: "tokens", value: keepTokens },
    toolTokenLimitBeforeEvict: toolEvictLimit,
    trimTokensToSummarize: trimForSummary
  })

  console.log("[Runtime] Agent created with LocalSandbox at:", workspacePath)
  return agent
}

export type DeepAgent = ReturnType<typeof createAgent>

// Clean up all checkpointer resources
export async function closeRuntime(): Promise<void> {
  const closePromises = Array.from(checkpointers.values()).map((cp) => cp.close())
  await Promise.all(closePromises)
  checkpointers.clear()
}
