import { tool } from "langchain"
import { z } from "zod"
import type { MemoryStore } from "./store"

export function createMemorySearchTool(store: MemoryStore) {
  return tool(
    async (input) => {
      const results = store.search(input.query, input.max_results ?? 5)
      if (results.length === 0) {
        return "No matching memories found."
      }
      return results
        .map((r, i) => {
          const source = `${r.path}#L${r.startLine}-${r.endLine}`
          return `[${i + 1}] (Source: ${source})\n${r.text}`
        })
        .join("\n\n---\n\n")
    },
    {
      name: "memory_search",
      description:
        "Search your long-term memory for information from past conversations. " +
        "Use this before answering questions about prior work, decisions, dates, people, or preferences.",
      schema: z.object({
        query: z.string().describe("Search query — use keywords related to what you want to recall"),
        max_results: z.number().optional().default(5).describe("Maximum number of results to return")
      })
    }
  )
}

export function createMemoryGetTool(store: MemoryStore) {
  return tool(
    async (input) => {
      return store.readMemoryFile(input.path, input.from, input.lines)
    },
    {
      name: "memory_get",
      description:
        "Read a specific memory file by path. Use this to get the full content " +
        "of a memory file after finding it via memory_search.",
      schema: z.object({
        path: z.string().describe("Path to the memory file (e.g., '2026-03-05.md' or absolute path)"),
        from: z.number().optional().describe("Start line number (1-indexed)"),
        lines: z.number().optional().describe("Number of lines to read")
      })
    }
  )
}
