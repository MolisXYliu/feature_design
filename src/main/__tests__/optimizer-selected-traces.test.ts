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

function makeTrace(traceId: string, activeSkills: string[] = []): AgentTrace {
  return {
    traceId,
    threadId: "thread-1",
    startedAt: "2026-03-13T10:00:00.000Z",
    endedAt: "2026-03-13T10:00:05.000Z",
    durationMs: 5000,
    userMessage: `request-${traceId}`,
    modelId: "openai/gpt-4.1",
    steps: [
      {
        index: 0,
        startedAt: "2026-03-13T10:00:01.000Z",
        assistantText: "do work",
        toolCalls: [{ name: "read_file", args: { path: "README.md" } }]
      }
    ],
    totalToolCalls: 1,
    outcome: "success",
    activeSkills
  }
}

class FakeAggregateModel {
  prompts: string[] = []

  async invoke(messages: unknown[]): Promise<{ content: string }> {
    const human = messages.find((m) => m instanceof HumanMessage) as HumanMessage
    const text = String(human.content)
    this.prompts.push(text)

    return {
      content: JSON.stringify([
        {
          skillId: "project_summary_skill",
          name: "Project Summary",
          description: "Summarize a project quickly",
          rationale: "aggregate",
          content: "---\nname: project-summary\ndescription: summarize project\n---\n# Overview"
        }
      ])
    }
  }
}

describe("selected traces offline optimization", () => {
  beforeEach(() => {
    readThreadTracesMock.mockReset()
    readRecentTracesMock.mockReset()
  })

  it("analyzes selected traces as one aggregated batch", async () => {
    const model = new FakeAggregateModel()
    const traces = [makeTrace("trace-a"), makeTrace("trace-c")]

    const optimizer = new SkillOptimizer({
      model: model as never,
      traces
    })

    const result = await optimizer.run()

    expect(readThreadTracesMock).not.toHaveBeenCalled()
    expect(readRecentTracesMock).not.toHaveBeenCalled()
    expect(model.prompts).toHaveLength(1)
    expect(model.prompts[0]).toContain("Execution Traces to Analyze (2 traces)")
    expect(model.prompts[0]).toContain("Trace trace-a")
    expect(model.prompts[0]).toContain("Trace trace-c")
    expect(result.tracesAnalyzed).toBe(2)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].sourceTraceIds).toEqual(["trace-a", "trace-c"])
    expect(result.summary).toContain("选中内容")
  })

  it("patches an existing used skill instead of creating a new one", async () => {
    const model = {
      async invoke(): Promise<{ content: string }> {
        return {
          content: JSON.stringify([
            {
              action: "patch",
              skillId: "generate-project-overview",
              name: "Generate Project Overview",
              description: "Use when summarizing and documenting a codebase",
              rationale: "The selected traces already relied on this skill and exposed update opportunities",
              content: "---\nname: generate-project-overview\ndescription: updated\n---\n# Overview"
            }
          ])
        }
      }
    }

    const optimizer = new SkillOptimizer({
      model: model as never,
      traces: [makeTrace("trace-a", ["generate-project-overview"])]
    })

    const result = await optimizer.run()

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].action).toBe("patch")
    expect(result.candidates[0].skillId).toBe("generate-project-overview")
  })

  it("parses think-wrapped JSON arrays from the offline optimizer model", async () => {
    const model = {
      async invoke(): Promise<{ content: string }> {
        return {
          content: `<think>
I should inspect the selected traces, compare them to existing skills, then output the final JSON array.
</think>

Here is the final answer:
[
  {
    "action": "create",
    "skillId": "html_bugfix_report",
    "name": "HTML Bugfix Report",
    "description": "Use when the user asks for a bugfix plan and wants an HTML report as output.",
    "rationale": "The selected traces show a repeatable workflow for analysis plus HTML report generation.",
    "content": "---\\nname: html-bugfix-report\\ndescription: html bugfix report\\n---\\n# Overview"
  }
]`
        }
      }
    }

    const optimizer = new SkillOptimizer({
      model: model as never,
      traces: [makeTrace("trace-a"), makeTrace("trace-b")]
    })

    const result = await optimizer.run()

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].skillId).toBe("html_bugfix_report")
    expect(result.candidates[0].action).toBe("create")
  })

  it("rejects create proposals for a different skill when selected traces already used a skill", async () => {
    const model = {
      async invoke(): Promise<{ content: string }> {
        return {
          content: JSON.stringify([
            {
              action: "create",
              skillId: "new-summary-skill",
              name: "New Summary Skill",
              description: "Use for summaries",
              rationale: "Should have patched the existing skill instead",
              content: "---\nname: new-summary-skill\ndescription: new\n---\n# Overview"
            }
          ])
        }
      }
    }

    const optimizer = new SkillOptimizer({
      model: model as never,
      traces: [makeTrace("trace-a", ["generate-project-overview"])]
    })

    const result = await optimizer.run()

    expect(result.candidates).toHaveLength(0)
  })
})
