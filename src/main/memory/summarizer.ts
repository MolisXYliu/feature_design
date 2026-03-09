import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs"
import { join } from "path"
import { getMemoryStore } from "./store"

const SUMMARIZE_SYSTEM_PROMPT = `You are a memory extraction agent. Extract ONLY durable facts from this conversation.

Output a flat bullet list (2-6 items) of facts worth remembering for future conversations.

GOOD examples:
- 用户偏好使用 TypeScript 和 Electron 开发
- 项目名为 checkerframework-build-server，技术栈 Java 1.8 + Spring Boot
- 用户要求代码审查时重点关注安全问题

BAD examples (NEVER output these):
- 用户询问了项目功能 ← 这是描述对话过程，不是事实
- The user wants me to extract knowledge ← 这是推理过程
- 助手分析了代码结构并提供了总结 ← 这是描述行为

Rules:
- Each bullet = one durable fact, ONE line, no sub-bullets
- Extract facts: user preferences, project context, technical decisions, personal info
- NEVER describe the conversation ("用户询问了...", "助手回复了...")
- NEVER include reasoning or chain-of-thought
- NEVER include API keys, passwords, or credentials
- If nothing worth remembering, respond with exactly: NO_MEMORY
- Write in the same language the user used`

const SUMMARIZE_USER_PROMPT = `Extract durable facts from this conversation:\n\n`
const MAX_CONVERSATION_CHARS = 6000

export interface SummarizeOptions {
  model: ChatOpenAI
  conversation: string
  memoryDir: string
}

export async function summarizeAndSave(options: SummarizeOptions): Promise<void> {
  const { model, conversation, memoryDir } = options

  if (!conversation.trim()) return

  try {
    const truncated = conversation.length > MAX_CONVERSATION_CHARS
      ? conversation.slice(0, MAX_CONVERSATION_CHARS) + "\n...(truncated)"
      : conversation

    const response = await model.invoke([
      new SystemMessage(SUMMARIZE_SYSTEM_PROMPT),
      new HumanMessage(SUMMARIZE_USER_PROMPT + truncated)
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
