import { beforeEach, describe, expect, it, vi } from "vitest"
import { HumanMessage } from "@langchain/core/messages"
import type { AgentTrace } from "../agent/trace/types"

const { readThreadTracesMock, readRecentTracesMock } = vi.hoisted(() => ({
  readThreadTracesMock: vi.fn<(threadId: string) => AgentTrace[]>(),
  readRecentTracesMock: vi.fn<() => AgentTrace[]>()
}))

vi.mock("../agent/trace/collector", () => ({
  readThreadTraces: readThreadTracesMock,
  readRecentTraces: readRecentTracesMock
}))

vi.mock("../storage", () => ({
  getCustomSkillsDir: () => "/tmp/cmbcowork-nonexistent-skills"
}))

import { SkillOptimizer } from "../agent/optimizer/skill-optimizer"

function makeTrace(traceId: string, userMessage: string, toolCalls: number): AgentTrace {
  return {
    traceId,
    threadId: "thread-1",
    startedAt: "2026-03-15T10:00:00.000Z",
    endedAt: "2026-03-15T10:00:10.000Z",
    durationMs: 10000,
    userMessage,
    modelId: "custom:minmax",
    steps: [
      {
        index: 0,
        startedAt: "2026-03-15T10:00:02.000Z",
        assistantText: "Inspect files and prepare fix plan",
        toolCalls: Array.from({ length: toolCalls }, (_, idx) => ({
          name: idx % 2 === 0 ? "read_file" : "write_file",
          args: { path: `file-${idx}.md` }
        }))
      }
    ],
    totalToolCalls: toolCalls,
    outcome: "success",
    activeSkills: []
  }
}

class FakeAggregateModel {
  prompts: string[] = []

  async invoke(messages: unknown[]): Promise<{ content: string }> {
    const human = messages.find((message) => message instanceof HumanMessage) as HumanMessage
    const content = String(human.content)
    this.prompts.push(content)

    return {
      content: JSON.stringify([
        {
          skillId: "bugfix_review_skill",
          name: "Bugfix Review",
          description: "Use when the user asks for code bug analysis and a concrete repair plan",
          rationale: "The session contains repeated code inspection and remediation steps",
          content: "---\nname: bugfix-review\ndescription: bugfix review\n---\n# Overview"
        }
      ])
    }
  }
}

describe("SkillOptimizer thread-scoped offline analysis", () => {
  beforeEach(() => {
    readThreadTracesMock.mockReset()
    readRecentTracesMock.mockReset()
  })

  it("aggregates traces from the selected thread into a single offline analysis run", async () => {
    const model = new FakeAggregateModel()
    const traces = [
      makeTrace("trace-a", "帮我查一下 src/main/ipc/agent.ts，说明功能并找出潜在 bug", 5),
      makeTrace("trace-b", "设计修复方案，并以 html 的形式生成一个报告", 4)
    ]
    readThreadTracesMock.mockReturnValue(traces)
    readRecentTracesMock.mockReturnValue([])

    const optimizer = new SkillOptimizer({
      model: model as never,
      threadId: "thread-1"
    })

    const result = await optimizer.run()

    expect(readThreadTracesMock).toHaveBeenCalledWith("thread-1")
    expect(readRecentTracesMock).not.toHaveBeenCalled()
    expect(model.prompts).toHaveLength(1)
    expect(model.prompts[0]).toContain("Execution Traces to Analyze (2 traces)")
    expect(model.prompts[0]).toContain("Trace trace-a")
    expect(model.prompts[0]).toContain("Trace trace-b")
    expect(result.tracesAnalyzed).toBe(2)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].sourceTraceIds).toEqual(["trace-a", "trace-b"])
    expect(result.summary).toContain("当前会话")
  })
})
