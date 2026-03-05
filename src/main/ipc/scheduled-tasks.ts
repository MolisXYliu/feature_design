import { BrowserWindow, IpcMain } from "electron"
import {
  getScheduledTasks,
  upsertScheduledTask,
  deleteScheduledTask,
  setScheduledTaskEnabled
} from "../storage"
import { runTaskNow, isTaskRunning, cancelTask } from "../services/scheduler"
import type { ScheduledTask, ScheduledTaskUpsert } from "../types"

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("scheduledTasks:changed")
  }
}

const VALID_FREQUENCIES = new Set(["manual", "hourly", "daily", "weekdays", "weekly"])
const RUN_AT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function validateInput(config: ScheduledTaskUpsert): void {
  if (!config.name || typeof config.name !== "string" || !config.name.trim()) {
    throw new Error("名称不能为空")
  }
  if (!config.prompt || typeof config.prompt !== "string" || !config.prompt.trim()) {
    throw new Error("提示词不能为空")
  }
  if (!config.description || typeof config.description !== "string" || !config.description.trim()) {
    throw new Error("描述不能为空")
  }
  if (!VALID_FREQUENCIES.has(config.frequency)) {
    throw new Error("无效的执行频率")
  }
  if (config.runAtTime != null && !RUN_AT_TIME_RE.test(config.runAtTime)) {
    throw new Error("执行时间格式无效，应为 HH:mm")
  }
  if (config.weekday != null && (config.weekday < 0 || config.weekday > 6 || !Number.isInteger(config.weekday))) {
    throw new Error("weekday 取值范围为 0-6")
  }
  if (!config.modelId) {
    throw new Error("请选择模型")
  }
  if (!config.workDir) {
    throw new Error("请配置工作目录")
  }
}

export function registerScheduledTaskHandlers(ipcMain: IpcMain): void {
  console.log("[ScheduledTasks] Registering scheduled task handlers...")

  ipcMain.handle("scheduledTasks:list", async (): Promise<ScheduledTask[]> => {
    return getScheduledTasks()
  })

  ipcMain.handle(
    "scheduledTasks:create",
    async (_event, config: ScheduledTaskUpsert): Promise<{ id: string }> => {
      validateInput(config)
      const id = upsertScheduledTask(config)
      notifyChanged()
      return { id }
    }
  )

  ipcMain.handle(
    "scheduledTasks:update",
    async (_event, config: ScheduledTaskUpsert & { id: string }): Promise<{ id: string }> => {
      validateInput(config)
      const existing = getScheduledTasks().find((t) => t.id === config.id)
      if (!existing) throw new Error("任务不存在")
      const id = upsertScheduledTask(config)
      notifyChanged()
      return { id }
    }
  )

  ipcMain.handle("scheduledTasks:delete", async (_event, id: string): Promise<void> => {
    if (isTaskRunning(id)) cancelTask(id)
    deleteScheduledTask(id)
    notifyChanged()
  })

  ipcMain.handle(
    "scheduledTasks:setEnabled",
    async (_event, { id, enabled }: { id: string; enabled: boolean }): Promise<void> => {
      setScheduledTaskEnabled(id, enabled)
      notifyChanged()
    }
  )

  ipcMain.handle("scheduledTasks:runNow", async (_event, id: string): Promise<void> => {
    if (isTaskRunning(id)) throw new Error("任务正在运行中")
    const task = getScheduledTasks().find((t) => t.id === id)
    if (!task) throw new Error("任务不存在")
    if (!task.workDir) throw new Error("未配置工作目录")
    runTaskNow(id).catch((err) => {
      console.error("[ScheduledTasks] runNow error:", err)
    })
  })

  ipcMain.handle("scheduledTasks:cancel", async (_event, id: string): Promise<void> => {
    cancelTask(id)
  })

  ipcMain.handle("scheduledTasks:isRunning", async (_event, id: string): Promise<boolean> => {
    return isTaskRunning(id)
  })
}
