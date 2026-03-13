/**
 * Agent Trace Collector
 *
 * Collects execution data during a single agent run and writes the completed
 * trace to a local JSONL file.  Remote reporting is delegated to an
 * ITraceReporter (default: NoopTraceReporter).
 *
 * Usage (from ipc/agent.ts):
 *
 *   const tracer = new TraceCollector(threadId, userMessage, modelId)
 *   tracer.beginStep()
 *   tracer.recordToolCall({ name, args, result, durationMs })
 *   tracer.endStep(assistantText)
 *   await tracer.finish("success")
 */

import { join } from "path"
import { homedir } from "os"
import { mkdirSync, appendFileSync } from "fs"
import { v4 as uuid } from "uuid"
import type {
  AgentTrace,
  TraceStep,
  TraceToolCall,
  TraceOutcome,
  ITraceReporter
} from "./types"
import { NoopTraceReporter } from "./types"

// ─────────────────────────────────────────────────────────
// Global reporter registry
// ─────────────────────────────────────────────────────────

let _reporter: ITraceReporter = new NoopTraceReporter()

/** Replace the global reporter (call at app startup for remote upload). */
export function setTraceReporter(reporter: ITraceReporter): void {
  _reporter = reporter
}

export function getTraceReporter(): ITraceReporter {
  return _reporter
}

// ─────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────

const OPENWORK_DIR = join(homedir(), ".cmbcoworkagent")
const TRACES_DIR = join(OPENWORK_DIR, "traces")

function getThreadTracesDir(threadId: string): string {
  return join(TRACES_DIR, threadId)
}

function writeTraceFile(trace: AgentTrace): void {
  try {
    const dir = getThreadTracesDir(trace.threadId)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${trace.traceId}.jsonl`)
    appendFileSync(filePath, JSON.stringify(trace) + "\n", "utf-8")
    console.log(`[Tracer] Written trace ${trace.traceId} to ${filePath}`)
  } catch (e) {
    console.warn("[Tracer] Failed to write trace file:", e)
  }
}

// ─────────────────────────────────────────────────────────
// TraceCollector class
// ─────────────────────────────────────────────────────────

export class TraceCollector {
  private readonly traceId: string
  private readonly threadId: string
  private readonly startedAt: string
  private readonly userMessage: string
  private modelId: string

  private steps: TraceStep[] = []
  private activeSkills: string[] = []

  /** The step currently being built (between beginStep / endStep). */
  private currentStepIndex = 0
  private currentStepStartedAt: string = new Date().toISOString()
  private currentToolCalls: TraceToolCall[] = []

  constructor(threadId: string, userMessage: string, modelId: string) {
    this.traceId = uuid()
    this.threadId = threadId
    this.userMessage = userMessage
    this.modelId = modelId
    this.startedAt = new Date().toISOString()
  }

  /** Update the modelId (can be resolved after construction). */
  setModelId(id: string): void {
    this.modelId = id
  }

  /** Set which skills were loaded for this run. */
  setActiveSkills(skills: string[]): void {
    this.activeSkills = [...skills]
  }

  /**
   * Called when the model starts producing a new message
   * (i.e. before tool calls for that step are known).
   */
  beginStep(): void {
    this.currentStepStartedAt = new Date().toISOString()
    this.currentToolCalls = []
  }

  /** Record a tool call within the current step. */
  recordToolCall(call: TraceToolCall): void {
    this.currentToolCalls.push(call)
  }

  /**
   * Called after the model message + its tool calls are complete.
   * @param assistantText - The assistant's text reasoning for this step.
   */
  endStep(assistantText: string): void {
    const step: TraceStep = {
      index: this.currentStepIndex++,
      startedAt: this.currentStepStartedAt,
      assistantText,
      toolCalls: [...this.currentToolCalls]
    }
    this.steps.push(step)
    this.currentToolCalls = []
  }

  /**
   * Finalize the trace, write to disk, and (optionally) report remotely.
   * Safe to call multiple times — only the first call takes effect.
   */
  async finish(outcome: TraceOutcome, errorMessage?: string): Promise<AgentTrace> {
    const endedAt = new Date().toISOString()
    const durationMs = Date.now() - new Date(this.startedAt).getTime()
    const totalToolCalls = this.steps.reduce((sum, s) => sum + s.toolCalls.length, 0)

    const trace: AgentTrace = {
      traceId: this.traceId,
      threadId: this.threadId,
      startedAt: this.startedAt,
      endedAt,
      durationMs,
      userMessage: this.userMessage,
      modelId: this.modelId,
      steps: this.steps,
      totalToolCalls,
      outcome,
      ...(errorMessage ? { errorMessage } : {}),
      activeSkills: this.activeSkills
    }

    writeTraceFile(trace)

    try {
      await _reporter.report(trace)
    } catch (e) {
      console.warn("[Tracer] Reporter.report() threw:", e)
    }

    return trace
  }
}

// ─────────────────────────────────────────────────────────
// Trace reading utilities (used by optimizer)
// ─────────────────────────────────────────────────────────

import { readdirSync, readFileSync, existsSync } from "fs"

/** List all threadIds that have trace files. */
export function listTracedThreads(): string[] {
  if (!existsSync(TRACES_DIR)) return []
  try {
    return readdirSync(TRACES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Read all traces for a given thread, sorted by startedAt ascending. */
export function readThreadTraces(threadId: string): AgentTrace[] {
  const dir = getThreadTracesDir(threadId)
  if (!existsSync(dir)) return []
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
    const traces: AgentTrace[] = []
    for (const file of files) {
      const raw = readFileSync(join(dir, file), "utf-8")
      for (const line of raw.trim().split("\n")) {
        if (!line.trim()) continue
        try {
          traces.push(JSON.parse(line) as AgentTrace)
        } catch { /* skip malformed lines */ }
      }
    }
    return traces.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  } catch {
    return []
  }
}

/** Read the N most recent traces across all threads. */
export function readRecentTraces(limit = 20): AgentTrace[] {
  const threads = listTracedThreads()
  const all: AgentTrace[] = []
  for (const t of threads) {
    all.push(...readThreadTraces(t))
  }
  return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
}

/** Return the traces directory path (for display purposes). */
export function getTracesDir(): string {
  return TRACES_DIR
}
