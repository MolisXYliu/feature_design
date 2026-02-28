/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createSkillsMiddleware,
  createMemoryMiddleware,
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
  summarizationMiddleware,
  anthropicPromptCachingMiddleware,
  humanInTheLoopMiddleware
} from "langchain"

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
 * Identical to the original except:
 *   1. `defaultInterruptOn` is always null — subagents run autonomously without HITL.
 *   2. `subagentSummarizationTrigger` — configurable summarization trigger for subagents
 *      (original hardcodes 170 000 tokens).
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
    subagentSummarizationTrigger = 170_000,
    toolTokenLimitBeforeEvict
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

  const skillsMiddleware =
    skills != null && skills.length > 0
      ? [createSkillsMiddleware({ backend: filesystemBackend, sources: skills })]
      : []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builtInMiddleware: any[] = [
    todoListMiddleware(),
    ...skillsMiddleware,
    createFilesystemMiddleware({
      backend: filesystemBackend,
      ...(filesystemSystemPrompt && { systemPrompt: filesystemSystemPrompt }),
      ...(toolTokenLimitBeforeEvict != null && { toolTokenLimitBeforeEvict })
    }),
    createSubAgentMiddleware({
      defaultModel: model,
      defaultTools: tools,
      defaultMiddleware: [
        todoListMiddleware(),
        ...skillsMiddleware,
        createFilesystemMiddleware({
          backend: filesystemBackend,
          ...(filesystemSystemPrompt && { systemPrompt: filesystemSystemPrompt }),
          ...(toolTokenLimitBeforeEvict != null && { toolTokenLimitBeforeEvict })
        }),
        summarizationMiddleware({
          model,
          trigger: { tokens: subagentSummarizationTrigger },
          keep: { messages: 6 },
          trimTokensToSummarize: 10_000
        }),
        anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
        createPatchToolCallsMiddleware()
      ],
      defaultInterruptOn: null, // FIX: subagents run without HITL
      subagents,
      generalPurposeAgent: true
    } as Parameters<typeof createSubAgentMiddleware>[0]),
    summarizationMiddleware({
      model,
      trigger: { tokens: subagentSummarizationTrigger },
      keep: { messages: 6 },
      trimTokensToSummarize: 10_000
    }),
    anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    createPatchToolCallsMiddleware(),
    ...(memory != null && memory.length > 0
      ? [createMemoryMiddleware({ backend: filesystemBackend, sources: memory })]
      : [])
  ]

  if (interruptOn) {
    builtInMiddleware.push(humanInTheLoopMiddleware({ interruptOn }))
  }

  return createAgent({
    model,
    systemPrompt: finalSystemPrompt,
    tools,
    middleware: [...builtInMiddleware, ...customMiddleware],
    responseFormat,
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
  const maxOutputBytes = maxTokens * 4 * 0.3
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

  const summarizationTrigger = Math.floor(maxTokens * 0.85)
  const toolEvictLimit = Math.floor(maxTokens * 0.1)
  console.log("[Runtime] Context window:", maxTokens, "→ summarization trigger:", summarizationTrigger, "→ tool evict limit:", toolEvictLimit, "→ max output bytes:", maxOutputBytes)

  const agent = createDeepAgent({
    model,
    checkpointer,
    backend,
    systemPrompt,
    filesystemSystemPrompt,
    skills: skillsSources.length > 0 ? skillsSources : undefined,
    interruptOn: { execute: true },
    subagentSummarizationTrigger: summarizationTrigger,
    toolTokenLimitBeforeEvict: toolEvictLimit
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
