import { BrowserWindow, IpcMain } from "electron"
import { getWindowsSandboxMode, setWindowsSandboxMode, getYoloMode, setYoloMode } from "../storage"

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("sandbox:changed")
  }
}

export function registerSandboxHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("sandbox:getMode", async (): Promise<"none" | "unelevated"> => {
    return getWindowsSandboxMode()
  })

  ipcMain.handle(
    "sandbox:setMode",
    async (_event, mode: "none" | "unelevated"): Promise<void> => {
      if (mode !== "none" && mode !== "unelevated") {
        throw new Error(`Invalid sandbox mode: ${mode}`)
      }
      setWindowsSandboxMode(mode)
      notifyChanged()
    }
  )

  ipcMain.handle("sandbox:getYoloMode", async (): Promise<boolean> => {
    return getYoloMode()
  })

  ipcMain.handle("sandbox:setYoloMode", async (_event, yolo: boolean): Promise<void> => {
    if (typeof yolo !== "boolean") throw new Error(`Invalid yolo value: ${yolo}`)
    setYoloMode(yolo)
    notifyChanged()
  })
}
