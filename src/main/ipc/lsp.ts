import { BrowserWindow, IpcMain } from "electron"
import { getLspConfig, saveLspConfig, resetLspConfig } from "../storage"
import {
  startLsp,
  stopLsp,
  isLspRunning,
  lspDefinition,
  lspReferences,
  lspHover,
  lspImplementation,
  lspDocumentSymbols,
  lspWorkspaceSymbol,
  lspDiagnostics,
  lspPrepareCallHierarchy,
  lspIncomingCalls,
  lspOutgoingCalls,
  detectJavaProject
} from "../lsp"
import type { LspConfig } from "../types"

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("lsp:changed")
  }
}

export function registerLspHandlers(ipcMain: IpcMain): void {
  console.log("[LSP] Registering LSP handlers...")

  ipcMain.handle("lsp:getConfig", async (): Promise<LspConfig> => {
    return getLspConfig()
  })

  ipcMain.handle(
    "lsp:saveConfig",
    async (_event, updates: Partial<LspConfig>): Promise<void> => {
      saveLspConfig(updates)
      notifyChanged()
    }
  )

  ipcMain.handle("lsp:resetConfig", async (): Promise<LspConfig> => {
    const defaults = resetLspConfig()
    notifyChanged()
    return defaults
  })

  ipcMain.handle(
    "lsp:start",
    async (_event, projectRoot: string): Promise<void> => {
      await startLsp(projectRoot)
    }
  )

  ipcMain.handle(
    "lsp:stop",
    async (_event, projectRoot: string): Promise<void> => {
      await stopLsp(projectRoot)
    }
  )

  ipcMain.handle(
    "lsp:isRunning",
    async (_event, projectRoot: string): Promise<boolean> => {
      return isLspRunning(projectRoot)
    }
  )

  ipcMain.handle(
    "lsp:definition",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspDefinition(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:references",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspReferences(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:hover",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspHover(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:implementation",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspImplementation(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:documentSymbols",
    async (_event, params: { projectRoot: string; filePath: string }) => {
      return lspDocumentSymbols(params.projectRoot, params.filePath)
    }
  )

  ipcMain.handle(
    "lsp:workspaceSymbol",
    async (_event, params: { projectRoot: string; query: string }) => {
      return lspWorkspaceSymbol(params.projectRoot, params.query)
    }
  )

  ipcMain.handle(
    "lsp:diagnostics",
    async (_event, params: { projectRoot: string; filePath?: string }) => {
      return lspDiagnostics(params.projectRoot, params.filePath)
    }
  )

  ipcMain.handle(
    "lsp:prepareCallHierarchy",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspPrepareCallHierarchy(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:incomingCalls",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspIncomingCalls(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:outgoingCalls",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspOutgoingCalls(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:detectJavaProject",
    async (_event, dirPath: string): Promise<boolean> => {
      return detectJavaProject(dirPath)
    }
  )
}
