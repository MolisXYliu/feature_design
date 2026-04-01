import { createHash, randomUUID } from "crypto"
import { tool } from "langchain"
import { z } from "zod"
import type { ApprovalDecision, ApprovalRequest } from "../../types"
import { CodeExecEngine } from "../../code-exec/engine"
import { LocalProcessRunner } from "../../code-exec/runner"
import type { CodeExecToolInput } from "../../code-exec/types"
import {
  buildSavedCodeExecToolDraft,
  hasSavedCodeExecToolForCode,
  persistSavedCodeExecTool
} from "../../code-exec/saved-tool-store"
import type { ApprovalStore } from "../approval-store"
import type { McpCapabilityService } from "../../mcp/capability-types"

const DEFAULT_TIMEOUT_MS = 20_000

const codeExecSchema = z.object({
  code: z.string().describe("JavaScript function-body code. Keep it reusable and read dynamic inputs from params."),
  params: z.object({}).passthrough().optional().describe("Dynamic input values exposed as params inside the script. Prefer passing user or context-specific values here."),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional().describe("Execution timeout in milliseconds.")
})

interface CodeExecToolContext {
  workspacePath: string
  threadId?: string
  yoloMode: boolean
  capabilityService: McpCapabilityService
  approvalStore?: ApprovalStore
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>
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
): void {
  const draft = buildSavedCodeExecToolDraft({
    code: input.code,
    params: input.params,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    output
  })

  if (hasSavedCodeExecToolForCode(input.code, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)) {
    persistSavedCodeExecTool(draft)
    return
  }

  if (context.yoloMode || !context.requestApproval) return

  void (async () => {
    try {
      const approval = await context.requestApproval?.({
        id: randomUUID(),
        tool_call: {
          id: randomUUID(),
          name: "save_code_exec_tool",
          args: {
            toolId: draft.toolId
          }
        },
        safety_level: "needs_approval",
        operation: "save_code_exec_tool",
        code: input.code,
        params: input.params ?? {},
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        savedToolId: draft.toolId,
        savedToolDescription: draft.description,
        cwd: context.workspacePath,
        reason: "脚本执行成功，是否提升为可复用工具",
        allowed_decisions: ["approve", "reject"],
        allowed_approval_types: ["approve", "reject"]
      })

      if (approval?.type === "approve") {
        persistSavedCodeExecTool(draft)
      }
    } catch (error) {
      console.warn("[code_exec] failed to prompt for tool promotion:", error)
    }
  })()
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
        maybePromoteCodeExecAsTool(context, input, result.output)
      }

      return result.output
    },
    {
      name: "code_exec",
      description:
        "Run a short JavaScript script body that can call enabled MCP tools through mcp.<provider>.<method>(). " +
        "Use load_tool first to inspect exact MCP signatures before authoring the script, and put changing inputs in params. " +
        "The tool always returns a single string result.",
      schema: codeExecSchema
    }
  )
}
