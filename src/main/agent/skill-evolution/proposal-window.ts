export interface SkillProposalWindowTurn {
  userMessage: string
  assistantText: string
  toolCallNames: string[]
  toolCallCount: number
  status: "success" | "error"
  errorMessage?: string
  usedLoadedSkill: boolean
  activeSkillNames: string[]
  finishedAt: string
}

export interface SkillProposalWindowContext {
  turns: SkillProposalWindowTurn[]
  transcript: string
  toolCallNames: string[]
  toolCallCount: number
  toolCallSummary: string
  turnCount: number
  successCount: number
  errorCount: number
  usedLoadedSkill: boolean
  activeSkillNames: string[]
}

const MAX_USER_MESSAGE_CHARS = 500
const MAX_ASSISTANT_TEXT_CHARS = 1200
const MAX_ERROR_CHARS = 300

const proposalWindows = new Map<string, SkillProposalWindowTurn[]>()

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function cloneTurn(turn: SkillProposalWindowTurn): SkillProposalWindowTurn {
  return {
    ...turn,
    toolCallNames: [...turn.toolCallNames],
    activeSkillNames: [...turn.activeSkillNames]
  }
}

function buildTranscript(turns: SkillProposalWindowTurn[]): string {
  return turns
    .map((turn, index) => {
      const header = `Turn ${index + 1} [${turn.status}]`
      const parts = [
        header,
        `User request:\n${clip(turn.userMessage, MAX_USER_MESSAGE_CHARS) || "(empty)"}`,
        `Assistant response:\n${clip(turn.assistantText, MAX_ASSISTANT_TEXT_CHARS) || "(empty)"}`
      ]

      if (turn.toolCallNames.length > 0) {
        parts.push(`Tools used (${turn.toolCallCount}): ${buildToolCallSummary(turn.toolCallNames)}`)
      }

      if (turn.errorMessage) {
        parts.push(`Error:\n${clip(turn.errorMessage, MAX_ERROR_CHARS)}`)
      }

      if (turn.usedLoadedSkill && turn.activeSkillNames.length > 0) {
        parts.push(`Loaded skills during turn: ${turn.activeSkillNames.join(", ")}`)
      }

      return parts.join("\n")
    })
    .join("\n\n")
}

export function buildToolCallSummary(toolCallNames: string[]): string {
  if (toolCallNames.length === 0) return "(none)"

  const counts = new Map<string, number>()
  for (const name of toolCallNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  return Array.from(counts.entries())
    .map(([name, count]) => `${name} x${count}`)
    .join(", ")
}

export function appendSkillProposalWindowTurn(
  threadId: string,
  turn: SkillProposalWindowTurn
): void {
  const next = proposalWindows.get(threadId) ?? []
  next.push(cloneTurn(turn))
  proposalWindows.set(threadId, next)
}

export function snapshotSkillProposalWindow(threadId: string): SkillProposalWindowTurn[] {
  return (proposalWindows.get(threadId) ?? []).map(cloneTurn)
}

export function resetSkillProposalWindow(threadId: string): void {
  proposalWindows.delete(threadId)
}

export function buildSkillProposalWindowContext(
  turns: SkillProposalWindowTurn[]
): SkillProposalWindowContext {
  const clonedTurns = turns.map(cloneTurn)
  const toolCallNames = clonedTurns.flatMap((turn) => turn.toolCallNames)
  const activeSkillNames = Array.from(
    new Set(clonedTurns.flatMap((turn) => turn.activeSkillNames))
  )

  return {
    turns: clonedTurns,
    transcript: buildTranscript(clonedTurns),
    toolCallNames,
    toolCallCount: clonedTurns.reduce((sum, turn) => sum + turn.toolCallCount, 0),
    toolCallSummary: buildToolCallSummary(toolCallNames),
    turnCount: clonedTurns.length,
    successCount: clonedTurns.filter((turn) => turn.status === "success").length,
    errorCount: clonedTurns.filter((turn) => turn.status === "error").length,
    usedLoadedSkill: clonedTurns.some((turn) => turn.usedLoadedSkill),
    activeSkillNames
  }
}
