/**
 * Progressive string replacement for edit_file tool.
 *
 * Ported from OpenCode (MIT License):
 * https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/edit.ts
 *
 * Uses a chain of 9 replacer strategies to gracefully handle minor
 * discrepancies in LLM-generated old_string (whitespace, indentation,
 * escape characters, etc.), reducing edit failures and token waste.
 */

export type Replacer = (content: string, find: string) => Generator<string>

// --- Replacer implementations ---

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false
        break
      }
    }
    if (matches) {
      let start = 0
      for (let k = 0; k < i; k++) start += originalLines[k].length + 1
      let end = start
      for (let k = 0; k < searchLines.length; k++) {
        end += originalLines[i + k].length
        if (k < searchLines.length - 1) end += 1
      }
      yield content.substring(start, end)
    }
  }
}

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length)
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      )
    }
  }
  return matrix[a.length][b.length]
}

const SINGLE_CANDIDATE_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_THRESHOLD = 0.3

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines.length < 3) return
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()

  const firstLine = searchLines[0].trim()
  const lastLine = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length

  const candidates: { startLine: number; endLine: number }[] = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLine) continue
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLine) {
        candidates.push({ startLine: i, endLine: j })
        break
      }
    }
  }
  if (candidates.length === 0) return

  const extractBlock = (startLine: number, endLine: number): string => {
    let start = 0
    for (let k = 0; k < startLine; k++) start += originalLines[k].length + 1
    let end = start
    for (let k = startLine; k <= endLine; k++) {
      end += originalLines[k].length
      if (k < endLine) end += 1
    }
    return content.substring(start, end)
  }

  const calcSimilarity = (startLine: number, endLine: number): number => {
    const actualSize = endLine - startLine + 1
    const linesToCheck = Math.min(searchBlockSize - 2, actualSize - 2)
    if (linesToCheck <= 0) return 1.0
    let sim = 0
    for (let j = 1; j < searchBlockSize - 1 && j < actualSize - 1; j++) {
      const orig = originalLines[startLine + j].trim()
      const search = searchLines[j].trim()
      const maxLen = Math.max(orig.length, search.length)
      if (maxLen === 0) continue
      sim += (1 - levenshtein(orig, search) / maxLen) / linesToCheck
    }
    return sim
  }

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    if (calcSimilarity(startLine, endLine) >= SINGLE_CANDIDATE_THRESHOLD) {
      yield extractBlock(startLine, endLine)
    }
    return
  }

  let best: (typeof candidates)[0] | null = null
  let maxSim = -1
  for (const c of candidates) {
    const sim = calcSimilarity(c.startLine, c.endLine)
    if (sim > maxSim) {
      maxSim = sim
      best = c
    }
  }
  if (maxSim >= MULTIPLE_CANDIDATES_THRESHOLD && best) {
    yield extractBlock(best.startLine, best.endLine)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalize = (t: string) => t.replace(/\s+/g, " ").trim()
  const normalizedFind = normalize(find)
  const lines = content.split("\n")

  for (const line of lines) {
    if (normalize(line) === normalizedFind) {
      yield line
    } else {
      const normalizedLine = normalize(line)
      if (normalizedLine.includes(normalizedFind)) {
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const match = line.match(new RegExp(pattern))
            if (match) yield match[0]
          } catch { /* invalid regex */ }
        }
      }
    }
  }

  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalize(block.join("\n")) === normalizedFind) yield block.join("\n")
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndent = (text: string) => {
    const lines = text.split("\n")
    const nonEmpty = lines.filter((l) => l.trim().length > 0)
    if (nonEmpty.length === 0) return text
    const min = Math.min(...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1].length ?? 0))
    return lines.map((l) => (l.trim().length === 0 ? l : l.slice(min))).join("\n")
  }
  const normalizedFind = removeIndent(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndent(block) === normalizedFind) yield block
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescape = (str: string): string =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, ch) => {
      switch (ch) {
        case "n": return "\n"
        case "t": return "\t"
        case "r": return "\r"
        case "'": return "'"
        case '"': return '"'
        case "`": return "`"
        case "\\": return "\\"
        case "\n": return "\n"
        case "$": return "$"
        default: return match
      }
    })
  const unescaped = unescape(find)
  if (content.includes(unescaped)) yield unescaped

  const lines = content.split("\n")
  const findLines = unescaped.split("\n")
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    if (unescape(block) === unescaped) yield block
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmed = find.trim()
  if (trimmed === find) return
  if (content.includes(trimmed)) yield trimmed

  const lines = content.split("\n")
  const findLines = find.split("\n")
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    if (block.trim() === trimmed) yield block
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === "") findLines.pop()

  const contentLines = content.split("\n")
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() !== lastLine) continue
      const blockLines = contentLines.slice(i, j + 1)
      if (blockLines.length === findLines.length) {
        let matching = 0
        let total = 0
        for (let k = 1; k < blockLines.length - 1; k++) {
          const bl = blockLines[k].trim()
          const fl = findLines[k].trim()
          if (bl.length > 0 || fl.length > 0) {
            total++
            if (bl === fl) matching++
          }
        }
        if (total === 0 || matching / total >= 0.5) {
          yield blockLines.join("\n")
        }
      }
      break
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let idx = 0
  while (true) {
    const pos = content.indexOf(find, idx)
    if (pos === -1) break
    yield find
    idx = pos + find.length
  }
}

// --- Main replace function ---

const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer
]

/**
 * Progressive string replacement: tries 9 matching strategies in order,
 * from exact match to fuzzy/contextual match.
 *
 * @returns The new content after replacement
 * @throws Error if no match found or ambiguous match (multiple occurrences without replaceAll)
 */
export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): { newContent: string; occurrences: number } {
  if (oldString === "") {
    throw new Error("oldString cannot be empty. Use write_file for new files or provide the text to replace.")
  }
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }

  let notFound = true

  for (const replacer of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) {
        const occurrences = content.split(search).length - 1
        return { newContent: content.replaceAll(search, newString), occurrences }
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return {
        newContent: content.substring(0, index) + newString + content.substring(index + search.length),
        occurrences: 1
      }
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."
    )
  }
  throw new Error(
    "Found multiple matches for oldString. Provide more surrounding context to make the match unique."
  )
}
