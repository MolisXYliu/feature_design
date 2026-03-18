import { IpcMain } from "electron"
import { getChatXConfig, saveChatXConfig } from "../storage"
import { restartChatX } from "../services/chatx"
import type { ChatXConfig } from "../types"

export function registerChatXHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("chatx:get-config", () => {
    return getChatXConfig()
  })

  ipcMain.handle("chatx:save-config", (_event, updates: Partial<ChatXConfig>) => {
    saveChatXConfig(updates)
  })

  ipcMain.handle("chatx:restart", () => {
    restartChatX()
  })
}
