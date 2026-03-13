import { describe, expect, it } from "vitest"
import { ToolCallCounter } from "../agent/skill-evolution/tool-call-counter"

describe("ToolCallCounter", () => {
  it("deduplicates by tool_call id across values/messages", () => {
    const c = new ToolCallCounter()
    const tc = { id: "toolu_1", name: "read_file", args: { file_path: "SKILL.md" } }
    expect(c.register(tc, "ai_1", 0)).toBe(true)
    expect(c.register(tc, "ai_1", 0)).toBe(false)
    expect(c.getCount()).toBe(1)
    expect(c.getNames()).toEqual(["read_file"])
  })

  it("deduplicates calls without id using message+index+args key", () => {
    const c = new ToolCallCounter()
    const tc1 = { name: "ls", args: { path: "/tmp" } }
    const tc2 = { name: "ls", args: { path: "/tmp" } }
    expect(c.register(tc1, "ai_2", 0)).toBe(true)
    expect(c.register(tc2, "ai_2", 0)).toBe(false)
    expect(c.register(tc2, "ai_3", 0)).toBe(true)
    expect(c.getCount()).toBe(2)
  })
})

