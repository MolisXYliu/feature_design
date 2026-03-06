import { IpcMain, BrowserWindow } from "electron"
import { existsSync, readdirSync, readFileSync, unlinkSync, statSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"
import { isMemoryEnabled, setMemoryEnabled } from "../storage"
import { getMemoryStore } from "../memory/store"

const MEMORY_DIR = join(homedir(), ".cmbcoworkagent", "memory")

export interface MemoryFileInfo {
  name: string
  size: number
  modifiedAt: string
}

export interface MemoryStats {
  fileCount: number
  totalSize: number
  indexSize: number
  enabled: boolean
}

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("memory:changed")
  }
}

export function registerMemoryHandlers(ipcMain: IpcMain): void {
  console.log("[Memory] Registering memory handlers...")

  ipcMain.handle("memory:listFiles", async (): Promise<MemoryFileInfo[]> => {
    if (!existsSync(MEMORY_DIR)) return []
    const files = readdirSync(MEMORY_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((name) => {
        const fullPath = join(MEMORY_DIR, name)
        const st = statSync(fullPath)
        return { name, size: st.size, modifiedAt: st.mtime.toISOString() }
      })
    // MEMORY.md first, then daily files by date descending
    files.sort((a, b) => {
      if (a.name === "MEMORY.md") return -1
      if (b.name === "MEMORY.md") return 1
      return b.name.localeCompare(a.name)
    })
    return files
  })

  ipcMain.handle("memory:readFile", async (_, name: string): Promise<string> => {
    const safeName = basename(name)
    if (!safeName.endsWith(".md")) return ""
    const fullPath = join(MEMORY_DIR, safeName)
    if (!existsSync(fullPath)) return ""
    return readFileSync(fullPath, "utf-8")
  })

  ipcMain.handle("memory:deleteFile", async (_, name: string): Promise<void> => {
    const safeName = basename(name)
    if (safeName === "MEMORY.md" || !safeName.endsWith(".md")) return
    const fullPath = join(MEMORY_DIR, safeName)
    if (!existsSync(fullPath)) return
    unlinkSync(fullPath)
    try {
      const store = await getMemoryStore()
      store.removeDocument(fullPath)
    } catch (e) {
      console.warn("[Memory] Failed to remove document from index:", e)
    }
    notifyChanged()
  })

  ipcMain.handle("memory:getEnabled", async (): Promise<boolean> => {
    return isMemoryEnabled()
  })

  ipcMain.handle("memory:setEnabled", async (_, enabled: boolean): Promise<void> => {
    setMemoryEnabled(enabled)
    notifyChanged()
  })

  ipcMain.handle("memory:getStats", async (): Promise<MemoryStats> => {
    let fileCount = 0
    let totalSize = 0
    let indexSize = 0
    if (existsSync(MEMORY_DIR)) {
      const files = readdirSync(MEMORY_DIR)
      for (const f of files) {
        const st = statSync(join(MEMORY_DIR, f))
        if (f.endsWith(".md")) {
          fileCount++
          totalSize += st.size
        } else if (f === "index.sqlite") {
          indexSize = st.size
        }
      }
    }
    return { fileCount, totalSize, indexSize, enabled: isMemoryEnabled() }
  })
}
