import { createHash, randomUUID } from "crypto"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { tool } from "langchain"
import { z } from "zod"
import type { ApprovalDecision, ApprovalRequest } from "../../types"
import { CodeExecEngine } from "../../code-exec/engine"
import { LocalProcessRunner } from "../../code-exec/runner"
import { analyzeCodeExecForSavedToolPromotion } from "../../code-exec/saved-tool-promotion"
import type { CodeExecToolInput } from "../../code-exec/types"
import {
  buildSavedCodeExecToolDraft,
  getSavedCodeExecToolForCode,
  persistSavedCodeExecTool
} from "../../code-exec/saved-tool-store"
import { getCustomModelConfigs, type CustomModelConfig } from "../../storage"
import type { ApprovalStore } from "../approval-store"
import type { McpCapabilityService } from "../../mcp/capability-types"

const DEFAULT_TIMEOUT_MS = 20_000
const TOOL_PROMOTION_BLOCKED_NOTE = "本次脚本未参数化，未保存为工具。"
const SAVED_TOOL_METADATA_SYSTEM_PROMPT = `You generate metadata for reusable lazy-loaded tools.

Return JSON only with this shape:
{
  "tool_name": "snake_case_capability_name",
  "description": "One sentence describing what the tool does and its main inputs."
}

Rules:
- Focus on the user-facing capability, not implementation details.
- Do not mention code_exec, saved tools, JavaScript, wrappers, or promotion.
- Do not include repository names, usernames, or other one-off values unless they are part of the reusable capability.
- Keep tool_name short, capability-oriented, and reusable.
- Keep description concise and optimized for search_tool discovery.`

const codeExecSchema = z.object({
  code: z.string().describe("JavaScript async function-body code. The runtime injects params for you, so read from params inside code and never declare or shadow a local params variable. Top-level params is the only source of run-specific values: if owner, repo, perPage, sort, filters, IDs, or query text appears in params, read it from params instead of repeating that value as a literal inside code. For each MCP call, first bind local variables from params or earlier MCP call results, then pass only those bound values into mcp.<provider>.<method>(args). Example inside code: const owner = params.owner; const repo = params.repo; const args = { owner, repo }; const result = await mcp.github.listPullRequests(args);"),
  params: z.object({}).passthrough().describe("Required top-level input object for code_exec. Put the concrete JSON values for this run here, not inside code. Include every external value that will appear in any MCP call, including values that look like defaults for this run such as sort, order, perPage, query fragments, filters, owner, repo, branch, and IDs. Example: { \"owner\": \"vllm-project\", \"repo\": \"vllm\", \"perPage\": 2 }. Then read them in code with params.owner, params.repo, and params.perPage."),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional().describe("Execution timeout in milliseconds.")
})

interface CodeExecToolContext {
  workspacePath: string
  threadId?: string
  modelId?: string
  yoloMode: boolean
  capabilityService: McpCapabilityService
  approvalStore?: ApprovalStore
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>
}

interface SavedToolMetadata {
  toolName: string
  description: string
}

function mapDecisionToReview(type: ApprovalDecision["type"]): "approved" | "approved_session" | "denied" {
  switch (type) {
    case "approve":
      return "approved"
    case "approve_session":
      return "approved_session"
    default:
      return "denied"
  }
}

async function requestCodeExecApproval(
  context: CodeExecToolContext,
  input: CodeExecToolInput
): Promise<boolean> {
  if (context.yoloMode) return true
  if (!context.approvalStore || !context.requestApproval) return true

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      code: input.code,
      params: input.params ?? {},
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      workspacePath: context.workspacePath
    }))
    .digest("hex")

  const key = context.approvalStore.makeKey(`code_exec:${fingerprint}`, context.workspacePath, "code_exec")
  const patternKey = `code_exec:${fingerprint}`

  const decision = await context.approvalStore.withCachedApproval(
    key,
    patternKey,
    async () => {
      const approval = await context.requestApproval?.({
        id: randomUUID(),
        tool_call: {
          id: randomUUID(),
          name: "code_exec",
          args: {
            code: input.code,
            params: input.params ?? {},
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS
          }
        },
        safety_level: "needs_approval",
        operation: "code_exec",
        code: input.code,
        params: input.params ?? {},
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        cwd: context.workspacePath,
        reason: "执行 code_exec 脚本需要审批",
        allowed_decisions: ["approve", "reject"],
        allowed_approval_types: ["approve", "approve_session", "reject"]
      })

      return mapDecisionToReview(approval?.type ?? "reject")
    },
    {
      allowPermanentMatch: false,
      allowPermanentStore: false,
      commandForPatternMatch: patternKey
    }
  )

  return decision !== "denied"
}

function maybePromoteCodeExecAsTool(
  context: CodeExecToolContext,
  input: CodeExecToolInput,
  output: string
): string {
  if (getSavedCodeExecToolForCode(input.code, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)) {
    return output
  }

  const promotion = analyzeCodeExecForSavedToolPromotion({
    code: input.code,
    params: input.params,
    output
  })

  if (promotion.status === "blocked") {
    return `${output}\n\n${TOOL_PROMOTION_BLOCKED_NOTE}`
  }

  if (context.yoloMode || !context.requestApproval) return output

  void (async () => {
    try {
      const prepareApproval = await context.requestApproval?.({
        id: randomUUID(),
        tool_call: {
          id: randomUUID(),
          name: "prepare_save_code_exec_tool",
          args: {}
        },
        safety_level: "needs_approval",
        operation: "prepare_save_code_exec_tool",
        code: input.code,
        params: input.params ?? {},
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        cwd: context.workspacePath,
        reason: "",
        allowed_decisions: ["approve", "reject"],
        allowed_approval_types: ["approve", "reject"]
      })

      if (prepareApproval?.type !== "approve") return

      const metadata = await generateSavedToolMetadata(context, {
        code: input.code,
        inputSchema: promotion.inputSchema,
        outputSchema: promotion.outputSchema,
        resultExample: promotion.resultExample,
        dependencies: promotion.dependencies
      })

      const metadataError = metadata
        ? undefined
        : "工具信息自动生成失败，请手动填写 toolName 和 description，或点拒绝关闭。"

      const draft = metadata
        ? buildSavedCodeExecToolDraft({
          toolName: metadata.toolName,
          description: metadata.description,
          inputSchema: promotion.inputSchema,
          outputSchema: promotion.outputSchema,
          code: input.code,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          dependencies: promotion.dependencies,
          resultExample: promotion.resultExample
        })
        : null

      const approval = await context.requestApproval?.({
        id: randomUUID(),
        tool_call: {
          id: randomUUID(),
          name: "save_code_exec_tool",
          args: draft?.toolId ? { toolId: draft.toolId } : {}
        },
        safety_level: "needs_approval",
        operation: "save_code_exec_tool",
        code: input.code,
        params: input.params ?? {},
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        savedToolName: metadata?.toolName ?? "",
        savedToolId: draft?.toolId,
        savedToolDescription: metadata?.description ?? "",
        savedToolMetadataError: metadataError,
        cwd: context.workspacePath,
        reason: metadataError
          ? "工具信息自动生成失败，请手动填写后决定是否保存"
          : "工具信息已生成，确认后保存为可复用工具",
        allowed_decisions: ["approve", "reject"],
        allowed_approval_types: ["approve", "reject"]
      })

      if (approval?.type === "approve") {
        const toolName = approval.savedToolName?.trim() || metadata?.toolName?.trim() || ""
        const description = approval.savedToolDescription?.trim() || metadata?.description?.trim() || ""
        if (!toolName || !description) {
          console.warn("[code_exec] save tool approval missing tool name or description")
          return
        }

        const finalDraft = buildSavedCodeExecToolDraft({
          toolName,
          description,
          inputSchema: promotion.inputSchema,
          outputSchema: promotion.outputSchema,
          code: input.code,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          dependencies: promotion.dependencies,
          resultExample: promotion.resultExample
        })

        persistSavedCodeExecTool({
          ...finalDraft,
          description
        })
      }
    } catch (error) {
      console.warn("[code_exec] failed to prompt for tool promotion:", error)
    }
  })()

  return output
}

function resolveSidecarModelConfig(selectedModelId?: string): CustomModelConfig | null {
  const configs = getCustomModelConfigs()
  const requestedId = selectedModelId?.startsWith("custom:") ? selectedModelId.slice("custom:".length) : selectedModelId
  return requestedId
    ? (configs.find((item) => item.id === requestedId) || configs.find((item) => item.model === requestedId) || configs[0] || null)
    : (configs[0] ?? null)
}

function extractResponseText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text
        }
        return ""
      })
      .join("")
  }
  return ""
}

function parseSavedToolMetadata(raw: string): SavedToolMetadata | null {
  const candidates = (() => {
    const trimmed = raw.trim()
    if (!trimmed) return []

    const results = [trimmed]
    const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    if (fencedMatch?.[1]) {
      results.push(fencedMatch[1].trim())
    }

    const firstBrace = trimmed.indexOf("{")
    const lastBrace = trimmed.lastIndexOf("}")
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      results.push(trimmed.slice(firstBrace, lastBrace + 1).trim())
    }

    return Array.from(new Set(results.filter(Boolean)))
  })()

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const toolName = typeof parsed.tool_name === "string" ? parsed.tool_name.trim() : ""
      const description = typeof parsed.description === "string" ? parsed.description.trim() : ""
      if (!toolName || !description) continue
      return {
        toolName,
        description
      }
    } catch {
      continue
    }
  }

  return null
}

async function generateSavedToolMetadata(
  context: CodeExecToolContext,
  input: {
    code: string
    inputSchema: Record<string, unknown>
    outputSchema?: Record<string, unknown>
    resultExample?: unknown
    dependencies: string[]
  }
): Promise<SavedToolMetadata | null> {
  const config = resolveSidecarModelConfig(context.modelId)
  if (!config?.apiKey) {
    console.warn("[code_exec] skipped saved-tool metadata generation: missing model config or API key")
    return null
  }

  const model = new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: 512,
    temperature: 0,
    streaming: false
  })

  const userPrompt = JSON.stringify({
    code: input.code,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema ?? null,
    resultExample: input.resultExample ?? null,
    dependencies: input.dependencies
  }, null, 2)

  try {
    const response = await model.invoke(
      [
        new SystemMessage(SAVED_TOOL_METADATA_SYSTEM_PROMPT),
        new HumanMessage(userPrompt)
      ],
      { callbacks: [] }
    )
    const raw = extractResponseText(response.content).trim()
    const metadata = parseSavedToolMetadata(raw)
    if (!metadata) {
      console.warn("[code_exec] failed to parse saved-tool metadata response:", raw.slice(0, 200))
      return null
    }
    return metadata
  } catch (error) {
    console.warn("[code_exec] failed to generate saved-tool metadata:", error)
    return null
  }
}

export function createCodeExecTool(context: CodeExecToolContext) {
  const engine = new CodeExecEngine(new LocalProcessRunner(context.capabilityService))

  return tool(
    async (input) => {
      const approved = await requestCodeExecApproval(context, input)
      if (!approved) {
        return "Code execution rejected by user."
      }

      const result = await engine.execute({
        code: input.code,
        params: input.params,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        workspacePath: context.workspacePath,
        threadId: context.threadId
      })

      if (result.ok) {
        return maybePromoteCodeExecAsTool(context, input, result.output)
      }

      return result.output
    },
    {
      name: "code_exec",
      description:
        "Run a short JavaScript script body that can call MCP tools through mcp.<provider>.<method>(). " +
        "All variables derived from the context and user input must be passed into the script via `params`. Hardcoding values directly into the code is strictly prohibited" +
        "Correct example: params={\"owner\":\"vllm-project\",\"repo\":\"vllm\"}, code='const owner = params.owner; const repo = params.repo; const result = await mcp.github.listPullRequests({ owner, repo }); return JSON.stringify(result, null, 2);'. " +
        "Wrong example: params={}, code='const result = await mcp.github.listPullRequests({ owner: \"vllm-project\", repo: \"vllm\" }); return JSON.stringify(result, null, 2);'. " +
        "The tool always returns a single string result.",
      schema: codeExecSchema
    }
  )
}
