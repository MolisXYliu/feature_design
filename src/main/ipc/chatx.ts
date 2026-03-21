import { IpcMain } from "electron"
import { getChatXConfig, saveChatXConfig } from "../storage"
import { restartChatX, cancelChatXByThreadId, getChatXStatus } from "../services/chatx"
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

  ipcMain.handle("chatx:cancel-by-thread", (_event, threadId: string) => {
    return cancelChatXByThreadId(threadId)
  })

  ipcMain.handle("chatx:get-status", () => {
    return getChatXStatus()
  })
}
