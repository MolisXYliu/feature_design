import { afterEach, describe, expect, it } from "vitest"
import {
  appendSkillProposalWindowTurn,
  buildSkillProposalWindowContext,
  buildToolCallSummary,
  resetSkillProposalWindow,
  snapshotSkillProposalWindow
} from "../agent/skill-evolution/proposal-window"

describe("skill proposal window", () => {
  afterEach(() => {
    resetSkillProposalWindow("thread-a")
    resetSkillProposalWindow("thread-b")
  })

  it("aggregates duplicate tool names into a compact summary", () => {
    expect(buildToolCallSummary(["read_file", "read_file", "list_dir"])).toBe(
      "read_file x2, list_dir x1"
    )
  })

  it("stores turns per thread and preserves order", () => {
    appendSkillProposalWindowTurn("thread-a", {
      userMessage: "first request",
      assistantText: "first answer",
      toolCallNames: ["read_file"],
      toolCallCount: 1,
      status: "success",
      usedLoadedSkill: false,
      activeSkillNames: [],
      finishedAt: "2025-01-01T00:00:00.000Z"
    })
    appendSkillProposalWindowTurn("thread-a", {
      userMessage: "second request",
      assistantText: "second answer",
      toolCallNames: ["list_dir"],
      toolCallCount: 1,
      status: "error",
      errorMessage: "boom",
      usedLoadedSkill: false,
      activeSkillNames: [],
      finishedAt: "2025-01-01T00:01:00.000Z"
    })

    const turns = snapshotSkillProposalWindow("thread-a")
    expect(turns).toHaveLength(2)
    expect(turns[0].userMessage).toBe("first request")
    expect(turns[1].status).toBe("error")
    expect(snapshotSkillProposalWindow("thread-b")).toEqual([])
  })

  it("builds a multi-turn context for worthiness and proposal generation", () => {
    appendSkillProposalWindowTurn("thread-a", {
      userMessage: "先排查白屏",
      assistantText: "我先看 renderer 崩溃点",
      toolCallNames: ["read_file", "list_dir"],
      toolCallCount: 2,
      status: "error",
      errorMessage: "renderer crashed",
      usedLoadedSkill: false,
      activeSkillNames: [],
      finishedAt: "2025-01-01T00:00:00.000Z"
    })
    appendSkillProposalWindowTurn("thread-a", {
      userMessage: "继续修复并补测试",
      assistantText: "已修复并补了回归测试",
      toolCallNames: ["read_file", "edit_file", "run_tests"],
      toolCallCount: 3,
      status: "success",
      usedLoadedSkill: false,
      activeSkillNames: [],
      finishedAt: "2025-01-01T00:05:00.000Z"
    })

    const context = buildSkillProposalWindowContext(snapshotSkillProposalWindow("thread-a"))

    expect(context.turnCount).toBe(2)
    expect(context.successCount).toBe(1)
    expect(context.errorCount).toBe(1)
    expect(context.toolCallCount).toBe(5)
    expect(context.toolCallNames).toEqual([
      "read_file",
      "list_dir",
      "read_file",
      "edit_file",
      "run_tests"
    ])
    expect(context.toolCallSummary).toBe("read_file x2, list_dir x1, edit_file x1, run_tests x1")
    expect(context.transcript).toContain("Turn 1 [error]")
    expect(context.transcript).toContain("renderer crashed")
    expect(context.transcript).toContain("Turn 2 [success]")
    expect(context.transcript).toContain("继续修复并补测试")
  })

  it("marks the whole window as skill-used when any turn used a loaded skill", () => {
    appendSkillProposalWindowTurn("thread-a", {
      userMessage: "看下项目",
      assistantText: "我使用 generate-project-overview 技能",
      toolCallNames: ["read_file"],
      toolCallCount: 1,
      status: "success",
      usedLoadedSkill: true,
      activeSkillNames: ["generate-project-overview"],
      finishedAt: "2025-01-01T00:00:00.000Z"
    })
    appendSkillProposalWindowTurn("thread-a", {
      userMessage: "继续分析 bug",
      assistantText: "我补充分析完成",
      toolCallNames: ["search_code"],
      toolCallCount: 1,
      status: "success",
      usedLoadedSkill: false,
      activeSkillNames: [],
      finishedAt: "2025-01-01T00:03:00.000Z"
    })

    const context = buildSkillProposalWindowContext(snapshotSkillProposalWindow("thread-a"))
    expect(context.usedLoadedSkill).toBe(true)
    expect(context.activeSkillNames).toEqual(["generate-project-overview"])
  })

  it("reset clears the window for the target thread", () => {
    appendSkillProposalWindowTurn("thread-a", {
      userMessage: "foo",
      assistantText: "bar",
      toolCallNames: [],
      toolCallCount: 0,
      status: "success",
      usedLoadedSkill: false,
      activeSkillNames: [],
      finishedAt: "2025-01-01T00:00:00.000Z"
    })

    resetSkillProposalWindow("thread-a")
    expect(snapshotSkillProposalWindow("thread-a")).toEqual([])
  })
})
