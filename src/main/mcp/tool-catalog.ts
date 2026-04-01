import type { McpCapabilityService, McpCapabilityTool } from "./capability-types"

export type McpToolSearchMode = "bm25" | "keyword" | "regex"
export type McpToolSearchVisibility = "lazy" | "eager" | "all"

export interface McpToolSearchOptions {
  topK: number
  mode: McpToolSearchMode
  serverFilter?: string[]
  visibility?: McpToolSearchVisibility
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Segment = require("segment") as new () => {
  useDefault(): void
  doSegment(text: string, options?: { simple?: boolean; stripPunctuation?: boolean }): string[]
}

const segmenter = new Segment()
segmenter.useDefault()

interface SearchState {
  snapshot: string
  index: SimpleBM25
}

const searchStateByVisibility = new Map<McpToolSearchVisibility, SearchState>()

class SimpleBM25 {
  private documents: Map<string, { tokens: string[]; doc: McpCapabilityTool }> = new Map()
  private avgDocLength = 0
  private documentFrequency: Map<string, number> = new Map()
  private totalDocs = 0

  private readonly k1 = 1.5
  private readonly b = 0.75

  index(docId: string, text: string, doc: McpCapabilityTool): void {
    const tokens = this.tokenize(text)
    this.documents.set(docId, { tokens, doc })

    const uniqueTokens = new Set(tokens)
    for (const token of uniqueTokens) {
      this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1)
    }

    this.totalDocs = this.documents.size
    this.updateAvgDocLength()
  }

  search(query: string, topK: number): McpCapabilityTool[] {
    const queryTokens = this.tokenize(query)
    const scores: Array<{ doc: McpCapabilityTool; score: number }> = []

    for (const { tokens, doc } of this.documents.values()) {
      const score = this.computeScore(queryTokens, tokens)
      if (score > 0) {
        scores.push({ doc, score })
      }
    }

    return scores
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
      .map((item) => item.doc)
  }

  private updateAvgDocLength(): void {
    let totalLength = 0
    for (const { tokens } of this.documents.values()) {
      totalLength += tokens.length
    }
    this.avgDocLength = this.totalDocs > 0 ? totalLength / this.totalDocs : 0
  }

  private computeScore(queryTokens: string[], docTokens: string[]): number {
    if (docTokens.length === 0 || queryTokens.length === 0) return 0

    let score = 0
    const docLength = docTokens.length
    const termFrequency = new Map<string, number>()

    for (const token of docTokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)
    }

    for (const queryToken of queryTokens) {
      const tf = termFrequency.get(queryToken) ?? 0
      if (tf === 0) continue

      const df = this.documentFrequency.get(queryToken) ?? 0
      const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1)
      const numerator = tf * (this.k1 + 1)
      const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength))
      score += idf * (numerator / denominator)
    }

    return score
  }

  private tokenize(text: string): string[] {
    const tokens: string[] = []
    const chineseRegex = /[\u4e00-\u9fff]/
    const segmentPattern = /([\u4e00-\u9fff]+)|([^\u4e00-\u9fff]+)/g

    let match: RegExpExecArray | null
    while ((match = segmentPattern.exec(text)) !== null) {
      const segment = match[0]

      if (chineseRegex.test(segment)) {
        const chineseTokens = segmenter.doSegment(segment, { simple: true, stripPunctuation: true })
        for (const token of chineseTokens) {
          const trimmed = token.trim().toLowerCase()
          if (trimmed) tokens.push(trimmed)
        }
      } else {
        const englishTokens = segment.toLowerCase()
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .replace(/[-_]/g, " ")
          .split(/[\s\-_.,;:!?()[\]{}'"\/\\]+/)
          .filter((token) => token.length > 1)

        tokens.push(...englishTokens)
      }
    }

    return tokens
  }
}

function filterByVisibility(
  tools: McpCapabilityTool[],
  visibility: McpToolSearchVisibility
): McpCapabilityTool[] {
  if (visibility === "all") return tools
  return tools.filter((tool) => tool.visibility === visibility)
}

function buildSnapshot(tools: McpCapabilityTool[]): string {
  return JSON.stringify(tools.map((tool) => ({
    capabilityId: tool.capabilityId,
    toolId: tool.toolId,
    providerKey: tool.providerKey,
    providerAlias: tool.providerAlias,
    providerDisplayName: tool.providerDisplayName,
    toolName: tool.toolName,
    scriptAlias: tool.scriptAlias,
    description: tool.description ?? "",
    visibility: tool.visibility
  })))
}

function buildSearchIndex(tools: McpCapabilityTool[]): SimpleBM25 {
  const bm25 = new SimpleBM25()
  for (const tool of tools) {
    const searchableText = [
      tool.toolId,
      tool.providerDisplayName,
      tool.providerAlias,
      tool.toolName,
      tool.scriptAlias,
      tool.description ?? ""
    ].join(" ")
    bm25.index(tool.capabilityId, searchableText, tool)
  }
  return bm25
}

function getSearchState(
  tools: McpCapabilityTool[],
  visibility: McpToolSearchVisibility
): SearchState {
  const visibleTools = filterByVisibility(tools, visibility)
  const snapshot = buildSnapshot(visibleTools)
  const cached = searchStateByVisibility.get(visibility)
  if (cached?.snapshot === snapshot) {
    return cached
  }

  const state = {
    snapshot,
    index: buildSearchIndex(visibleTools)
  }
  searchStateByVisibility.set(visibility, state)
  return state
}

function applyServerFilter(
  tools: McpCapabilityTool[],
  serverFilter?: string[]
): McpCapabilityTool[] {
  if (!serverFilter || serverFilter.length === 0) return tools
  const allowed = new Set(serverFilter.map((item) => item.toLowerCase()))
  return tools.filter((tool) => {
    return (
      allowed.has(tool.providerAlias.toLowerCase()) ||
      allowed.has(tool.providerDisplayName.toLowerCase()) ||
      allowed.has(tool.providerKey.toLowerCase())
    )
  })
}

function searchKeyword(tools: McpCapabilityTool[], query: string, limit: number): McpCapabilityTool[] {
  const queryLower = query.toLowerCase()
  const scored = tools
    .map((tool) => {
      const values = [
        tool.providerDisplayName,
        tool.providerAlias,
        tool.toolId,
        tool.toolName,
        tool.scriptAlias,
        tool.description ?? ""
      ].map((value) => value.toLowerCase())

      const exactToolName = tool.toolName.toLowerCase() === queryLower
      const toolMatch = tool.toolName.toLowerCase().includes(queryLower)
      const providerMatch = values[0].includes(queryLower) || values[1].includes(queryLower)
      const aliasMatch = values[2].includes(queryLower) || values[4].includes(queryLower)
      const descriptionMatch = values[5].includes(queryLower)

      if (!exactToolName && !toolMatch && !providerMatch && !aliasMatch && !descriptionMatch) {
        return null
      }

      let score = 0
      if (exactToolName) score = 100
      else if (toolMatch) score = 70
      else if (aliasMatch) score = 50
      else if (providerMatch) score = 30
      else score = 10

      return { tool, score }
    })
    .filter((item): item is { tool: McpCapabilityTool; score: number } => item != null)

  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.tool)
}

function searchRegex(tools: McpCapabilityTool[], query: string, limit: number): McpCapabilityTool[] {
  let regex: RegExp
  try {
    regex = new RegExp(query, "i")
  } catch {
    return searchKeyword(tools, query, limit)
  }

  return tools.filter((tool) => {
    return regex.test(tool.providerDisplayName)
      || regex.test(tool.providerAlias)
      || regex.test(tool.toolId)
      || regex.test(tool.toolName)
      || regex.test(tool.scriptAlias)
      || regex.test(tool.description ?? "")
  }).slice(0, limit)
}

export async function searchCapabilityTools(
  service: McpCapabilityService,
  query: string,
  options: McpToolSearchOptions
): Promise<McpCapabilityTool[]> {
  const visibility = options.visibility ?? "lazy"
  const tools = await service.listTools()
  const visibleTools = filterByVisibility(tools, visibility)
  const filteredTools = applyServerFilter(visibleTools, options.serverFilter)

  switch (options.mode) {
    case "keyword":
      return searchKeyword(filteredTools, query, options.topK)
    case "regex":
      return searchRegex(filteredTools, query, options.topK)
    case "bm25":
    default: {
      const index = options.serverFilter?.length
        ? buildSearchIndex(filteredTools)
        : getSearchState(tools, visibility).index
      return index.search(query, options.topK)
    }
  }
}
