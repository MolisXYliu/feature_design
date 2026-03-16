import { describe, expect, it } from "vitest"
import { buildTraceTree } from "../agent/trace/tree-builder"
import type { AgentTrace } from "../agent/trace/types"

function makeTrace(overrides: Partial<AgentTrace> = {}): AgentTrace {
  return {
    traceId: "trace-1",
    threadId: "thread-1",
    startedAt: "2026-03-13T10:00:00.000Z",
    endedAt: "2026-03-13T10:00:05.000Z",
    durationMs: 5000,
    userMessage: "summarize this project",
    modelId: "openai/gpt-4.1",
    steps: [],
    totalToolCalls: 0,
    outcome: "success",
    activeSkills: [],
    ...overrides
  }
}

describe("buildTraceTree", () => {
  it("returns existing nodes when trace already has nodes", () => {
    const trace = makeTrace({
      nodes: [
        {
          id: "trace:root",
          type: "trace",
          parentId: null,
          startedAt: "2026-03-13T10:00:00.000Z",
          status: "success"
        },
        {
          id: "llm:1",
          type: "llm",
          parentId: "trace:root",
          startedAt: "2026-03-13T10:00:01.000Z",
          status: "success"
        }
      ]
    })

    const nodes = buildTraceTree(trace)
    expect(nodes).toHaveLength(2)
    expect(nodes[0].type).toBe("trace")
    expect(nodes[1].type).toBe("llm")
  })

  it("builds legacy tree from steps/modelCalls", () => {
    const trace = makeTrace({
      steps: [
        {
          index: 0,
          startedAt: "2026-03-13T10:00:01.000Z",
          assistantText: "I will inspect files",
          toolCalls: [
            {
              name: "list_directory",
              args: { path: "." },
              result: "README.md"
            }
          ]
        }
      ],
      modelCalls: [
        {
          messageId: "ai_1",
          startedAt: "2026-03-13T10:00:01.000Z",
          inputMessages: [{ role: "user", content: "analyze" }],
          outputMessage: { role: "assistant", content: "I will inspect files" },
          toolCalls: [{ name: "list_directory", args: { path: "." } }]
        }
      ],
      totalToolCalls: 1
    })

    const nodes = buildTraceTree(trace)
    const types = nodes.map((n) => n.type)

    expect(types).toContain("trace")
    expect(types).toContain("llm")
    expect(types).toContain("tool")
    expect(types).toContain("message")

    const llmNode = nodes.find((n) => n.type === "llm")
    expect(llmNode?.output).toBe("I will inspect files")
  })
})
