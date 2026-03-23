import { resetToolCallCount } from "../runtime"
import { resetSkillProposalWindow } from "./proposal-window"

export type SkillEvolutionIntentDecision = "accept" | "skip"

export function shouldResetSkillEvolutionSessionAfterIntent(
  decision: SkillEvolutionIntentDecision
): boolean {
  return decision === "accept"
}

export function resetSkillEvolutionSession(threadId: string): void {
  resetToolCallCount(threadId)
  resetSkillProposalWindow(threadId)
}
