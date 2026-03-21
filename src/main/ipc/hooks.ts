import { IpcMain } from "electron"
import {
  getHooks,
  upsertHook,
  deleteHook,
  setHookEnabled
} from "../storage"
import type { HookConfig, HookEvent, HookUpsert } from "../hooks/types"

const VALID_EVENTS = new Set<HookEvent>(["PreToolUse", "PostToolUse", "Stop", "Notification"])
const TIMEOUT_MIN = 1_000
const TIMEOUT_MAX = 60_000

function validateHookConfig(config: HookUpsert): void {
  if (!config.command || typeof config.command !== "string" || !config.command.trim()) {
    throw new Error("命令不能为空")
  }
  if (!config.event || !VALID_EVENTS.has(config.event)) {
    throw new Error("无效的事件类型")
  }
  if (config.timeout !== undefined) {
    const t = config.timeout
    if (!Number.isInteger(t) || t < TIMEOUT_MIN || t > TIMEOUT_MAX) {
      throw new Error(`超时时间必须在 ${TIMEOUT_MIN}ms 到 ${TIMEOUT_MAX}ms 之间`)
    }
  }
}

export function registerHooksHandlers(ipcMain: IpcMain): void {
  console.log("[Hooks] Registering hooks IPC handlers...")

  ipcMain.handle("hooks:list", async (): Promise<HookConfig[]> => {
    return getHooks()
  })

  ipcMain.handle(
    "hooks:create",
    async (_event, config: HookUpsert): Promise<{ id: string }> => {
      validateHookConfig(config)
      const id = upsertHook(config)
      return { id }
    }
  )

  ipcMain.handle(
    "hooks:update",
    async (_event, config: HookUpsert & { id: string }): Promise<{ id: string }> => {
      if (!config.id) {
        throw new Error("Hook ID 不能为空")
      }
      validateHookConfig(config)
      const id = upsertHook(config)
      return { id }
    }
  )

  ipcMain.handle("hooks:delete", async (_event, id: string): Promise<void> => {
    deleteHook(id)
  })

  ipcMain.handle(
    "hooks:setEnabled",
    async (_event, { id, enabled }: { id: string; enabled: boolean }): Promise<void> => {
      setHookEnabled(id, enabled)
    }
  )
}
