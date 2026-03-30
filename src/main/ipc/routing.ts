import { IpcMain } from "electron"
import { getGlobalRoutingMode, setGlobalRoutingMode } from "../storage"

export function registerRoutingHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("routing:getMode", () => {
    return getGlobalRoutingMode()
  })

  ipcMain.handle("routing:setMode", (_event, mode: "auto" | "pinned") => {
    if (mode !== "auto" && mode !== "pinned") {
      throw new Error(`Invalid routing mode: ${String(mode)}`)
    }
    setGlobalRoutingMode(mode)
  })
}
