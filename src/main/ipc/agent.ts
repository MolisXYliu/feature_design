import { IpcMain, BrowserWindow } from "electron"
import { HumanMessage } from "@langchain/core/messages"
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
import { getCustomModelConfigs, isMemoryEnabled } from "../storage"
import { notifyIfBackground } from "../services/notify"
import { TraceCollector } from "../agent/trace/collector"
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
// Skill Evolution Nudge Prompt
// Injected into the system prompt after SKILL_EVOLUTION_THRESHOLD
// tool calls have been made in the current session.
// ─────────────────────────────────────────────────────────
const SKILL_EVOLUTION_NUDGE_PROMPT = `
## 技能进化提示 (Skill Evolution)

你在本次会话中已执行了多个工具调用，完成了一项有一定复杂度的任务。
请在完成当前任务后，思考是否值得将这次的方法或流程固化为一个可复用的技能（Skill）。

### 何时应该创建技能？

符合以下任一条件，建议使用 \`manage_skill\` 工具创建技能：
- 这个任务**未来可能反复出现**（如：部署、测试、代码审查流程）
- 你在执行过程中**摸索了规律**，下次能做得更快
- 任务涉及**项目特定知识**（目录结构、命名规范、API 约定等）
- 你进行了**多次尝试/修正**，最终找到正确的方法

### 如何创建技能？

使用 \`manage_skill\` 工具，action='create'，提供：
- \`name\`: 技能名称（简短、描述性）
- \`description\`: **触发描述**（最重要！描述在什么情况下使用此技能，让 Agent 在匹配场景时自动加载）
- \`content\`: 完整的 SKILL.md 内容（含 YAML frontmatter + 操作指南）

### 技能不适合的场景

- 一次性任务，不会重复
- 通用知识，已经内置于模型中
- 任务太简单（1-2 步）

---
如果本次任务不适合创建技能，可以忽略此提示，直接完成任务即可。
`

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

      // Build extra system prompt: inject skill-evolution nudge if threshold reached.
      // Counter accumulates across turns (NOT reset every turn) so multi-turn sessions
      // correctly trigger the nudge. Reset only after the nudge is injected so we
      // don't spam the same nudge on every subsequent turn.
      const currentToolCallCount = getToolCallCount(threadId)
      let evolutionNudge: string | undefined
      if (currentToolCallCount >= SKILL_EVOLUTION_THRESHOLD) {
        evolutionNudge = SKILL_EVOLUTION_NUDGE_PROMPT
        console.log(`[Agent] Tool call count (${currentToolCallCount}) reached threshold, injecting skill evolution nudge`)
        resetToolCallCount(threadId)  // reset now so nudge fires only once per cycle
      }

      const agent = await createAgentRuntime({
        threadId,
        workspacePath,
        modelId: effectiveModelId,
        ...(evolutionNudge ? { extraSystemPrompt: evolutionNudge } : {})
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
              tracer.recordToolCall({ name: tc.name ?? "unknown", args: tc.args ?? {} })
              const newCount = incrementToolCallCount(threadId)
              console.log(`[Agent] Tool call #${newCount} (${tc.name}) in thread ${threadId}`)
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

        // NOTE: tool-call counter is NOT reset here — it accumulates across turns
        // so multi-turn sessions correctly hit the SKILL_EVOLUTION_THRESHOLD.
        // It is reset only when the nudge fires (above) or when the thread is cleared.

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
