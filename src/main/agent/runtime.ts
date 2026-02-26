/* eslint-disable @typescript-eslint/no-unused-vars */
import { createDeepAgent } from "deepagents"
import {
  getThreadCheckpointPath,
  getSkillsSources,
  getCustomModelConfigs,
  DEFAULT_MAX_TOKENS
} from "../storage"

import { ChatOpenAI } from "@langchain/openai"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { LocalSandbox } from "./local-sandbox"
import { summarizationMiddleware } from "langchain"

import type * as _lcTypes from "langchain"
import type * as _lcMessages from "@langchain/core/messages"
import type * as _lcLanggraph from "@langchain/langgraph"
import type * as _lcZodTypes from "@langchain/core/utils/types"

import { BASE_SYSTEM_PROMPT } from "./system-prompt"

/**
 * Generate the full system prompt for the agent.
 *
 * @param workspacePath - The workspace path the agent is operating in
 * @returns The complete system prompt
 */
function getSystemPrompt(workspacePath: string): string {
  const workingDirSection = `
### File System and Paths

**IMPORTANT - Path Handling:**
- All file paths use fully qualified absolute system paths
- The workspace root is: \`${workspacePath}\`
- Example: \`${workspacePath}/src/index.ts\`, \`${workspacePath}/README.md\`
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
export type AgentRuntime = ReturnType<typeof createDeepAgent>

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

  const backend = new LocalSandbox({
    rootDir: workspacePath,
    virtualMode: false, // Use absolute system paths for consistency with shell commands
    timeout: 120_000, // 2 minutes
    maxOutputBytes: 100_000 // ~100KB
  })

  const systemPrompt = getSystemPrompt(workspacePath)

  // Custom filesystem prompt for absolute paths (matches virtualMode: false)
  const filesystemSystemPrompt = `You have access to a filesystem. All file paths use fully qualified absolute system paths.

- ls: list files in a directory (e.g., ls("${workspacePath}"))
- read_file: read a file from the filesystem
- write_file: write to a file in the filesystem
- edit_file: edit a file in the filesystem
- glob: find files matching a pattern (e.g., "**/*.py")
- grep: search for text within files

The workspace root is: ${workspacePath}`

  const skillsSources = getSkillsSources()
  console.log("[Runtime] Skills sources:", skillsSources)

  const maxTokens = customConfig?.maxTokens ?? DEFAULT_MAX_TOKENS
  const summarizationTrigger = Math.floor(maxTokens * 0.85)
  console.log("[Runtime] Context window:", maxTokens, "→ summarization trigger:", summarizationTrigger)

  const customSummarization = summarizationMiddleware({
    model,
    trigger: { tokens: summarizationTrigger },
    keep: { messages: 6 },
    trimTokensToSummarize: 10_000
  }) as ReturnType<typeof summarizationMiddleware> & { name: string }
  customSummarization.name = "CustomSummarizationMiddleware"

  const agent = createDeepAgent({
    model,
    checkpointer,
    backend,
    systemPrompt,
    filesystemSystemPrompt,
    interruptOn: { execute: true },
    skills: skillsSources.length > 0 ? skillsSources : undefined,
    middleware: [customSummarization]
  } as Parameters<typeof createDeepAgent>[0])

  console.log("[Runtime] Deep agent created with LocalSandbox at:", workspacePath)
  return agent
}

export type DeepAgent = ReturnType<typeof createDeepAgent>

// Clean up all checkpointer resources
export async function closeRuntime(): Promise<void> {
  const closePromises = Array.from(checkpointers.values()).map((cp) => cp.close())
  await Promise.all(closePromises)
  checkpointers.clear()
}
