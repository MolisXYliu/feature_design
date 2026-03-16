import { describe, expect, it } from "vitest"
import {
  getSkillProposalMode,
  parseWorthinessResponse,
  shouldEvaluateSkillProposalWindow,
  shouldJudgeSkillWorthiness,
  shouldProposeSkill
} from "../agent/skill-evolution/skill-proposal-logic"

function makeLLMResponse(worthy: boolean, reason: string): string {
  return JSON.stringify({ worthy, reason })
}

describe("skill proposal modes", () => {
  it("Mode A: toggle on -> direct proposal flow without worthiness check", () => {
    const mode = getSkillProposalMode(true)
    expect(mode).toBe("mode_a_rule")
    expect(shouldJudgeSkillWorthiness(mode)).toBe(false)
    expect(shouldProposeSkill(mode, false)).toBe(true)
  })

  it("Mode B: toggle off -> worthy=true enters proposal flow", () => {
    const mode = getSkillProposalMode(false)
    expect(mode).toBe("mode_b_llm")
    expect(shouldJudgeSkillWorthiness(mode)).toBe(true)
    expect(shouldProposeSkill(mode, true)).toBe(true)
  })

  it("Mode B: toggle off -> worthy=false skips proposal flow", () => {
    const mode = getSkillProposalMode(false)
    expect(shouldProposeSkill(mode, false)).toBe(false)
  })

  it("Mode B: parse failure degrades to false and skips proposal flow", () => {
    const mode = getSkillProposalMode(false)
    const parsed = parseWorthinessResponse("Internal server error 500")
    expect(parsed).toBeNull()
    expect(shouldProposeSkill(mode, false)).toBe(false)
  })
})

describe("worthiness parsing remains compatible", () => {
  it("parses worthy=true responses", () => {
    const result = parseWorthinessResponse(makeLLMResponse(true, "complex workflow"))
    expect(result?.worthy).toBe(true)
    expect(result?.reason).toBe("complex workflow")
  })

  it("parses worthy=false responses", () => {
    const result = parseWorthinessResponse(makeLLMResponse(false, "simple Q&A"))
    expect(result?.worthy).toBe(false)
    expect(result?.reason).toBe("simple Q&A")
  })

  it("strips think blocks before parsing", () => {
    const raw = `<think>reasoning</think>${makeLLMResponse(true, "resolved tricky error")}`
    const result = parseWorthinessResponse(raw)
    expect(result?.worthy).toBe(true)
    expect(result?.reason).toContain("tricky error")
  })
})

describe("session window threshold evaluation", () => {
  it("does not evaluate before the session tool count reaches threshold", () => {
    expect(shouldEvaluateSkillProposalWindow(4, 5)).toBe(false)
  })

  it("evaluates on every turn once the session tool count reaches threshold", () => {
    expect(shouldEvaluateSkillProposalWindow(5, 5)).toBe(true)
    expect(shouldEvaluateSkillProposalWindow(8, 5)).toBe(true)
    expect(shouldEvaluateSkillProposalWindow(14, 5)).toBe(true)
  })
})
