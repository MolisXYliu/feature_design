import { v4 as uuid } from "uuid"
import { BrowserWindow } from "electron"
import { HumanMessage } from "@langchain/core/messages"
import { getScheduledTasks, updateScheduledTaskRunResult, setScheduledTaskEnabled, addTaskRunRecord } from "../storage"
import { trySendChatXReply } from "./chatx"
import { createAgentRuntime, closeCheckpointer } from "../agent/runtime"
import { createThread as dbCreateThread, deleteThread as dbDeleteThread } from "../db"
import { StreamConverter } from "../agent/stream-converter"
import { notifyAlways, stripThink } from "./notify"

const TICK_INTERVAL_MS = 60_000
const ONCE_EXPIRE_MS = 30 * 60_000 // once tasks older than 30 min are auto-disabled instead of executed
let tickTimer: ReturnType<typeof setTimeout> | null = null
const runningTasks = new Set<string>()
const activeAbortControllers = new Map<string, AbortController>()

function recordRun(
  taskId: string, taskName: string, startedAt: Date,
  status: "ok" | "error", error: string | null
): void {
  const finishedAt = new Date()
  addTaskRunRecord({
    id: uuid(), taskId, taskName,
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    status, error, durationMs: finishedAt.getTime() - startedAt.getTime()
  })
}

function notifyRenderer(channel: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel)
  }
}

function showTaskNotification(taskName: string, status: "ok" | "error", body?: string): void {
  const title = status === "ok" ? `✅ ${taskName}` : `❌ ${taskName}`
  const text = status === "ok"
    ? stripThink(body || "任务已完成").trim() || "任务已完成"
    : (body || "任务执行失败")
  notifyAlways(title, text)
}

export function startScheduler(): void {
  console.log("[Scheduler] Starting scheduler service")
  tick()
}

export function stopScheduler(): void {
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  for (const [id, controller] of activeAbortControllers) {
    console.log(`[Scheduler] Aborting running task on shutdown: ${id}`)
    controller.abort()
  }
  activeAbortControllers.clear()
  runningTasks.clear()
  console.log("[Scheduler] Stopped scheduler service")
}

function armTimer(): void {
  tickTimer = setTimeout(tick, TICK_INTERVAL_MS)
}

function tick(): void {
  tickTimer = null
  try {
    const now = new Date()
    const tasks = getScheduledTasks()

    for (const task of tasks) {
      if (!task.enabled || task.frequency === "manual") continue
      if (runningTasks.has(task.id)) continue
      if (!task.nextRunAt) continue

      const nextRun = new Date(task.nextRunAt)
      if (now >= nextRun) {
        if (task.frequency === "once" && now.getTime() - nextRun.getTime() > ONCE_EXPIRE_MS) {
          console.log(`[Scheduler] Once task expired (>${ONCE_EXPIRE_MS / 60_000}min late), auto-disabling: ${task.name}`)
          setScheduledTaskEnabled(task.id, false)
          notifyRenderer("scheduledTasks:changed")
          continue
        }
        executeTask(task.id).catch((err) => {
          console.error(`[Scheduler] Task ${task.id} failed:`, err)
        })
      }
    }
  } catch (err) {
    console.error("[Scheduler] tick error:", err)
  } finally {
    armTimer()
  }
}

function broadcastToChannel(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data)
  }
}

async function executeTask(taskId: string): Promise<void> {
  const tasks = getScheduledTasks()
  const task = tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)
  if (!task.enabled) return

  runningTasks.add(taskId)
  const abortController = new AbortController()
  activeAbortControllers.set(taskId, abortController)
  notifyRenderer("scheduledTasks:changed")
  console.log(`[Scheduler] Executing task: ${task.name} (${taskId})`)
  const startedAt = new Date()

  const threadId = uuid()
  const channel = `scheduler:stream:${threadId}`

  let threadCreated = false
  let hasStreamedContent = false

  try {
    const workspacePath = task.workDir
    if (!workspacePath) {
      throw new Error("No workspace directory configured for this task")
    }

    const now = new Date()
    const timeTag = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
    const title = `[定时] ${task.name} · ${timeTag}`
    dbCreateThread(threadId, { workspacePath, title, scheduledTaskId: task.id })
    threadCreated = true
    notifyRenderer("threads:changed")

    broadcastToChannel(channel, { type: "started" })

    const agent = await createAgentRuntime({
      threadId,
      workspacePath,
      modelId: task.modelId || undefined,
      noSchedulerTool: true
    })

    const converter = new StreamConverter()

    const stream = await agent.stream(
      { messages: [new HumanMessage(task.prompt)] },
      {
        configurable: { thread_id: threadId },
        signal: abortController.signal,
        streamMode: ["messages", "values"],
        recursionLimit: 1000
      }
    )

    let lastAssistantText = ""
    for await (const chunk of stream) {
      if (abortController.signal.aborted) break
      const [mode, data] = chunk as [string, unknown]
      const serialized = JSON.parse(JSON.stringify(data))
      const events = converter.processChunk(mode, serialized)
      for (const evt of events) {
        broadcastToChannel(channel, evt)
        // Capture last assistant text for notification
        if (evt.type === "full-messages") {
          // 只取最后一条没有 tool_calls 的 assistant 消息（最终回复）
          const finalMsgs = evt.messages.filter(
            (m) => m.role === "assistant" && (!m.tool_calls || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0)
          )
          const last = finalMsgs[finalMsgs.length - 1]
          if (last?.content?.trim()) lastAssistantText = last.content.trim()
        }
      }
      hasStreamedContent = true
    }

    if (!abortController.signal.aborted) {
      broadcastToChannel(channel, { type: "done" })
      updateScheduledTaskRunResult(taskId, "ok", null)
      recordRun(taskId, task.name, startedAt, "ok", null)
      if (task.frequency === "once") {
        setScheduledTaskEnabled(taskId, false)
        console.log(`[Scheduler] Once task auto-disabled: ${task.name}`)
      }
      showTaskNotification(task.name, "ok", lastAssistantText)
      // If task is linked to a ChatX robot, send reply via HTTP
      if (task.chatxRobotChatId && lastAssistantText) {
        trySendChatXReply(task.chatxRobotChatId, lastAssistantText)
      }
      console.log(`[Scheduler] Task completed: ${task.name}`)
    } else {
      broadcastToChannel(channel, { type: "done" })
      updateScheduledTaskRunResult(taskId, "error", "Cancelled by user")
      recordRun(taskId, task.name, startedAt, "error", "Cancelled by user")
      console.log(`[Scheduler] Task cancelled: ${task.name}`)
    }
  } catch (error) {
    const isAbortError =
      error instanceof Error &&
      (error.name === "AbortError" || error.message.includes("aborted"))
    const errMsg = isAbortError ? "Cancelled by user" : (error instanceof Error ? error.message : String(error))
    if (isAbortError) {
      broadcastToChannel(channel, { type: "done" })
      updateScheduledTaskRunResult(taskId, "error", errMsg)
      console.log(`[Scheduler] Task cancelled: ${task.name}`)
    } else {
      broadcastToChannel(channel, { type: "error", error: errMsg })
      updateScheduledTaskRunResult(taskId, "error", errMsg)
      showTaskNotification(task.name, "error", errMsg)
      console.error(`[Scheduler] Task error: ${task.name}:`, errMsg)
    }
    recordRun(taskId, task.name, startedAt, "error", errMsg)
    // Clean up empty thread if runtime failed before any content was streamed
    if (threadCreated && !hasStreamedContent) {
      try {
        dbDeleteThread(threadId)
      } catch {
        // ignore cleanup errors
      }
    }
  } finally {
    runningTasks.delete(taskId)
    activeAbortControllers.delete(taskId)
    closeCheckpointer(threadId).catch(() => {})
    notifyRenderer("scheduledTasks:changed")
    notifyRenderer("threads:changed")
  }
}

export async function runTaskNow(taskId: string): Promise<void> {
  if (runningTasks.has(taskId)) {
    throw new Error("Task is already running")
  }
  await executeTask(taskId)
}

export function cancelTask(taskId: string): void {
  const controller = activeAbortControllers.get(taskId)
  if (controller) {
    controller.abort()
  }
}

export function isTaskRunning(taskId: string): boolean {
  return runningTasks.has(taskId)
}
