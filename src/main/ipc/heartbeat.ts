import { BrowserWindow, IpcMain } from "electron"
import {
  getHeartbeatConfig,
  saveHeartbeatConfig,
  resetHeartbeatConfig,
  getHeartbeatContent,
  saveHeartbeatContent
} from "../storage"
import { runHeartbeatNow, isHeartbeatRunning, cancelHeartbeat, restartHeartbeat, stopHeartbeat } from "../services/heartbeat"
import type { HeartbeatConfig } from "../types"

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("heartbeat:changed")
  }
}

export function registerHeartbeatHandlers(ipcMain: IpcMain): void {
  console.log("[Heartbeat] Registering heartbeat handlers...")

  ipcMain.handle("heartbeat:getConfig", async (): Promise<HeartbeatConfig> => {
    return getHeartbeatConfig()
  })

  ipcMain.handle(
    "heartbeat:saveConfig",
    async (_event, updates: Partial<HeartbeatConfig>): Promise<void> => {
      saveHeartbeatConfig(updates)
      if (updates.enabled === false) {
        stopHeartbeat()
      } else {
        restartHeartbeat()
      }
      notifyChanged()
    }
  )

  ipcMain.handle("heartbeat:getContent", async (): Promise<string> => {
    return getHeartbeatContent()
  })

  ipcMain.handle(
    "heartbeat:saveContent",
    async (_event, content: string): Promise<void> => {
      saveHeartbeatContent(content)
      notifyChanged()
    }
  )

  ipcMain.handle("heartbeat:runNow", async (): Promise<void> => {
    if (isHeartbeatRunning()) throw new Error("Heartbeat is already running")
    const config = getHeartbeatConfig()
    if (!config.workDir) throw new Error("未配置工作目录")
    if (!config.modelId) throw new Error("请选择模型")
    runHeartbeatNow().catch((err) => {
      console.error("[Heartbeat] runNow error:", err)
    })
  })

  ipcMain.handle("heartbeat:cancel", async (): Promise<void> => {
    cancelHeartbeat()
  })

  ipcMain.handle("heartbeat:isRunning", async (): Promise<boolean> => {
    return isHeartbeatRunning()
  })

  ipcMain.handle("heartbeat:resetConfig", async (): Promise<HeartbeatConfig> => {
    const defaults = resetHeartbeatConfig()
    restartHeartbeat()
    notifyChanged()
    return defaults
  })
}
