import { contextBridge, ipcRenderer } from "electron"
import type {
  Thread,
  ModelConfig,
  Provider,
  StreamEvent,
  HITLDecision,
  SkillMetadata,
  McpConnectorConfig,
  McpConnectorUpsert
} from "../main/types"

// Simple electron API - replaces @electron-toolkit/preload
const electronAPI = {
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcRenderer.on(channel, (_event, ...args) => listener(...args))
      return () => ipcRenderer.removeListener(channel, listener)
    },
    once: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcRenderer.once(channel, (_event, ...args) => listener(...args))
    },
    invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
  },
  process: {
    platform: process.platform,
    versions: process.versions
  }
}

// Custom APIs for renderer
const api = {
  agent: {
    // Send message and receive events via callback
    invoke: (
      threadId: string,
      message: string,
      onEvent: (event: StreamEvent) => void,
      modelId?: string
    ): (() => void) => {
      const channel = `agent:stream:${threadId}`

      const handler = (_: unknown, data: StreamEvent): void => {
        onEvent(data)
        if (data.type === "done" || data.type === "error") {
          ipcRenderer.removeListener(channel, handler)
        }
      }

      ipcRenderer.on(channel, handler)
      ipcRenderer.send("agent:invoke", { threadId, message, modelId })

      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    streamAgent: (
      threadId: string,
      message: string,
      command: unknown,
      onEvent: (event: StreamEvent) => void,
      modelId?: string
    ): (() => void) => {
      const channel = `agent:stream:${threadId}`

      const handler = (_: unknown, data: StreamEvent): void => {
        onEvent(data)
        if (data.type === "done" || data.type === "error") {
          ipcRenderer.removeListener(channel, handler)
        }
      }

      ipcRenderer.on(channel, handler)

      if (command) {
        ipcRenderer.send("agent:resume", { threadId, command, modelId })
      } else {
        ipcRenderer.send("agent:invoke", { threadId, message, modelId })
      }

      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    interrupt: (
      threadId: string,
      decision: HITLDecision,
      onEvent?: (event: StreamEvent) => void
    ): (() => void) => {
      const channel = `agent:stream:${threadId}`

      const handler = (_: unknown, data: StreamEvent): void => {
        onEvent?.(data)
        if (data.type === "done" || data.type === "error") {
          ipcRenderer.removeListener(channel, handler)
        }
      }

      ipcRenderer.on(channel, handler)
      ipcRenderer.send("agent:interrupt", { threadId, decision })

      // Return cleanup function
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    cancel: (threadId: string): Promise<void> => {
      return ipcRenderer.invoke("agent:cancel", { threadId })
    }
  },
  threads: {
    list: (): Promise<Thread[]> => {
      return ipcRenderer.invoke("threads:list")
    },
    get: (threadId: string): Promise<Thread | null> => {
      return ipcRenderer.invoke("threads:get", threadId)
    },
    create: (metadata?: Record<string, unknown>): Promise<Thread> => {
      return ipcRenderer.invoke("threads:create", metadata)
    },
    update: (threadId: string, updates: Partial<Thread>): Promise<Thread> => {
      return ipcRenderer.invoke("threads:update", { threadId, updates })
    },
    delete: (threadId: string): Promise<void> => {
      return ipcRenderer.invoke("threads:delete", threadId)
    },
    getHistory: (threadId: string): Promise<unknown[]> => {
      return ipcRenderer.invoke("threads:history", threadId)
    },
    generateTitle: (message: string): Promise<string> => {
      return ipcRenderer.invoke("threads:generateTitle", message)
    }
  },
  models: {
    list: (): Promise<ModelConfig[]> => {
      return ipcRenderer.invoke("models:list")
    },
    listProviders: (): Promise<Provider[]> => {
      return ipcRenderer.invoke("models:listProviders")
    },
    getDefault: (): Promise<string> => {
      return ipcRenderer.invoke("models:getDefault")
    },
    setDefault: (modelId: string): Promise<void> => {
      return ipcRenderer.invoke("models:setDefault", modelId)
    },
    getTokenLimits: (): Promise<{
      defaultMaxTokens: number
      minMaxTokens: number
      maxMaxTokens: number
    }> => {
      return ipcRenderer.invoke("models:getTokenLimits") as Promise<{
        defaultMaxTokens: number
        minMaxTokens: number
        maxMaxTokens: number
      }>
    },
    getCustomConfigs: (): Promise<
      Array<{
        id: string
        name: string
        baseUrl: string
        model: string
        hasApiKey: boolean
        maxTokens: number
      }>
    > => {
      return ipcRenderer.invoke("models:getCustomConfigs") as Promise<
        Array<{
          id: string
          name: string
          baseUrl: string
          model: string
          hasApiKey: boolean
          maxTokens: number
        }>
      >
    },
    getCustomConfig: (id?: string): Promise<{
      id: string
      name: string
      baseUrl: string
      model: string
      hasApiKey: boolean
      maxTokens: number
    } | null> => {
      return ipcRenderer.invoke("models:getCustomConfig", id) as Promise<{
        id: string
        name: string
        baseUrl: string
        model: string
        hasApiKey: boolean
        maxTokens: number
      } | null>
    },
    setCustomConfig: (config: {
      id: string
      name: string
      baseUrl: string
      model: string
      apiKey?: string
      maxTokens?: number
    }): Promise<void> => {
      return ipcRenderer.invoke("models:setCustomConfig", config) as Promise<void>
    },
    upsertCustomConfig: (config: {
      id?: string
      name: string
      baseUrl: string
      model: string
      apiKey?: string
      maxTokens?: number
    }): Promise<{ id: string }> => {
      return ipcRenderer.invoke("models:upsertCustomConfig", config) as Promise<{ id: string }>
    },
    deleteCustomConfig: (id: string): Promise<void> => {
      return ipcRenderer.invoke("models:deleteCustomConfig", id) as Promise<void>
    }
  },
  workspace: {
    get: (threadId?: string): Promise<string | null> => {
      return ipcRenderer.invoke("workspace:get", threadId)
    },
    set: (threadId: string | undefined, path: string | null): Promise<string | null> => {
      return ipcRenderer.invoke("workspace:set", { threadId, path })
    },
    select: (threadId?: string): Promise<string | null> => {
      return ipcRenderer.invoke("workspace:select", threadId)
    },
    loadFromDisk: (
      threadId: string
    ): Promise<{
      success: boolean
      files: Array<{
        path: string
        is_dir: boolean
        size?: number
        modified_at?: string
      }>
      workspacePath?: string
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:loadFromDisk", { threadId })
    },
    readFile: (
      threadId: string,
      filePath: string
    ): Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:readFile", { threadId, filePath })
    },
    readBinaryFile: (
      threadId: string,
      filePath: string
    ): Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:readBinaryFile", { threadId, filePath })
    },
    clearWorktreeContext: (threadId: string): Promise<void> => {
      return ipcRenderer.invoke("workspace:clearWorktreeContext", threadId) as Promise<void>
    },
    saveWorktreeContext: (threadId: string, gitRoot: string, branch: string, baseBranch?: string): Promise<void> => {
      return ipcRenderer.invoke("workspace:saveWorktreeContext", { threadId, gitRoot, branch, baseBranch }) as Promise<void>
    },
    isGit: (
      folderPath: string
    ): Promise<{
      isGit: boolean
      gitRoot: string | null
      worktrees: Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
      isWorktreePath: boolean
    }> => {
      return ipcRenderer.invoke("workspace:isGit", folderPath) as Promise<{
        isGit: boolean
        gitRoot: string | null
        worktrees: Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
        isWorktreePath: boolean
      }>
    },
    listWorktrees: (
      gitRoot: string
    ): Promise<Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>> => {
      return ipcRenderer.invoke("workspace:listWorktrees", gitRoot) as Promise<
        Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
      >
    },
    createWorktree: (
      gitRoot: string,
      branch: string
    ): Promise<{ success: boolean; path?: string; branch?: string; baseBranch?: string; error?: string }> => {
      return ipcRenderer.invoke("workspace:createWorktree", { gitRoot, branch }) as Promise<{
        success: boolean
        path?: string
        branch?: string
        baseBranch?: string
        error?: string
      }>
    },
    commitWorktree: (worktreePath: string, message: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("workspace:commitWorktree", { worktreePath, message }) as Promise<{
        success: boolean
        error?: string
      }>
    },
    // Listen for file changes in the workspace
    onFilesChanged: (
      callback: (data: { threadId: string; workspacePath: string }) => void
    ): (() => void) => {
      const handler = (_: unknown, data: { threadId: string; workspacePath: string }): void => {
        callback(data)
      }
      ipcRenderer.on("workspace:files-changed", handler)
      // Return cleanup function
      return () => {
        ipcRenderer.removeListener("workspace:files-changed", handler)
      }
    }
  },
  skills: {
    list: (): Promise<SkillMetadata[]> => {
      return ipcRenderer.invoke("skills:list")
    },
    read: (skillPath: string): Promise<{ success: boolean; content?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:read", skillPath)
    },
    readBinary: (
      skillPath: string
    ): Promise<{ success: boolean; content?: string; mimeType?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:readBinary", skillPath)
    },
    listFiles: (skillPath: string): Promise<{ success: boolean; files?: string[]; error?: string }> => {
      return ipcRenderer.invoke("skills:listFiles", skillPath)
    },
    getDisabled: (): Promise<string[]> => {
      return ipcRenderer.invoke("skills:getDisabled")
    },
    setDisabled: (skillNames: string[]): Promise<void> => {
      return ipcRenderer.invoke("skills:setDisabled", skillNames)
    },
    upload: (buffer: ArrayBuffer, fileName: string): Promise<{ success: boolean; skillName?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:upload", { buffer, fileName })
    },
    delete: (skillPath: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("skills:delete", skillPath)
    }
  },
  mcp: {
    list: (): Promise<McpConnectorConfig[]> => ipcRenderer.invoke("mcp:list"),
    create: (config: McpConnectorUpsert): Promise<{ id: string }> =>
      ipcRenderer.invoke("mcp:create", config),
    update: (config: McpConnectorUpsert & { id: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke("mcp:update", config),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("mcp:delete", id),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("mcp:setEnabled", { id, enabled }),
    testConnection: (params: {
      id?: string
      url?: string
      advanced?: McpConnectorConfig["advanced"]
    }): Promise<{ success: boolean; tools?: string[]; error?: string }> =>
      ipcRenderer.invoke("mcp:testConnection", params)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to renderer
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI)
    contextBridge.exposeInMainWorld("api", api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
