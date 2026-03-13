/**
 * Execution Trace Types
 *
 * These types define the schema for recording agent execution traces.
 * Traces are used by the offline optimizer (SkillOptimizer) to understand
 * what the agent did, how many steps it took, and whether it succeeded.
 *
 * Inspired by GEPA (Gradient-free Evolution of Prompt Agents, ICLR 2026).
 *
 * NOTE: The actual trace *upload* / *reporting* path is intentionally left as
 * a stub — `TraceReporter` exposes the interface but the implementation is a
 * no-op.  Traces are written to local JSONL files only.
 */

// ─────────────────────────────────────────────────────────
// Primitive building blocks
// ─────────────────────────────────────────────────────────

/** A single tool invocation captured within a trace step. */
export interface TraceToolCall {
  /** Tool name, e.g. "read_file", "manage_skill" */
  name: string
  /** Raw arguments passed to the tool */
  args: Record<string, unknown>
  /** Tool result (string representation, may be truncated) */
  result?: string
  /** Wall-clock time in ms for this tool call */
  durationMs?: number
}

/** One reasoning step (one model message + its tool calls). */
export interface TraceStep {
  /** Step index within the trace (0-based) */
  index: number
  /** ISO timestamp when the model started this step */
  startedAt: string
  /** The assistant's text reasoning for this step (may be empty) */
  assistantText: string
  /** All tool calls made during this step */
  toolCalls: TraceToolCall[]
}

/** How the agent's run ended. */
export type TraceOutcome =
  | "success"   // Agent completed the task and said so
  | "error"     // Runtime / uncaught exception
  | "cancelled" // User cancelled mid-run
  | "unknown"   // Stream ended without a clear signal

// ─────────────────────────────────────────────────────────
// The top-level Trace record
// ─────────────────────────────────────────────────────────

/**
 * One complete execution trace for a single agent invocation.
 *
 * Written as a single JSON line to:
 *   ~/.cmbcoworkagent/traces/{threadId}/{traceId}.jsonl
 */
export interface AgentTrace {
  /** Unique trace ID (UUID v4) */
  traceId: string
  /** Thread the trace belongs to */
  threadId: string
  /** ISO timestamp when the run started */
  startedAt: string
  /** ISO timestamp when the run ended */
  endedAt: string
  /** Total wall-clock time in ms */
  durationMs: number
  /** The user message that triggered this run */
  userMessage: string
  /** Model identifier used for this run */
  modelId: string
  /** Ordered list of reasoning steps */
  steps: TraceStep[]
  /** Total number of tool calls across all steps */
  totalToolCalls: number
  /** How the run ended */
  outcome: TraceOutcome
  /** Any error message if outcome === 'error' */
  errorMessage?: string
  /** Which skills were active/loaded for this run */
  activeSkills: string[]
  /**
   * Optional free-form metadata.
   * Future: workspacePath, git branch, session tags, etc.
   */
  metadata?: Record<string, unknown>
}

// ─────────────────────────────────────────────────────────
// Trace reporter interface (stub — not yet implemented)
// ─────────────────────────────────────────────────────────

/**
 * Interface for remote trace reporting.
 *
 * The design intentionally separates local collection (always enabled)
 * from remote reporting (opt-in, not yet implemented).
 *
 * When implementing remote upload:
 *   1. Create a class that implements `ITraceReporter`
 *   2. Call `setTraceReporter(myReporter)` in app startup
 *   3. The collector will call `reporter.report(trace)` after each run
 */
export interface ITraceReporter {
  /**
   * Report a completed trace to a remote endpoint.
   * Should not throw — failures must be handled internally.
   */
  report(trace: AgentTrace): Promise<void>
}

/**
 * No-op reporter used by default.
 * Satisfies the interface but does nothing.
 */
export class NoopTraceReporter implements ITraceReporter {
  async report(_trace: AgentTrace): Promise<void> {
    // Intentionally empty — remote reporting not yet implemented
  }
}
