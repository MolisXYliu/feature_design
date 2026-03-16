import { describe, expect, it } from "vitest"
import {
  buildWorthinessPrompt,
  getSkillProposalMode,
  parseWorthinessResponse,
  parseSkillProposal,
  shouldJudgeSkillWorthiness,
  shouldProposeSkill,
  stripLLMFormatting
} from "../agent/skill-evolution/skill-proposal-logic"

// ─────────────────────────────────────────────────────────
// stripLLMFormatting
// ─────────────────────────────────────────────────────────

describe("stripLLMFormatting", () => {
  it("returns plain text unchanged", () => {
    expect(stripLLMFormatting('{"a": 1}')).toBe('{"a": 1}')
  })

  it("strips a <think>...</think> block", () => {
    const input = '<think>I need to think about this carefully.</think>{"worthy": true, "reason": "complex"}'
    expect(stripLLMFormatting(input)).toBe('{"worthy": true, "reason": "complex"}')
  })

  it("strips multi-line <think> blocks", () => {
    const input = `<think>
Line one of reasoning.
Line two of reasoning.
</think>
{"worthy": false, "reason": "simple"}`
    expect(stripLLMFormatting(input)).toBe('{"worthy": false, "reason": "simple"}')
  })

  it("strips multiple <think> blocks", () => {
    const input = '<think>first</think><think>second</think>{"key": "value"}'
    expect(stripLLMFormatting(input)).toBe('{"key": "value"}')
  })

  it("is case-insensitive for <think> tags", () => {
    const input = '<THINK>uppercase</THINK>{"a": 1}'
    expect(stripLLMFormatting(input)).toBe('{"a": 1}')
  })

  it("strips ```json opening fence", () => {
    const input = "```json\n{\"a\": 1}\n```"
    expect(stripLLMFormatting(input)).toBe('{"a": 1}')
  })

  it("strips ``` opening fence without json tag", () => {
    const input = "```\n{\"a\": 1}\n```"
    expect(stripLLMFormatting(input)).toBe('{"a": 1}')
  })

  it("strips closing ``` fence", () => {
    const input = '{"a": 1}\n```'
    expect(stripLLMFormatting(input)).toBe('{"a": 1}')
  })

  it("handles <think> block before ```json fence", () => {
    const input = '<think>reasoning</think>\n```json\n{"a": 1}\n```'
    expect(stripLLMFormatting(input)).toBe('{"a": 1}')
  })

  it("trims surrounding whitespace", () => {
    expect(stripLLMFormatting("  hello  ")).toBe("hello")
  })
})

// ─────────────────────────────────────────────────────────
// buildWorthinessPrompt
// ─────────────────────────────────────────────────────────

describe("buildWorthinessPrompt", () => {
  it("contains the actual tool call count in the prompt", () => {
    const prompt = buildWorthinessPrompt(7, 5)
    expect(prompt).toContain("7")
  })

  it("contains the threshold in the prompt", () => {
    const prompt = buildWorthinessPrompt(7, 5)
    expect(prompt).toContain("5+")
  })

  it("lists all 5 saving conditions", () => {
    const prompt = buildWorthinessPrompt(3, 3)
    expect(prompt).toContain("Complex task completed")
    expect(prompt).toContain("Tricky error resolved")
    expect(prompt).toContain("Non-obvious workflow")
    expect(prompt).toContain("User correction led to success")
    expect(prompt).toContain("User explicitly asked to remember")
  })

  it("includes JSON output format instructions", () => {
    const prompt = buildWorthinessPrompt(1, 3)
    expect(prompt).toContain('"worthy"')
    expect(prompt).toContain('"reason"')
  })

  it("instructs model NOT to save simple Q&A", () => {
    const prompt = buildWorthinessPrompt(1, 3)
    expect(prompt).toContain("Do NOT save")
    expect(prompt).toContain("Simple Q&A")
  })
})

// ─────────────────────────────────────────────────────────
// parseWorthinessResponse
// ─────────────────────────────────────────────────────────

describe("parseWorthinessResponse", () => {
  it("parses a valid worthy=true response", () => {
    const raw = '{"worthy": true, "reason": "agent used 7 tool calls"}'
    const result = parseWorthinessResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.worthy).toBe(true)
    expect(result!.reason).toBe("agent used 7 tool calls")
  })

  it("parses a valid worthy=false response", () => {
    const raw = '{"worthy": false, "reason": "simple single-step lookup"}'
    const result = parseWorthinessResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.worthy).toBe(false)
    expect(result!.reason).toBe("simple single-step lookup")
  })

  it("strips <think> tags before parsing", () => {
    const raw = '<think>let me evaluate</think>{"worthy": true, "reason": "complex workflow"}'
    const result = parseWorthinessResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.worthy).toBe(true)
  })

  it("strips markdown fences before parsing", () => {
    const raw = "```json\n{\"worthy\": false, \"reason\": \"too simple\"}\n```"
    const result = parseWorthinessResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.worthy).toBe(false)
  })

  it("parses JSON after think block and explanatory prose", () => {
    const raw = `<think>让我先分析任务复杂度</think>
这个任务具备复用价值，下面给出结构化判断：
{"worthy": true, "reason": "complex workflow with multiple file reads"}`
    const result = parseWorthinessResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.worthy).toBe(true)
    expect(result!.reason).toContain("multiple file reads")
  })

  it("parses JSON when model leaves a stray <think> tag before the object", () => {
    const raw = `<think>
我在思考中
{"worthy": false, "reason": "simple single-file lookup"}`
    const result = parseWorthinessResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.worthy).toBe(false)
  })

  it("prefers the final JSON object after reasoning text", () => {
    const raw = `<think>
分析时我先举一个例子 {"worthy": false, "reason": "example only"}
</think>
最终输出如下：
{"worthy": true, "reason": "final answer after reasoning"}`
    const result = parseWorthinessResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.worthy).toBe(true)
    expect(result!.reason).toBe("final answer after reasoning")
  })

  it("returns null for completely invalid JSON", () => {
    expect(parseWorthinessResponse("not json at all")).toBeNull()
  })

  it("returns null when 'worthy' is a string instead of boolean", () => {
    const raw = '{"worthy": "yes", "reason": "something"}'
    expect(parseWorthinessResponse(raw)).toBeNull()
  })

  it("returns null when 'worthy' field is missing", () => {
    const raw = '{"reason": "something"}'
    expect(parseWorthinessResponse(raw)).toBeNull()
  })

  it("returns empty string for reason when reason field is missing", () => {
    const raw = '{"worthy": true}'
    const result = parseWorthinessResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.reason).toBe("")
  })

  it("returns null for empty string input", () => {
    expect(parseWorthinessResponse("")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────
// parseSkillProposal
// ─────────────────────────────────────────────────────────

describe("parseSkillProposal", () => {
  const VALID_PROPOSAL = JSON.stringify({
    name: "Generate Project Overview",
    skillId: "generate_project_overview",
    description: "When the user asks for a project overview or documentation",
    content: "---\nname: generate-project-overview\n---\n# Overview\nGenerates docs."
  })

  it("parses a complete valid proposal", () => {
    const result = parseSkillProposal(VALID_PROPOSAL)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("Generate Project Overview")
    expect(result!.skillId).toBe("generate_project_overview")
    expect(result!.description).toContain("project overview")
    expect(result!.content).toContain("name: generate-project-overview")
  })

  it("strips <think> tags before parsing", () => {
    const raw = `<think>I'll now create the skill JSON.</think>\n${VALID_PROPOSAL}`
    const result = parseSkillProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("Generate Project Overview")
  })

  it("strips markdown fences before parsing", () => {
    const raw = "```json\n" + VALID_PROPOSAL + "\n```"
    const result = parseSkillProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.skillId).toBe("generate_project_overview")
  })

  it("parses proposal JSON after think block and prose", () => {
    const raw = `<think>我先整理技能内容</think>
下面是最终 JSON：
${VALID_PROPOSAL}`
    const result = parseSkillProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.skillId).toBe("generate_project_overview")
  })

  it("prefers the final proposal JSON object after earlier example JSON", () => {
    const raw = `<think>
示例：
{"name":"Example","skillId":"example","description":"example","content":"example"}
</think>
真正输出：
${VALID_PROPOSAL}`
    const result = parseSkillProposal(raw)
    expect(result).not.toBeNull()
    expect(result!.skillId).toBe("generate_project_overview")
  })

  it("returns null for invalid JSON", () => {
    expect(parseSkillProposal("{broken json")).toBeNull()
  })

  it("returns null when 'name' is missing", () => {
    const obj = JSON.parse(VALID_PROPOSAL)
    delete obj.name
    expect(parseSkillProposal(JSON.stringify(obj))).toBeNull()
  })

  it("returns null when 'skillId' is missing", () => {
    const obj = JSON.parse(VALID_PROPOSAL)
    delete obj.skillId
    expect(parseSkillProposal(JSON.stringify(obj))).toBeNull()
  })

  it("returns null when 'description' is missing", () => {
    const obj = JSON.parse(VALID_PROPOSAL)
    delete obj.description
    expect(parseSkillProposal(JSON.stringify(obj))).toBeNull()
  })

  it("returns null when 'content' is missing", () => {
    const obj = JSON.parse(VALID_PROPOSAL)
    delete obj.content
    expect(parseSkillProposal(JSON.stringify(obj))).toBeNull()
  })

  it("returns null when a field is a number instead of string", () => {
    const obj = JSON.parse(VALID_PROPOSAL)
    obj.name = 123
    expect(parseSkillProposal(JSON.stringify(obj))).toBeNull()
  })

  it("returns null for empty string input", () => {
    expect(parseSkillProposal("")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────
// proposal mode decision
// ─────────────────────────────────────────────────────────

describe("skill proposal mode decision", () => {
  it("maps toggle on to Mode A", () => {
    expect(getSkillProposalMode(true)).toBe("mode_a_rule")
  })

  it("maps toggle off to Mode B", () => {
    expect(getSkillProposalMode(false)).toBe("mode_b_llm")
  })

  it("Mode A skips worthiness LLM", () => {
    expect(shouldJudgeSkillWorthiness("mode_a_rule")).toBe(false)
  })

  it("Mode B requires worthiness LLM", () => {
    expect(shouldJudgeSkillWorthiness("mode_b_llm")).toBe(true)
  })

  it("Mode A enters proposal flow even when llmWorthy=false", () => {
    expect(shouldProposeSkill("mode_a_rule", false)).toBe(true)
  })

  it("Mode B enters proposal flow when llmWorthy=true", () => {
    expect(shouldProposeSkill("mode_b_llm", true)).toBe(true)
  })

  it("Mode B skips proposal flow when llmWorthy=false", () => {
    expect(shouldProposeSkill("mode_b_llm", false)).toBe(false)
  })
})
