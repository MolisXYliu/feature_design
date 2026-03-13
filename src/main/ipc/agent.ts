import { IpcMain, BrowserWindow } from "electron"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import {
  createAgentRuntime,
  incrementToolCallCount,
  getToolCallCount,
  resetToolCallCount,
  SKILL_EVOLUTION_THRESHOLD
} from "../agent/runtime"
import { getThread } from "../db"
import { summarizeAndSave } from "../memory/summarizer"
import { getMemoryStore } from "../memory/store"
import { ChatOpenAI } from "@langchain/openai"
import { getCustomModelConfigs, isMemoryEnabled, getCustomSkillsDir, invalidateEnabledSkillsCache, isSkillAutoProposeEnabled } from "../storage"
import { notifyIfBackground } from "../services/notify"
import { TraceCollector } from "../agent/trace/collector"
import {
  requestSkillIntent,
  requestSkillConfirmation,
  sanitizeSkillId
} from "../agent/tools/skill-evolution-tool"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { v4 as uuid } from "uuid"
import type {
  AgentInvokeParams,
  AgentResumeParams,
  AgentInterruptParams,
  AgentCancelParams
} from "../types"

const MIN_CHARS_FOR_MEMORY = 200

// Track active runs for cancellation
const activeRuns = new Map<string, AbortController>()

// ─────────────────────────────────────────────────────────
// Auto skill proposal: generate a skill from conversation context
// ─────────────────────────────────────────────────────────

const SKILL_PROPOSAL_SYSTEM_PROMPT = `You are an expert at capturing reusable agent skills from conversation history.

Given a conversation between a user and an AI agent, your job is to extract a reusable skill.

Output ONLY valid JSON (no markdown, no explanation) with this exact shape:
{
  "name": "Short Human-Readable Name (3-6 words)",
  "skillId": "snake_case_identifier",
  "description": "One sentence: WHEN should this skill be loaded? Be specific about the trigger scenario.",
  "content": "Full SKILL.md content (including YAML frontmatter)"
}

SKILL.md format:
---
name: skill-name
description: Trigger description
version: 1.0.0
---

# Overview
Brief description.

## When to use
Specific situations.

## Steps / Guidelines
Concrete instructions for the agent.

Rules:
- description is the MOST important — it controls when the skill is injected
- Make it specific: describe the exact user intent that should trigger it
- Focus on REUSABLE patterns, not one-time tasks
- Output ONLY valid JSON, no other text`

/**
 * Broadcast a skill generation progress event to all renderer windows.
 * `phase`:
 *   "start"    — generation beginning (clears previous output)
 *   "token"    — incremental token chunk
 *   "done"     — generation complete, full raw text in `text`
 *   "error"    — generation failed
 */
function emitSkillGenerating(
  phase: "start" | "token" | "done" | "error",
  text = ""
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("skill:generating", { phase, text })
  }
}

/**
 * Use the default configured LLM to generate a skill proposal from the
 * given conversation context.  Streams tokens to the renderer via
 * `skill:generating` events so the user can see progress in real time.
 * Returns null if no model is configured or the LLM response cannot be parsed.
 */
async function generateSkillProposal(
  userMessage: string,
  assistantText: string,
  toolCallSummary: string
): Promise<{ name: string; skillId: string; description: string; content: string } | null> {
  const configs = getCustomModelConfigs()
  const config = configs[0]
  if (!config?.apiKey) return null

  const model = new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: 2048,
    temperature: 0.3,
    streaming: true
  })

  const userPrompt = `# Conversation to analyze

## User request
${userMessage.slice(0, 500)}

## Agent response (summary)
${assistantText.slice(0, 800)}

## Tools used
${toolCallSummary}

Based on this conversation, generate a reusable skill. Output JSON only.`

  try {
    emitSkillGenerating("start")

    let fullText = ""
    const stream = await model.stream([
      new SystemMessage(SKILL_PROPOSAL_SYSTEM_PROMPT),
      new HumanMessage(userPrompt)
    ])

    for await (const chunk of stream) {
      const token = typeof chunk.content === "string"
        ? chunk.content
        : ""
      if (token) {
        fullText += token
        emitSkillGenerating("token", token)
      }
    }

    emitSkillGenerating("done", fullText)

    // Strip <think>...</think> reasoning blocks (deepseek-r1 and similar models)
    // then strip markdown fences if present
    const cleaned = fullText
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^```json\s*/im, "")
      .replace(/^```\s*/im, "")
      .replace(/```\s*$/im, "")
      .trim()

    const parsed = JSON.parse(cleaned) as { name?: string; skillId?: string; description?: string; content?: string }
    if (!parsed.name || !parsed.skillId || !parsed.description || !parsed.content) return null
    return parsed as { name: string; skillId: string; description: string; content: string }
  } catch (e) {
    console.warn("[Agent] Failed to generate skill proposal:", e)
    emitSkillGenerating("error", e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * Write an approved skill proposal to disk and notify the renderer.
 */
async function writeSkillToDisk(skillId: string, content: string, name: string): Promise<void> {
  const skillDir = join(getCustomSkillsDir(), skillId)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8")
  invalidateEnabledSkillsCache()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("skills:changed")
  }
  console.log(`[Agent] Wrote skill "${name}" to ${skillDir}`)
}

/**
 * After a conversation meets the threshold, this function runs as a
 * fire-and-forget async task.
 *
 * MODE A — auto-propose ON (default):
 *   1. Send `skill:intentRequest` → lightweight banner asks "Want to save as skill?"
 *   2. User clicks YES → call LLM to generate skill proposal
 *   3. Send `skill:confirmRequest` → full detail dialog (name/desc/content)
 *   4. User "Adopt" → write to disk
 *
 * MODE B — auto-propose OFF:
 *   1. Call LLM directly to judge whether this conversation warrants a skill
 *   2. If LLM says yes → send `skill:confirmRequest` → full detail dialog
 *   3. User "Adopt" → write to disk
 */
async function autoProposeSKill(
  threadId: string,
  userMessage: string,
  assistantText: string,
  toolCallNames: string[]
): Promise<void> {
  const toolCallSummary = toolCallNames.length > 0
    ? toolCallNames.join(", ")
    : "(none)"

  if (isSkillAutoProposeEnabled()) {
    // ── Mode A: ask human first, then generate ───────────────────
    console.log(`[Agent][ModeA] Thread ${threadId}: asking user intent (${toolCallNames.length} tool calls)`)

    const intentId = uuid()
    const wantsSkill = await requestSkillIntent({
      requestId: intentId,
      summary: userMessage.slice(0, 120),
      toolCallCount: toolCallNames.length
    })

    if (!wantsSkill) {
      console.log("[Agent][ModeA] User declined skill intent")
      return
    }

    // User said yes — now generate the skill content with LLM
    console.log("[Agent][ModeA] User confirmed intent, generating skill proposal…")
    const proposal = await generateSkillProposal(userMessage, assistantText, toolCallSummary)
    if (!proposal) {
      console.log("[Agent][ModeA] Could not generate skill proposal (no model or parse error)")
      return
    }

    const skillId = sanitizeSkillId(proposal.skillId || proposal.name)
    if (!skillId) return

    const confirmId = uuid()
    const adopted = await requestSkillConfirmation({
      requestId: confirmId,
      skillId,
      name: proposal.name,
      description: proposal.description,
      content: proposal.content
    })

    if (!adopted) {
      console.log(`[Agent][ModeA] User rejected skill detail for "${proposal.name}"`)
      return
    }

    await writeSkillToDisk(skillId, proposal.content, proposal.name)

  } else {
    // ── Mode B: let LLM decide first, then ask human ─────────────
    console.log(`[Agent][ModeB] Thread ${threadId}: calling LLM to judge skill worthiness`)

    const proposal = await generateSkillProposal(userMessage, assistantText, toolCallSummary)
    if (!proposal) {
      console.log("[Agent][ModeB] LLM declined or failed to generate a skill proposal")
      return
    }

    const skillId = sanitizeSkillId(proposal.skillId || proposal.name)
    if (!skillId) return

    console.log(`[Agent][ModeB] LLM proposed skill "${proposal.name}", asking user to adopt`)
    const confirmId = uuid()
    const adopted = await requestSkillConfirmation({
      requestId: confirmId,
      skillId,
      name: proposal.name,
      description: proposal.description,
      content: proposal.content
    })

    if (!adopted) {
      console.log(`[Agent][ModeB] User rejected skill "${proposal.name}"`)
      return
    }

    await writeSkillToDisk(skillId, proposal.content, proposal.name)
  }
}


export function registerAgentHandlers(ipcMain: IpcMain): void {
  console.log("[Agent] Registering agent handlers...")

  // Handle agent invocation with streaming
  ipcMain.on("agent:invoke", async (event, { threadId, message, modelId }: AgentInvokeParams) => {
    const channel = `agent:stream:${threadId}`
    const window = BrowserWindow.fromWebContents(event.sender)

    console.log("[Agent] Received invoke request:", {
      threadId,
      message: message.substring(0, 50),
      modelId
    })

    if (!window) {
      console.error("[Agent] No window found")
      return
    }

    // Abort any existing stream for this thread before starting a new one
    // This prevents concurrent streams which can cause checkpoint corruption
    const existingController = activeRuns.get(threadId)
    if (existingController) {
      console.log("[Agent] Aborting existing stream for thread:", threadId)
      existingController.abort()
      activeRuns.delete(threadId)
    }

    const abortController = new AbortController()
    activeRuns.set(threadId, abortController)

    // Abort the stream if the window is closed/destroyed
    const onWindowClosed = (): void => {
      console.log("[Agent] Window closed, aborting stream for thread:", threadId)
      abortController.abort()
    }
    window.once("closed", onWindowClosed)

    // Start trace collection for this invocation (modelId resolved later)
    const tracer = new TraceCollector(threadId, message, modelId ?? "unknown")

    try {
      // Get workspace path from thread metadata - REQUIRED
      const thread = getThread(threadId)
      const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
      console.log("[Agent] Thread metadata:", metadata)

      const workspacePath = metadata.workspacePath as string | undefined

      if (!workspacePath) {
        window.webContents.send(channel, {
          type: "error",
          error: "WORKSPACE_REQUIRED",
          message: "Please select a workspace folder before sending messages."
        })
        await tracer.finish("error", "WORKSPACE_REQUIRED")
        return
      }

      // Sync FTS index with any memory files changed since last invocation
      if (isMemoryEnabled()) {
        try {
          const memoryStore = await getMemoryStore()
          memoryStore.syncMemoryFiles()
        } catch { /* non-critical */ }
      }

      const effectiveModelId = modelId || (metadata.model as string | undefined)

      const agent = await createAgentRuntime({
        threadId,
        workspacePath,
        modelId: effectiveModelId,
      })
      const humanMessage = new HumanMessage(message)

      // Stream with both modes:
      // - 'messages' for real-time token streaming
      // - 'values' for full state (todos, files, etc.)
      const stream = await agent.stream(
        { messages: [humanMessage] },
        {
          configurable: { thread_id: threadId },
          signal: abortController.signal,
          streamMode: ["messages", "values"],
          recursionLimit: 1000
        }
      )

      // Update tracer with resolved modelId
      if (effectiveModelId) tracer.setModelId(effectiveModelId)

      // ── Tool-call extraction (tested in __tests__/tool-call-extraction.test.ts)
      //
      // "messages" mode delivers one [msgChunk, metadata?] tuple per LangGraph message.
      // AI messages carry a complete tool_calls array even in streaming mode —
      // confirmed by stream-converter.ts and unit tests.
      //
      // Deduplication: same AI message ID can appear in multiple chunks
      // (e.g. once as AIMessageChunk, once as AIMessage in a values snapshot).
      // We track seen IDs to count each unique tool invocation exactly once.
      // ─────────────────────────────────────────────────────────────────────────

      const _countedAiMsgIds = new Set<string>()
      const _toolCallNames: string[] = []

      let assistantText = ""
      for await (const chunk of stream) {
        if (abortController.signal.aborted) break

        const [mode, data] = chunk as [string, unknown]

        // Serialize first — live BaseMessage objects must be serialized before
        // we can inspect the LangChain class path (msgChunk.id becomes the
        // class array ["langchain_core","messages","AIMessageChunk"] only after
        // toJSON() / JSON.stringify; on the live object, .id is the msg-id string).
        const serialized = JSON.parse(JSON.stringify(data))

        if (mode === "messages") {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const [msgChunk] = serialized as [any]
            if (!msgChunk) continue

            const kwargs = (msgChunk.kwargs || {}) as Record<string, unknown>
            const classId: string[] = Array.isArray(msgChunk.id) ? msgChunk.id : []
            const className = classId[classId.length - 1] || ""
            const isAI = className.includes("AI")
            if (!isAI) continue

            // Accumulate visible assistant text
            const rawContent = kwargs.content ?? msgChunk.content
            if (rawContent) {
              if (typeof rawContent === "string") {
                assistantText += rawContent
              } else if (Array.isArray(rawContent)) {
                assistantText += (rawContent as Array<{ type?: string; text?: string }>)
                  .filter((b) => b?.type === "text")
                  .map((b) => b.text ?? "")
                  .join("")
              }
            }

            // Tool-call extraction — deduped by message ID
            const toolCalls = kwargs.tool_calls as Array<{
              id?: string; name?: string; args?: Record<string, unknown>
            }> | undefined
            if (!toolCalls || toolCalls.length === 0) continue

            const msgId = (kwargs.id as string) || ""
            if (msgId && _countedAiMsgIds.has(msgId)) continue
            if (msgId) _countedAiMsgIds.add(msgId)

            // Extract step text (text blocks only from array content)
            let stepText = ""
            if (typeof rawContent === "string") {
              stepText = rawContent
            } else if (Array.isArray(rawContent)) {
              stepText = (rawContent as Array<{ type?: string; text?: string }>)
                .filter((b) => b?.type === "text")
                .map((b) => b.text ?? "")
                .join("")
            }

            // Record trace step + increment skill-evolution counter
            tracer.beginStep()
            for (const tc of toolCalls) {
              const tcName = tc.name ?? "unknown"
              tracer.recordToolCall({ name: tcName, args: tc.args ?? {} })
              _toolCallNames.push(tcName)
              const newCount = incrementToolCallCount(threadId)
              console.log(`[Agent] Tool call #${newCount} (${tcName}) in thread ${threadId}`)
            }
            tracer.endStep(stepText)
          } catch (e) {
            console.error("[Agent] Tool-call extraction error:", e)
          }
        }

        window.webContents.send(channel, {
          type: "stream",
          mode,
          data: serialized
        })
      }

      if (!abortController.signal.aborted) {
        window.webContents.send(channel, { type: "done" })
        notifyIfBackground("✅ 任务完成", assistantText.trim() || "对话已完成")

        // Finish trace
        await tracer.finish("success")

        // Check if this turn crossed the skill-evolution threshold.
        // autoProposeSKill handles both modes (A: ask human first; B: LLM judges first).
        const turnToolCallCount = getToolCallCount(threadId)
        if (turnToolCallCount >= SKILL_EVOLUTION_THRESHOLD) {
          resetToolCallCount(threadId)
          console.log(`[Agent] Threshold reached (${turnToolCallCount} calls), starting skill evolution flow`)
          autoProposeSKill(threadId, message, assistantText, [..._toolCallNames]).catch((e) =>
            console.warn("[Agent] autoProposeSKill failed:", e)
          )
        }

        const conversation = assistantText.trim()
          ? `User: ${message}\n\nAssistant: ${assistantText}`
          : ""

        if (isMemoryEnabled() && conversation.length >= MIN_CHARS_FOR_MEMORY) {
          const memoryStore = await getMemoryStore()
          const allConfigs = getCustomModelConfigs()
          const config = allConfigs.find((c) => c.id === (modelId?.replace("custom:", "") ?? "")) || allConfigs[0]
          if (!config) {
            console.warn("[Agent] No model config available — skipping memory summarization")
          } else if (config?.apiKey) {
            summarizeAndSave({
              model: new ChatOpenAI({
                model: config.model,
                apiKey: config.apiKey,
                configuration: { baseURL: config.baseUrl }
              }),
              conversation,
              memoryDir: memoryStore.getMemoryDir()
            }).catch((e) => console.warn("[Agent] Memory summarize failed:", e))
          }
        }
      }
    } catch (error) {
      // Ignore abort-related errors (expected when stream is cancelled)
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.includes("aborted") ||
          error.message.includes("Controller is already closed"))

      if (!isAbortError) {
        const errMsg = error instanceof Error ? error.message : "Unknown error"
        console.error("[Agent] Error:", error)
        window.webContents.send(channel, {
          type: "error",
          error: errMsg
        })
        notifyIfBackground("❌ 任务失败", errMsg)
        tracer.finish("error", errMsg).catch(() => {})
      } else {
        tracer.finish("cancelled").catch(() => {})
      }
    } finally {
      window.removeListener("closed", onWindowClosed)
      activeRuns.delete(threadId)
    }
  })

  // Handle agent resume (after interrupt approval/rejection via useStream)
  ipcMain.on("agent:resume", async (event, { threadId, command, modelId }: AgentResumeParams) => {
    const channel = `agent:stream:${threadId}`
    const window = BrowserWindow.fromWebContents(event.sender)

    console.log("[Agent] Received resume request:", { threadId, command, modelId })

    if (!window) {
      console.error("[Agent] No window found for resume")
      return
    }

    // Get workspace path from thread metadata
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | undefined

    if (!workspacePath) {
      window.webContents.send(channel, {
        type: "error",
        error: "Workspace path is required"
      })
      return
    }

    // Abort any existing stream before resuming
    const existingController = activeRuns.get(threadId)
    if (existingController) {
      existingController.abort()
      activeRuns.delete(threadId)
    }

    const abortController = new AbortController()
    activeRuns.set(threadId, abortController)

    const onWindowClosed = (): void => {
      console.log("[Agent] Window closed, aborting resume stream for thread:", threadId)
      abortController.abort()
    }
    window.once("closed", onWindowClosed)

    try {
      const effectiveModelId = modelId || (metadata.model as string | undefined)
      const agent = await createAgentRuntime({
        threadId,
        workspacePath,
        modelId: effectiveModelId
      })
      const config = {
        configurable: { thread_id: threadId },
        signal: abortController.signal,
        streamMode: ["messages", "values"] as ("messages" | "values")[],
        recursionLimit: 1000
      }

      // Resume from checkpoint by streaming with Command containing the decision
      // The HITL middleware expects { decisions: [{ type: 'approve' | 'reject' | 'edit' }] }
      const decisionType = command?.resume?.decision || "approve"
      const resumeValue = { decisions: [{ type: decisionType }] }
      const stream = await agent.stream(new Command({ resume: resumeValue }), config)

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break

        const [mode, data] = chunk as unknown as [string, unknown]
        window.webContents.send(channel, {
          type: "stream",
          mode,
          data: JSON.parse(JSON.stringify(data))
        })
      }

      if (!abortController.signal.aborted) {
        window.webContents.send(channel, { type: "done" })
      }
    } catch (error) {
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.includes("aborted") ||
          error.message.includes("Controller is already closed"))

      if (!isAbortError) {
        console.error("[Agent] Resume error:", error)
        window.webContents.send(channel, {
          type: "error",
          error: error instanceof Error ? error.message : "Unknown error"
        })
      }
    } finally {
      window.removeListener("closed", onWindowClosed)
      activeRuns.delete(threadId)
    }
  })

  // Handle HITL interrupt response
  ipcMain.on("agent:interrupt", async (event, { threadId, decision }: AgentInterruptParams) => {
    const channel = `agent:stream:${threadId}`
    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window) {
      console.error("[Agent] No window found for interrupt response")
      return
    }

    // Get workspace path from thread metadata - REQUIRED
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | undefined
    const modelId = metadata.model as string | undefined

    if (!workspacePath) {
      window.webContents.send(channel, {
        type: "error",
        error: "Workspace path is required"
      })
      return
    }

    // Abort any existing stream before continuing
    const existingController = activeRuns.get(threadId)
    if (existingController) {
      existingController.abort()
      activeRuns.delete(threadId)
    }

    const abortController = new AbortController()
    activeRuns.set(threadId, abortController)

    const onWindowClosed = (): void => {
      console.log("[Agent] Window closed, aborting interrupt stream for thread:", threadId)
      abortController.abort()
    }
    window.once("closed", onWindowClosed)

    try {
      const agent = await createAgentRuntime({ threadId, workspacePath, modelId })
      const config = {
        configurable: { thread_id: threadId },
        signal: abortController.signal,
        streamMode: ["messages", "values"] as ("messages" | "values")[],
        recursionLimit: 1000
      }

      if (decision.type === "approve") {
        // Resume execution by invoking with null (continues from checkpoint)
        const stream = await agent.stream(null, config)

        for await (const chunk of stream) {
          if (abortController.signal.aborted) break

          const [mode, data] = chunk as unknown as [string, unknown]
          window.webContents.send(channel, {
            type: "stream",
            mode,
            data: JSON.parse(JSON.stringify(data))
          })
        }

        if (!abortController.signal.aborted) {
          window.webContents.send(channel, { type: "done" })
        }
      } else if (decision.type === "reject") {
        // For reject, we need to send a Command with reject decision
        // For now, just send done - the agent will see no resumption happened
        window.webContents.send(channel, { type: "done" })
      }
      // edit case handled similarly to approve with modified args
    } catch (error) {
      const isAbortError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.includes("aborted") ||
          error.message.includes("Controller is already closed"))

      if (!isAbortError) {
        console.error("[Agent] Interrupt error:", error)
        window.webContents.send(channel, {
          type: "error",
          error: error instanceof Error ? error.message : "Unknown error"
        })
      }
    } finally {
      window.removeListener("closed", onWindowClosed)
      activeRuns.delete(threadId)
    }
  })

  // Handle cancellation
  ipcMain.handle("agent:cancel", async (_event, { threadId }: AgentCancelParams) => {
    const controller = activeRuns.get(threadId)
    if (controller) {
      controller.abort()
      activeRuns.delete(threadId)
    }
  })
}
