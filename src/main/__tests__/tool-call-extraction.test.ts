/**
 * Tests for tool-call extraction from LangGraph stream chunks.
 *
 * These tests verify the parsing logic used in ipc/agent.ts to count
 * tool calls and record trace steps, without needing a running Electron app.
 *
 * LangGraph stream format (from stream-converter.ts analysis):
 *
 * mode="messages" chunk:
 *   data = [msgChunk, metadata?]
 *   msgChunk = {
 *     lc: 1,
 *     type: "constructor",
 *     id: ["langchain_core", "messages", "AIMessageChunk"],  // or "AIMessage"
 *     kwargs: {
 *       id: "msg_01XYZ",
 *       content: "I'll read the file..." | [{ type: "text", text: "..." }, { type: "tool_use", ... }],
 *       tool_calls: [{ id: "toolu_01", name: "read_file", args: { path: "..." } }],
 *       ...
 *     }
 *   }
 *
 * mode="values" chunk:
 *   data = {
 *     messages: [SerializedMsg, ...],  // full message history
 *     ...
 *   }
 */

import { describe, it, expect, beforeEach } from "vitest"

// ─────────────────────────────────────────────────────────
// Extracted logic under test
// (copied from agent.ts so we can unit-test without Electron)
// ─────────────────────────────────────────────────────────

interface ToolCall {
  name: string
  args: Record<string, unknown>
  id?: string
}

interface ExtractedStep {
  msgId: string
  assistantText: string
  toolCalls: ToolCall[]
}

/**
 * Mirrors the tool-call extraction logic in ipc/agent.ts (messages mode).
 * Returns null if this chunk has no tool calls.
 */
function extractFromMessagesChunk(data: unknown): ExtractedStep | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [msgChunk] = data as [any]
  if (!msgChunk) return null

  const kwargs = (msgChunk.kwargs || {}) as Record<string, unknown>
  const classId: string[] = Array.isArray(msgChunk.id) ? msgChunk.id : []
  const className = classId[classId.length - 1] || ""

  const isAI = className.includes("AI") || msgChunk.type === "ai"
  if (!isAI) return null

  const toolCalls = kwargs.tool_calls as ToolCall[] | undefined
  if (!toolCalls || toolCalls.length === 0) return null

  const msgId = (kwargs.id as string) || ""
  const rawContent = kwargs.content ?? msgChunk.content
  let assistantText = ""
  if (typeof rawContent === "string") {
    assistantText = rawContent
  } else if (Array.isArray(rawContent)) {
    assistantText = (rawContent as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === "text")
      .map((b) => b.text ?? "")
      .join("")
  }

  return { msgId, assistantText, toolCalls }
}

/**
 * Deduplication logic: only count each AI message ID once.
 */
function createToolCallCounter() {
  const counted = new Set<string>()
  let total = 0

  function process(data: unknown): ToolCall[] {
    const step = extractFromMessagesChunk(data)
    if (!step) return []
    if (step.msgId && counted.has(step.msgId)) return [] // already counted
    if (step.msgId) counted.add(step.msgId)
    total += step.toolCalls.length
    return step.toolCalls
  }

  return { process, getTotal: () => total, getCounted: () => counted.size }
}

// ─────────────────────────────────────────────────────────
// Fixtures: realistic LangGraph message chunks
// ─────────────────────────────────────────────────────────

/** Single tool call, Anthropic-style (content is array with tool_use block) */
const CHUNK_READ_FILE = [
  {
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: {
      id: "msg_01Read",
      content: [
        { type: "text", text: "Let me read the file." },
        { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "README.md" } }
      ],
      tool_calls: [{ id: "toolu_01", name: "read_file", args: { path: "README.md" } }],
      response_metadata: { usage: { input_tokens: 100, output_tokens: 20 } }
    }
  }
]

/** Two tool calls in one message */
const CHUNK_TWO_TOOLS = [
  {
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: {
      id: "msg_02Two",
      content: "I'll list and read.",
      tool_calls: [
        { id: "toolu_02", name: "list_directory", args: { path: "." } },
        { id: "toolu_03", name: "read_file", args: { path: "package.json" } }
      ]
    }
  }
]

/** Text-only message — no tool calls */
const CHUNK_TEXT_ONLY = [
  {
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: {
      id: "msg_03Text",
      content: "Here is the summary of the project.",
      tool_calls: []
    }
  }
]

/** Human message — should be ignored */
const CHUNK_HUMAN = [
  {
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: { id: "msg_04Human", content: "Help me", tool_calls: [] }
  }
]

/** Tool result message — should be ignored */
const CHUNK_TOOL_RESULT = [
  {
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", "ToolMessage"],
    kwargs: { id: "msg_05Tool", content: "file content here", tool_call_id: "toolu_01" }
  }
]

/** Same AI message ID arriving twice (stream replay / values snapshot) */
const CHUNK_READ_FILE_DUPLICATE = [...CHUNK_READ_FILE]

/** Write file tool call */
const CHUNK_WRITE_FILE = [
  {
    lc: 1,
    type: "constructor",
    id: ["langchain_core", "messages", "AIMessageChunk"],
    kwargs: {
      id: "msg_06Write",
      content: [{ type: "text", text: "Now I'll write the output file." }],
      tool_calls: [{ id: "toolu_04", name: "write_file", args: { path: "README_CN.md", content: "# 项目介绍" } }]
    }
  }
]

// ─────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────

describe("extractFromMessagesChunk", () => {
  it("extracts tool_calls from AI message with single tool call", () => {
    const result = extractFromMessagesChunk(CHUNK_READ_FILE)
    expect(result).not.toBeNull()
    expect(result!.msgId).toBe("msg_01Read")
    expect(result!.toolCalls).toHaveLength(1)
    expect(result!.toolCalls[0].name).toBe("read_file")
    expect(result!.toolCalls[0].args).toEqual({ path: "README.md" })
  })

  it("extracts assistantText from array content", () => {
    const result = extractFromMessagesChunk(CHUNK_READ_FILE)
    expect(result!.assistantText).toBe("Let me read the file.")
  })

  it("extracts assistantText from string content", () => {
    const result = extractFromMessagesChunk(CHUNK_TWO_TOOLS)
    expect(result!.assistantText).toBe("I'll list and read.")
  })

  it("extracts multiple tool_calls from one message", () => {
    const result = extractFromMessagesChunk(CHUNK_TWO_TOOLS)
    expect(result).not.toBeNull()
    expect(result!.toolCalls).toHaveLength(2)
    expect(result!.toolCalls.map((t) => t.name)).toEqual(["list_directory", "read_file"])
  })

  it("returns null for text-only AI message", () => {
    const result = extractFromMessagesChunk(CHUNK_TEXT_ONLY)
    expect(result).toBeNull()
  })

  it("returns null for HumanMessage", () => {
    const result = extractFromMessagesChunk(CHUNK_HUMAN)
    expect(result).toBeNull()
  })

  it("returns null for ToolMessage", () => {
    const result = extractFromMessagesChunk(CHUNK_TOOL_RESULT)
    expect(result).toBeNull()
  })
})

describe("tool call counter (deduplication)", () => {
  it("counts a single tool call correctly", () => {
    const counter = createToolCallCounter()
    const tools = counter.process(CHUNK_READ_FILE)
    expect(tools).toHaveLength(1)
    expect(counter.getTotal()).toBe(1)
  })

  it("counts multiple tool calls in one message", () => {
    const counter = createToolCallCounter()
    const tools = counter.process(CHUNK_TWO_TOOLS)
    expect(tools).toHaveLength(2)
    expect(counter.getTotal()).toBe(2)
  })

  it("does NOT double-count the same message ID (stream replay)", () => {
    const counter = createToolCallCounter()
    counter.process(CHUNK_READ_FILE)           // first occurrence
    counter.process(CHUNK_READ_FILE_DUPLICATE) // same ID again
    expect(counter.getTotal()).toBe(1)         // still 1, not 2
    expect(counter.getCounted()).toBe(1)
  })

  it("counts across multiple distinct messages", () => {
    const counter = createToolCallCounter()
    counter.process(CHUNK_READ_FILE)   // 1 tool call
    counter.process(CHUNK_TWO_TOOLS)   // 2 tool calls
    counter.process(CHUNK_WRITE_FILE)  // 1 tool call
    expect(counter.getTotal()).toBe(4)
    expect(counter.getCounted()).toBe(3) // 3 distinct AI messages
  })

  it("ignores non-tool messages in count", () => {
    const counter = createToolCallCounter()
    counter.process(CHUNK_TEXT_ONLY)
    counter.process(CHUNK_HUMAN)
    counter.process(CHUNK_TOOL_RESULT)
    expect(counter.getTotal()).toBe(0)
  })

  it("simulates a realistic 5-tool-call session (agentscope task)", () => {
    // Mirrors the session from the screenshot:
    // list_dir(agentscope-1.0.16) → read(README.md) → read(pyproject.toml)
    //   → list_dir(src) → write(README_CN.md)
    const counter = createToolCallCounter()
    const session: unknown[] = [
      [{ lc:1, id:["langchain_core","messages","AIMessageChunk"], kwargs:{
        id:"s1", content:"Let me list the project.", tool_calls:[{name:"list_directory",args:{path:"agentscope-1.0.16"}}] }}],
      [{ lc:1, id:["langchain_core","messages","AIMessageChunk"], kwargs:{
        id:"s2", content:"Now read the README.", tool_calls:[{name:"read_file",args:{path:"README.md"}}] }}],
      [{ lc:1, id:["langchain_core","messages","AIMessageChunk"], kwargs:{
        id:"s3", content:"Check pyproject.", tool_calls:[{name:"read_file",args:{path:"pyproject.toml"}}] }}],
      [{ lc:1, id:["langchain_core","messages","AIMessageChunk"], kwargs:{
        id:"s4", content:"Look at src.", tool_calls:[{name:"list_directory",args:{path:"src"}}] }}],
      [{ lc:1, id:["langchain_core","messages","AIMessageChunk"], kwargs:{
        id:"s5", content:"Write the doc.", tool_calls:[{name:"write_file",args:{path:"README_CN.md",content:"#项目"}}] }}],
      // Text-only final answer
      [{ lc:1, id:["langchain_core","messages","AIMessage"], kwargs:{
        id:"s6", content:"I've created README_CN.md.", tool_calls:[] }}],
    ]

    for (const chunk of session) {
      counter.process(chunk)
    }
    expect(counter.getTotal()).toBe(5)
    expect(counter.getCounted()).toBe(5)
  })
})

describe("edge cases", () => {
  it("handles missing kwargs gracefully", () => {
    const bad = [{ lc: 1, id: ["langchain_core", "messages", "AIMessageChunk"] }]
    expect(() => extractFromMessagesChunk(bad)).not.toThrow()
    expect(extractFromMessagesChunk(bad)).toBeNull()
  })

  it("handles null/undefined data gracefully", () => {
    expect(() => extractFromMessagesChunk([null])).not.toThrow()
    expect(extractFromMessagesChunk([undefined])).toBeNull()
  })

  it("handles empty tool_calls array (not null)", () => {
    const chunk = [{ lc:1, id:["langchain_core","messages","AIMessageChunk"],
      kwargs:{ id:"e1", content:"thinking", tool_calls:[] }}]
    expect(extractFromMessagesChunk(chunk)).toBeNull()
  })

  it("handles AIMessage (non-chunk variant) the same way", () => {
    const chunk = [{ lc:1, id:["langchain_core","messages","AIMessage"],
      kwargs:{ id:"e2", content:"ok", tool_calls:[{name:"bash",args:{cmd:"ls"}}] }}]
    const result = extractFromMessagesChunk(chunk)
    expect(result).not.toBeNull()
    expect(result!.toolCalls[0].name).toBe("bash")
  })
})
