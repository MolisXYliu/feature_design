import { create } from "zustand"
import type { Thread, ModelConfig, Provider } from "@/types"

interface AppState {
  // Main content view routing
  mainView: "thread" | "customize" | "evolution" | "kanban"

  // Threads
  threads: Thread[]
  currentThreadId: string | null

  // Models and Providers (global, not per-thread)
  models: ModelConfig[]
  providers: Provider[]

  // Right panel state (UI state, not thread data)
  rightPanelTab: "todos" | "files" | "subagents"

  // Settings dialog state
  settingsOpen: boolean

  // Sidebar state
  sidebarCollapsed: boolean
  rightPanelCollapsed: boolean

  // Kanban view state
  showKanbanView: boolean
  showSubagentsInKanban: boolean

  // Customize view state
  showCustomizeView: boolean

  // Thread actions
  loadThreads: () => Promise<void>
  createThread: (metadata?: Record<string, unknown>) => Promise<Thread>
  selectThread: (threadId: string) => Promise<void>
  deleteThread: (threadId: string) => Promise<void>
  updateThread: (threadId: string, updates: Partial<Thread>) => Promise<void>
  generateTitleForFirstMessage: (threadId: string, content: string) => Promise<void>

  // Model actions
  loadModels: () => Promise<void>
  loadProviders: () => Promise<void>

  // Panel actions
  setRightPanelTab: (tab: "todos" | "files" | "subagents") => void

  // Settings actions
  setSettingsOpen: (open: boolean) => void

  // Sidebar actions
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleRightPanel: () => void
  setRightPanelCollapsed: (collapsed: boolean) => void

  // Kanban actions
  setShowKanbanView: (show: boolean) => void
  setShowSubagentsInKanban: (show: boolean) => void

  // Customize actions
  setShowCustomizeView: (show: boolean) => void
  setMainView: (view: "thread" | "customize" | "evolution" | "kanban") => void

  // Plugin state sync — increment to trigger RightPanel refresh
  pluginVersion: number
  bumpPluginVersion: () => void

  // Skill evolution — true when threshold reached, clears when Evolution panel opens
  pendingEvolution: boolean
  setPendingEvolution: (v: boolean) => void

  // Skill generation virtual subagent — shown in the right panel agents section
  skillGenerationAgent: {
    phase: "generating" | "done" | "error" | null
    streamedText: string
    errorText: string
  }
  setSkillGenerationPhase: (phase: "generating" | "done" | "error" | null, text?: string) => void
  appendSkillGenerationToken: (token: string) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  threads: [],
  currentThreadId: null,
  models: [],
  providers: [],
  rightPanelTab: "todos",
  settingsOpen: false,
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  mainView: "thread",
  showKanbanView: false,
  showSubagentsInKanban: true,
  showCustomizeView: false,
  pluginVersion: 0,

  // Thread actions
  loadThreads: async () => {
    const threads = await window.api.threads.list()
    set({ threads })

    // Select first thread if none selected
    if (!get().currentThreadId && threads.length > 0) {
      await get().selectThread(threads[0].thread_id)
    }
  },

  createThread: async (metadata?: Record<string, unknown>) => {
    const thread = await window.api.threads.create(metadata)
    set((state) => ({
      threads: [thread, ...state.threads],
      currentThreadId: thread.thread_id,
      showKanbanView: false,
      showCustomizeView: false,
      mainView: "thread"
    }))
    return thread
  },

  selectThread: async (threadId: string) => {
    set({
      currentThreadId: threadId,
      showKanbanView: false,
      showCustomizeView: false,
      mainView: "thread"
    })
  },

  deleteThread: async (threadId: string) => {
    console.log("[Store] Deleting thread:", threadId)
    try {
      await window.api.threads.delete(threadId)
      console.log("[Store] Thread deleted from backend")

      set((state) => {
        const threads = state.threads.filter((t) => t.thread_id !== threadId)
        const wasCurrentThread = state.currentThreadId === threadId
        const newCurrentId = wasCurrentThread
          ? threads[0]?.thread_id || null
          : state.currentThreadId

        return {
          threads,
          currentThreadId: newCurrentId
        }
      })
    } catch (error) {
      console.error("[Store] Failed to delete thread:", error)
    }
  },

  updateThread: async (threadId: string, updates: Partial<Thread>) => {
    const updated = await window.api.threads.update(threadId, updates)
    set((state) => ({
      threads: state.threads.map((t) => (t.thread_id === threadId ? updated : t))
    }))
  },

  generateTitleForFirstMessage: async (threadId: string, content: string) => {
    try {
      const generatedTitle = await window.api.threads.generateTitle(content)
      await get().updateThread(threadId, { title: generatedTitle })
    } catch (error) {
      console.error("[Store] Failed to generate title:", error)
    }
  },

  // Model actions
  loadModels: async () => {
    const models = await window.api.models.list()
    set({ models })
  },

  loadProviders: async () => {
    const providers = await window.api.models.listProviders()
    set({ providers })
  },

  // Panel actions
  setRightPanelTab: (tab: "todos" | "files" | "subagents") => {
    set({ rightPanelTab: tab })
  },

  // Settings actions
  setSettingsOpen: (open: boolean) => {
    set({ settingsOpen: open })
  },

  // Sidebar actions
  toggleSidebar: () => {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
  },

  setSidebarCollapsed: (collapsed: boolean) => {
    set({ sidebarCollapsed: collapsed })
  },

  toggleRightPanel: () => {
    set((state) => ({ rightPanelCollapsed: !state.rightPanelCollapsed }))
  },

  setRightPanelCollapsed: (collapsed: boolean) => {
    set({ rightPanelCollapsed: collapsed })
  },

  // Kanban actions
  setShowKanbanView: (show: boolean) => {
    if (show) {
      set({
        showKanbanView: true,
        showCustomizeView: false,
        mainView: "kanban",
        currentThreadId: null
      })
    } else {
      set({ showKanbanView: false, mainView: "thread" })
    }
  },

  setShowSubagentsInKanban: (show: boolean) => {
    set({ showSubagentsInKanban: show })
  },

  setShowCustomizeView: (show: boolean) => {
    if (show) {
      set({
        showCustomizeView: true,
        showKanbanView: false,
        mainView: "customize"
      })
    } else {
      set({ showCustomizeView: false, mainView: "thread" })
    }
  },

  setMainView: (view) => {
    if (view === "kanban") {
      set({
        mainView: "kanban",
        showKanbanView: true,
        showCustomizeView: false,
        currentThreadId: null
      })
      return
    }

    if (view === "customize") {
      set({
        mainView: "customize",
        showCustomizeView: true,
        showKanbanView: false
      })
      return
    }

    if (view === "evolution") {
      set({
        mainView: "evolution",
        showCustomizeView: false,
        showKanbanView: false
      })
      return
    }

    set({
      mainView: "thread",
      showCustomizeView: false,
      showKanbanView: false
    })
  },

  bumpPluginVersion: () => {
    set((state) => ({ pluginVersion: state.pluginVersion + 1 }))
  },

  pendingEvolution: false,
  setPendingEvolution: (v) => set({ pendingEvolution: v }),

  skillGenerationAgent: { phase: null, streamedText: "", errorText: "" },
  setSkillGenerationPhase: (phase, text = "") =>
    set({
      skillGenerationAgent:
        phase === null
          ? { phase: null, streamedText: "", errorText: "" }
          : phase === "error"
            ? { phase: "error", streamedText: "", errorText: text }
            : { phase, streamedText: "", errorText: "" }
    }),
  appendSkillGenerationToken: (token) =>
    set((state) => ({
      skillGenerationAgent: {
        ...state.skillGenerationAgent,
        streamedText: state.skillGenerationAgent.streamedText + token
      }
    }))
}))
