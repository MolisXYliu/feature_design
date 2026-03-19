/**
 * Tool Orchestrator: approval + sandbox + retry pipeline.
 *
 * Sits between the agent framework and LocalSandbox's raw execute method.
 * Handles:
 *   1. Command safety assessment
 *   2. Cached / interactive approval
 *   3. Sandbox execution
 *   4. Sandbox-denial → ask user → unsandboxed retry
 */

import { randomUUID } from "crypto"
import { ApprovalStore } from "./approval-store"
import { assessCommandSafety, derivePermanentApprovalPattern } from "./exec-policy"
import type {
  ApprovalRequest,
  ApprovalDecision,
  ReviewDecision,
  ApprovalDecisionType
} from "../types"
import type { ExecuteResponse } from "deepagents"

/** Raw execution function signature (no approval logic). */
export type RawExecuteFn = (command: string, sandboxMode?: string) => Promise<ExecuteResponse>

/** Function to request interactive approval from the user (renderer). */
export type RequestApprovalFn = (req: ApprovalRequest) => Promise<ApprovalDecision>

export class ToolOrchestrator {
  constructor(
    private approvalStore: ApprovalStore,
    private rawExecute: RawExecuteFn,
    private requestApproval: RequestApprovalFn,
    private yoloMode: boolean = false
  ) {}

  /**
   * Execute a command through the full approval + sandbox pipeline.
   *
   * @param command      Shell command string
   * @param cwd          Working directory
   * @param sandboxMode  Current sandbox mode (none/unelevated/elevated/readonly)
   */
  async execute(command: string, cwd: string, sandboxMode: string): Promise<ExecuteResponse> {
    console.log(`[Orchestrator] execute: "${command}" cwd=${cwd} sandbox=${sandboxMode} yolo=${this.yoloMode}`)

    // 1. Assess command safety — always check, even in YOLO mode
    const safety = assessCommandSafety(command, cwd, {
      windowsShell: process.platform === "win32" && sandboxMode !== "none" ? "powershell" : "unknown"
    })
    console.log(`[Orchestrator] safety: ${safety.level}${safety.reason ? ` (${safety.reason})` : ""}`)

    // 2. Forbidden commands → reject immediately, regardless of YOLO mode
    if (safety.level === "forbidden") {
      return {
        output: `Command forbidden: ${safety.reason}`,
        exitCode: 1,
        truncated: false
      }
    }

    // 3. YOLO mode: skip approval for safe + needs_approval commands
    if (this.yoloMode) {
      return this.rawExecute(command, sandboxMode)
    }

    // 4. Safe commands → execute directly
    if (safety.level === "safe") {
      console.log("[Orchestrator] safe → rawExecute")
      return this.rawExecute(command, sandboxMode)
    }

    // 5. Needs approval → check cache, then ask user
    const key = this.approvalStore.makeKey(command, cwd, sandboxMode)
    const patternKey = derivePermanentApprovalPattern(command) ?? this.approvalStore.makePatternKey(command)
    const allowPermanentApproval = patternKey !== this.approvalStore.makePatternKey(command)

    console.log("[Orchestrator] needs_approval → requesting user approval...")

    const decision = await this.approvalStore.withCachedApproval(
      key,
      patternKey,
      async (): Promise<ReviewDecision> => {
        const approval = await this.requestApproval({
          id: randomUUID(),
          tool_call: { id: randomUUID(), name: "execute", args: { command } },
          safety_level: "needs_approval",
          command,
          cwd,
          reason: safety.reason,
          allowed_decisions: ["approve", "reject"],
          allowed_approval_types: allowPermanentApproval
            ? ["approve", "approve_session", "approve_permanent", "reject"]
            : ["approve", "approve_session", "reject"]
        })
        return this.mapDecisionToReview(approval.type)
      },
      {
        allowPermanentMatch: allowPermanentApproval,
        allowPermanentStore: allowPermanentApproval,
        commandForPatternMatch: command
      }
    )

    if (decision === "denied" || decision === "abort") {
      return {
        output: "Command rejected by user.",
        exitCode: 1,
        truncated: false
      }
    }

    // 5. Execute (with sandbox)
    try {
      const result = await this.rawExecute(command, sandboxMode)
      if (sandboxMode !== "none" && this.isSandboxDeniedResponse(result)) {
        return this.handleSandboxRetry(command, cwd, result.output)
      }
      return result
    } catch (err) {
      // 6. Sandbox denial → offer unsandboxed retry
      if (sandboxMode !== "none" && this.isSandboxDenialError(err)) {
        return this.handleSandboxRetry(
          command,
          cwd,
          `沙箱阻止了此操作: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      throw err
    }
  }

  /** Map renderer decision type to ReviewDecision. */
  private mapDecisionToReview(type: ApprovalDecisionType): ReviewDecision {
    switch (type) {
      case "approve": return "approved"
      case "approve_session": return "approved_session"
      case "approve_permanent": return "approved_permanent"
      case "reject": return "denied"
      default: return "denied"
    }
  }

  /** Check if an error looks like a sandbox permission denial. */
  private isSandboxDenialError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    const msg = err.message.toLowerCase()
    return (
      msg.includes("access is denied") ||
      msg.includes("permission denied") ||
      msg.includes("operation not permitted") ||
      msg.includes("sandbox")
    )
  }

  private isSandboxDeniedResponse(result: ExecuteResponse): boolean {
    if (result.exitCode === 0) return false
    const msg = (result.output ?? "").toLowerCase()
    return (
      msg.includes("access is denied") ||
      msg.includes("permission denied") ||
      msg.includes("operation not permitted") ||
      msg.includes("blocked by policy") ||
      msg.includes("setup refresh failed") ||
      msg.includes("沙箱") ||
      msg.includes("sandbox")
    )
  }

  private async handleSandboxRetry(
    command: string,
    cwd: string,
    retryReason: string
  ): Promise<ExecuteResponse> {
    const retryApproval = await this.requestApproval({
      id: randomUUID(),
      tool_call: { id: randomUUID(), name: "execute", args: { command } },
      safety_level: "needs_approval",
      command,
      cwd,
      retry_reason: retryReason,
      allowed_decisions: ["approve", "reject"],
      allowed_approval_types: ["approve", "reject"]
    })

    if (retryApproval.type === "approve") {
      return this.rawExecute(command, "none")
    }

    return {
      output: "Sandbox retry rejected by user.",
      exitCode: 1,
      truncated: false
    }
  }
}
