import { v4 as uuid } from "uuid"
import { BrowserWindow } from "electron"
import { HumanMessage } from "@langchain/core/messages"
import { getScheduledTasks, updateScheduledTaskRunResult } from "../storage"
import { createAgentRuntime } from "../agent/runtime"
import { createThread as dbCreateThread, deleteThread as dbDeleteThread } from "../db"
import { StreamConverter } from "../agent/stream-converter"

const TICK_INTERVAL_MS = 60_000
let tickTimer: ReturnType<typeof setTimeout> | null = null
const runningTasks = new Set<string>()
const activeAbortControllers = new Map<string, AbortController>()

function notifyRenderer(channel: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel)
  }
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
      modelId: task.modelId || undefined
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

    for await (const chunk of stream) {
      if (abortController.signal.aborted) break
      const [mode, data] = chunk as [string, unknown]
      const serialized = JSON.parse(JSON.stringify(data))
      const events = converter.processChunk(mode, serialized)
      for (const evt of events) {
        broadcastToChannel(channel, evt)
      }
      hasStreamedContent = true
    }

    if (!abortController.signal.aborted) {
      broadcastToChannel(channel, { type: "done" })
      updateScheduledTaskRunResult(taskId, "ok", null)
      console.log(`[Scheduler] Task completed: ${task.name}`)
    } else {
      broadcastToChannel(channel, { type: "done" })
      updateScheduledTaskRunResult(taskId, "error", "Cancelled by user")
      console.log(`[Scheduler] Task cancelled: ${task.name}`)
    }
  } catch (error) {
    const isAbortError =
      error instanceof Error &&
      (error.name === "AbortError" || error.message.includes("aborted"))
    if (isAbortError) {
      broadcastToChannel(channel, { type: "done" })
      updateScheduledTaskRunResult(taskId, "error", "Cancelled by user")
      console.log(`[Scheduler] Task cancelled: ${task.name}`)
    } else {
      const message = error instanceof Error ? error.message : String(error)
      broadcastToChannel(channel, { type: "error", error: message })
      updateScheduledTaskRunResult(taskId, "error", message)
      console.error(`[Scheduler] Task error: ${task.name}:`, message)
    }
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
