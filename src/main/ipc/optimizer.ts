/**
 * IPC handlers for the Skill Optimizer (offline evolution loop).
 *
 * Channels:
 *   optimizer:run       — Invoke (renderer → main): start an optimization run
 *   optimizer:candidates — Handle (renderer → main): get current candidates
 *   optimizer:approve   — Handle (renderer → main): approve a candidate → writes skill
 *   optimizer:reject    — Handle (renderer → main): reject a candidate
 *   optimizer:clear     — Handle (renderer → main): clear all candidates
 *   optimizer:traces    — Handle (renderer → main): list recent traces (metadata only)
 */

import { IpcMain } from "electron"
import { ChatOpenAI } from "@langchain/openai"
import { getCustomModelConfigs } from "../storage"
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
  listTracedThreads,
  readThreadTraces
} from "../agent/trace/collector"
import { getCustomSkillsDir, invalidateEnabledSkillsCache } from "../storage"
import { BrowserWindow } from "electron"

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────
// Apply an approved candidate to disk
// ─────────────────────────────────────────────────────────

function applyCandidate(skillId: string, content: string): { success: boolean; error?: string } {
  try {
    const skillDir = join(getCustomSkillsDir(), skillId)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8")
    invalidateEnabledSkillsCache()
    // Notify renderer that skills changed
    notifyRenderer("skills:changed")
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ─────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────

export function registerOptimizerHandlers(ipcMain: IpcMain): void {
  console.log("[Optimizer] Registering optimizer handlers...")

  /**
   * Run the optimization loop.
   * Returns OptimizationRunResult with generated candidates.
   * Candidates are also stored in memory for subsequent calls.
   */
  ipcMain.handle(
    "optimizer:run",
    async (_event, opts?: { threadId?: string; traceLimit?: number }): Promise<OptimizationRunResult> => {
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

      const optimizer = new SkillOptimizer({
        model,
        traceLimit: opts?.traceLimit ?? 30,
        threadId: opts?.threadId
      })

      const result = await optimizer.run()

      // Store candidates in memory
      if (result.candidates.length > 0) {
        // Merge with existing pending candidates (don't discard previous pending ones)
        const existing = getCandidates().filter((c) => c.status === "pending")
        const existingIds = new Set(existing.map((c) => c.skillId))
        const newOnes = result.candidates.filter((c) => !existingIds.has(c.skillId))
        setCandidates([...existing, ...newOnes])
        result.candidates = getCandidates().filter((c) => c.status === "pending")
      }

      console.log(`[Optimizer] Run complete: ${result.summary}`)
      return result
    }
  )

  /**
   * Get current candidates (all statuses).
   */
  ipcMain.handle("optimizer:candidates", async (): Promise<ReturnType<typeof getCandidates>> => {
    return getCandidates()
  })

  /**
   * Approve a candidate — writes the skill to disk.
   * Returns { success, skillId, error? }
   */
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
        // Roll back status
        updateCandidateStatus(candidateId, "rejected")
        return { success: false, skillId: candidate.skillId, error: result.error }
      }

      console.log(`[Optimizer] Approved and applied skill: ${candidate.skillId}`)
      return { success: true, skillId: candidate.skillId }
    }
  )

  /**
   * Reject a candidate (does not write to disk).
   */
  ipcMain.handle(
    "optimizer:reject",
    async (_event, { candidateId }: { candidateId: string }): Promise<{ success: boolean }> => {
      const candidate = updateCandidateStatus(candidateId, "rejected")
      console.log(`[Optimizer] Rejected candidate: ${candidateId}`)
      return { success: !!candidate }
    }
  )

  /**
   * Clear all candidates from memory.
   */
  ipcMain.handle("optimizer:clear", async (): Promise<void> => {
    clearCandidates()
  })

  /**
   * List recent traces (metadata only — no steps, to keep payload small).
   */
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
}
