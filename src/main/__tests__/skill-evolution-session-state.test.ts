import { afterEach, describe, expect, it } from "vitest"
import { getToolCallCount, incrementToolCallCount } from "../agent/runtime"
import {
  appendSkillProposalWindowTurn,
  snapshotSkillProposalWindow
} from "../agent/skill-evolution/proposal-window"
import {
  resetSkillEvolutionSession,
  shouldResetSkillEvolutionSessionAfterIntent
} from "../agent/skill-evolution/session-state"

describe("skill evolution session state", () => {
  afterEach(() => {
    resetSkillEvolutionSession("thread-a")
  })

  it("resets both the per-thread tool counter and proposal window", () => {
    incrementToolCallCount("thread-a")
    incrementToolCallCount("thread-a")
    appendSkillProposalWindowTurn("thread-a", {
      userMessage: "foo",
      assistantText: "bar",
      toolCallNames: ["read_file", "grep"],
      toolCallCount: 2,
      status: "success",
      usedLoadedSkill: false,
      activeSkillNames: [],
      finishedAt: "2025-01-01T00:00:00.000Z"
    })

    expect(getToolCallCount("thread-a")).toBe(2)
    expect(snapshotSkillProposalWindow("thread-a")).toHaveLength(1)

    resetSkillEvolutionSession("thread-a")

    expect(getToolCallCount("thread-a")).toBe(0)
    expect(snapshotSkillProposalWindow("thread-a")).toEqual([])
  })

  it("only resets after the first intent confirm, not on skip", () => {
    expect(shouldResetSkillEvolutionSessionAfterIntent("accept")).toBe(true)
    expect(shouldResetSkillEvolutionSessionAfterIntent("skip")).toBe(false)
  })
})
