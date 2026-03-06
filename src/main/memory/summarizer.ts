import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs"
import { join } from "path"
import { getMemoryStore } from "./store"

const SUMMARIZE_SYSTEM_PROMPT = `You are a memory assistant. Your job is to extract durable, reusable knowledge from a conversation.

Output a concise markdown summary (2-8 bullet points) covering:
- Key decisions made
- User preferences or corrections discovered
- Important facts or context learned
- Action items or todos mentioned

Rules:
- Be concise — each bullet should be one line
- Focus on information useful for FUTURE conversations
- Skip transient details (greetings, acknowledgments, one-time lookups)
- Never include API keys, passwords, or credentials
- If the conversation has nothing worth remembering, respond with exactly: NO_MEMORY
- Write in the same language the user used in the conversation`

const SUMMARIZE_USER_PROMPT = `Summarize the following conversation for long-term memory:\n\n`

export interface SummarizeOptions {
  model: ChatOpenAI
  userMessage: string
  assistantResponse: string
  memoryDir: string
}

export async function summarizeAndSave(options: SummarizeOptions): Promise<void> {
  const { model, userMessage, assistantResponse, memoryDir } = options

  if (!userMessage.trim() || !assistantResponse.trim()) return

  try {
    const conversationText =
      `User: ${userMessage}\n\nAssistant: ${assistantResponse}`

    const response = await model.invoke([
      new SystemMessage(SUMMARIZE_SYSTEM_PROMPT),
      new HumanMessage(SUMMARIZE_USER_PROMPT + conversationText)
    ])

    const summary = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content)

    if (!summary.trim() || summary.trim() === "NO_MEMORY") return

    // Write to daily memory file
    const today = new Date().toISOString().slice(0, 10)
    const filePath = join(memoryDir, `${today}.md`)

    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true })
    }

    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false })
    const entry = `\n## ${timestamp}\n\n${summary.trim()}\n`

    if (existsSync(filePath)) {
      appendFileSync(filePath, entry, "utf-8")
    } else {
      writeFileSync(filePath, `# Memory — ${today}\n${entry}`, "utf-8")
    }

    // Update FTS index
    const store = await getMemoryStore()
    const fullContent = readFileSync(filePath, "utf-8")
    store.addDocument(filePath, fullContent)

    console.log("[Memory] Saved summary to", filePath)
  } catch (e) {
    console.warn("[Memory] Failed to summarize:", e instanceof Error ? e.message : e)
  }
}
