/**
 * IPC handlers for the Skill Optimizer (offline evolution loop).
 *
 * Channels:
 *   optimizer:run          — Invoke (renderer → main): start an optimization run
 *   optimizer:candidates   — Handle (renderer → main): get current candidates
 *   optimizer:approve      — Handle (renderer → main): approve a candidate → writes skill
 *   optimizer:reject       — Handle (renderer → main): reject a candidate
 *   optimizer:clear        — Handle (renderer → main): clear all candidates
 *   optimizer:traces       — Handle (renderer → main): list recent traces (metadata only)
 *   optimizer:traceDetail  — Handle (renderer → main): get full trace detail
 *   optimizer:deleteTraces — Handle (renderer → main): delete one or more traces
 */

import { BrowserWindow, IpcMain } from "electron"
import { ChatOpenAI } from "@langchain/openai"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import {
  SkillOptimizer,
  setCandidates,
  getCandidates,
  updateCandidateStatus,
  clearCandidates,
  type OptimizationRunResult
} from "../agent/optimizer/skill-optimizer"
import {
  readRecentTraces,
  readThreadTraces,
  readTraceById,
  deleteTraces
} from "../agent/trace/collector"
import { buildTraceTree } from "../agent/trace/tree-builder"
import type { AgentTrace } from "../agent/trace/types"
import {
  getCustomModelConfigs,
  getCustomSkillsDir,
  invalidateEnabledSkillsCache,
  isOnlineSkillEvolutionEnabled,
  setOnlineSkillEvolutionEnabled,
  isSkillAutoProposeEnabled,
  setSkillAutoProposeEnabled,
  getSkillEvolutionThreshold,
  setSkillEvolutionThreshold
} from "../storage"

function notifyRenderer(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function getDefaultModel(): ChatOpenAI | null {
  const configs = getCustomModelConfigs()
  const config = configs[0]
  if (!config || !config.apiKey) return null
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: 4096,
    temperature: 0.3
  })
}

function mergePendingCandidates(newCandidates: OptimizationRunResult["candidates"]): OptimizationRunResult["candidates"] {
  if (newCandidates.length === 0) return getCandidates().filter((c) => c.status === "pending")

  const existing = getCandidates().filter((c) => c.status === "pending")
  const existingIds = new Set(existing.map((c) => c.skillId))
  const fresh = newCandidates.filter((c) => !existingIds.has(c.skillId))
  setCandidates([...existing, ...fresh])
  return getCandidates().filter((c) => c.status === "pending")
}

function applyCandidate(skillId: string, content: string): { success: boolean; error?: string } {
  try {
    const skillDir = join(getCustomSkillsDir(), skillId)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8")
    invalidateEnabledSkillsCache()
    notifyRenderer("skills:changed")
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export function registerOptimizerHandlers(ipcMain: IpcMain): void {
  console.log("[Optimizer] Registering optimizer handlers...")

  ipcMain.handle(
    "optimizer:run",
    async (
      _event,
      opts?: {
        threadId?: string
        traceLimit?: number
        mode?: "auto" | "selected"
        traceIds?: string[]
      }
    ): Promise<OptimizationRunResult> => {
      console.log("[Optimizer] Starting optimization run...", opts)

      const model = getDefaultModel()
      if (!model) {
        return {
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          tracesAnalyzed: 0,
          candidates: [],
          summary: "未找到可用的模型配置，请先在设置中添加 API Key。"
        }
      }

      const runMode = opts?.mode ?? "auto"

      if (runMode === "selected") {
        const selectedIds = [...new Set(opts?.traceIds ?? [])]
        const selectedTraces = selectedIds
          .map((traceId) => readTraceById(traceId))
          .filter((trace): trace is AgentTrace => !!trace)

        if (selectedTraces.length === 0) {
          return {
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            tracesAnalyzed: 0,
            candidates: [],
            summary: "未找到可分析的 trace，请重新选择后再试。"
          }
        }

        const optimizer = new SkillOptimizer({
          model,
          traces: selectedTraces
        })
        const runResult = await optimizer.run()

        return {
          startedAt: runResult.startedAt,
          endedAt: runResult.endedAt,
          tracesAnalyzed: runResult.tracesAnalyzed,
          candidates: mergePendingCandidates(runResult.candidates),
          summary: runResult.summary
        }
      }

      const optimizer = new SkillOptimizer({
        model,
        traceLimit: opts?.traceLimit ?? 30,
        threadId: opts?.threadId
      })

      const result = await optimizer.run()
      result.candidates = mergePendingCandidates(result.candidates)
      console.log(`[Optimizer] Run complete: ${result.summary}`)
      return result
    }
  )

  ipcMain.handle("optimizer:candidates", async (): Promise<ReturnType<typeof getCandidates>> => {
    return getCandidates()
  })

  ipcMain.handle(
    "optimizer:approve",
    async (
      _event,
      { candidateId }: { candidateId: string }
    ): Promise<{ success: boolean; skillId?: string; error?: string }> => {
      const candidate = updateCandidateStatus(candidateId, "approved")
      if (!candidate) {
        return { success: false, error: `Candidate ${candidateId} not found` }
      }

      const result = applyCandidate(candidate.skillId, candidate.proposedContent)
      if (!result.success) {
        updateCandidateStatus(candidateId, "rejected")
        return { success: false, skillId: candidate.skillId, error: result.error }
      }

      console.log(`[Optimizer] Approved and applied skill: ${candidate.skillId}`)
      return { success: true, skillId: candidate.skillId }
    }
  )

  ipcMain.handle(
    "optimizer:reject",
    async (_event, { candidateId }: { candidateId: string }): Promise<{ success: boolean }> => {
      const candidate = updateCandidateStatus(candidateId, "rejected")
      console.log(`[Optimizer] Rejected candidate: ${candidateId}`)
      return { success: !!candidate }
    }
  )

  ipcMain.handle("optimizer:clear", async (): Promise<void> => {
    clearCandidates()
  })

  ipcMain.handle(
    "optimizer:traces",
    async (
      _event,
      opts?: { threadId?: string; limit?: number }
    ): Promise<
      Array<{
        traceId: string
        threadId: string
        startedAt: string
        durationMs: number
        userMessage: string
        totalToolCalls: number
        outcome: string
        activeSkills: string[]
      }>
    > => {
      const traces = opts?.threadId
        ? readThreadTraces(opts.threadId)
        : readRecentTraces(opts?.limit ?? 20)

      return traces.map(({ traceId, threadId, startedAt, durationMs, userMessage, totalToolCalls, outcome, activeSkills }) => ({
        traceId,
        threadId,
        startedAt,
        durationMs,
        userMessage,
        totalToolCalls,
        outcome,
        activeSkills
      }))
    }
  )

  ipcMain.handle(
    "optimizer:traceDetail",
    async (_event, { traceId }: { traceId: string }): Promise<AgentTrace | null> => {
      const found = readTraceById(traceId)
      if (!found) return null
      return {
        ...found,
        nodes: buildTraceTree(found)
      }
    }
  )

  ipcMain.handle(
    "optimizer:deleteTraces",
    async (
      _event,
      { traceIds }: { traceIds: string[] }
    ): Promise<{ deletedIds: string[]; failed: Array<{ traceId: string; error: string }> }> => {
      const result = deleteTraces(traceIds ?? [])
      if (result.deletedIds.length > 0) {
        notifyRenderer("optimizer:tracesDeleted", { deletedIds: result.deletedIds })
      }
      return result
    }
  )

  ipcMain.handle("optimizer:getOnlineSkillEvolutionEnabled", async (): Promise<boolean> => {
    return isOnlineSkillEvolutionEnabled()
  })

  ipcMain.handle("optimizer:setOnlineSkillEvolutionEnabled", async (_event, enabled: boolean): Promise<void> => {
    setOnlineSkillEvolutionEnabled(enabled)
  })

  ipcMain.handle("optimizer:getAutoPropose", async (): Promise<boolean> => {
    return isSkillAutoProposeEnabled()
  })

  ipcMain.handle("optimizer:setAutoPropose", async (_event, enabled: boolean): Promise<void> => {
    setSkillAutoProposeEnabled(enabled)
  })

  ipcMain.handle("optimizer:getThreshold", async (): Promise<number> => {
    return getSkillEvolutionThreshold()
  })

  ipcMain.handle("optimizer:setThreshold", async (_event, value: number): Promise<void> => {
    setSkillEvolutionThreshold(value)
  })
}
