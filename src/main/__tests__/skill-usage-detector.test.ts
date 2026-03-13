import { describe, expect, it } from "vitest"
import { SkillUsageDetector, getAutoProposeToolCallCount } from "../agent/skill-evolution/usage-detector"

describe("SkillUsageDetector", () => {
  it("does NOT mark used when only always-on skills are loaded", () => {
    const d = new SkillUsageDetector()
    d.onSkillsMetadata([
      { name: "scheduler-assistant", path: "/Users/a/.cmbcoworkagent/skills/scheduler-assistant/SKILL.md" },
      { name: "skill-creator", path: "/Users/a/.cmbcoworkagent/skills/skill-creator/SKILL.md" }
    ])
    d.onReadFilePath("SKILL.md")
    expect(d.wasSkillUsed()).toBe(false)
  })

  it("marks used when non-default skill is loaded then SKILL.md is read", () => {
    const d = new SkillUsageDetector()
    d.onSkillsMetadata([
      { name: "generate-project-overview", path: "/Users/a/.cmbcoworkagent/skills/generate-project-overview/SKILL.md" }
    ])
    d.onReadFilePath("SKILL.md")
    expect(d.wasSkillUsed()).toBe(true)
  })

  it("marks used when SKILL.md is read before metadata arrives (stream ordering tolerant)", () => {
    const d = new SkillUsageDetector()
    d.onReadFilePath("SKILL.md")
    d.onSkillsMetadata([
      { name: "generate-project-overview", path: "/Users/a/.cmbcoworkagent/skills/generate-project-overview/SKILL.md" }
    ])
    expect(d.wasSkillUsed()).toBe(true)
  })

  it("matches relative read path against loaded absolute skill path", () => {
    const d = new SkillUsageDetector()
    d.onSkillsMetadata([
      { name: "explore-project-and-document", path: "/Users/a/.cmbcoworkagent/skills/explore-project-and-document/SKILL.md" }
    ])
    d.onReadFilePath("explore-project-and-document/SKILL.md")
    expect(d.wasSkillUsed()).toBe(true)
  })
})

describe("getAutoProposeToolCallCount", () => {
  it("uses the threshold-triggering counter value", () => {
    expect(getAutoProposeToolCallCount(3)).toBe(3)
    expect(getAutoProposeToolCallCount(6)).toBe(6)
  })
})

