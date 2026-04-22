/**
 * Design IPC Handlers
 *
 * Streams Claude AI responses for the Design tab.
 * Uses the same ChatOpenAI streaming pattern as optimizer.ts.
 * The renderer sends a prompt, receives streamed text tokens,
 * and the final HTML is displayed in the canvas panel.
 */

import { ipcMain, BrowserWindow } from "electron"
import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { getCustomModelConfigs } from "../storage"

// ─────────────────────────────────────────────────────────
// System Prompt — Dynamic Questions Generation
// ─────────────────────────────────────────────────────────

const QUESTIONS_SYSTEM_PROMPT = `You are a design strategist. When given a user's design request, generate 4–6 targeted clarifying questions to help produce the best design outcome.

Return ONLY a valid JSON array. No markdown fences, no explanation, no preamble — just the raw JSON array.

Each question object must have:
- "id": unique snake_case identifier
- "type": "text" | "textarea" | "chips"
- "label": question label in Chinese
- "hint": optional helper text in Chinese (omit if not needed)
- "options": array of Chinese strings (required only for type "chips", each ≤ 8 chars)

Generate questions that are specific and contextual to the user's request. Cover: visual style preference, target audience, core content/features, brand context, and any domain-specific details.

Example output for "宣传我的产品":
[
  {"id":"brand_name","type":"text","label":"产品或品牌名称是什么？","hint":"将直接显示在设计中"},
  {"id":"product_type","type":"chips","label":"产品类型是什么？","options":["移动应用","SaaS 工具","实体商品","服务/订阅","游戏","其他"]},
  {"id":"description","type":"textarea","label":"用一两句话描述你的产品","hint":"它解决什么问题？核心价值是什么？"},
  {"id":"target_user","type":"text","label":"目标用户是谁？","hint":"描述你的理想用户群体"},
  {"id":"style","type":"chips","label":"期望的视觉风格","options":["极简现代","商务专业","活泼年轻","科技感","温暖亲切","高端奢华"]},
  {"id":"color_pref","type":"text","label":"有品牌色或颜色偏好吗？","hint":"如"蓝色+白色"或"暗色系"，没有可留空"}
]`

// ─────────────────────────────────────────────────────────
// System Prompt — Claude Design style
// ─────────────────────────────────────────────────────────

const DESIGN_SYSTEM_PROMPT = `You are an expert designer working with the user as a manager. You produce design artifacts in HTML on behalf of the user.

You must embody an expert in the relevant domain: UX designer, prototyper, data visualizer, slide designer, animator — whatever the task demands. Avoid generic web design tropes unless the task is literally a webpage.

## Choosing the right medium

Before writing a single line of HTML, decide what format best serves the content:
- **Static visual exploration** (color, type, layout options) → lay variations side by side on a canvas
- **Interactions, flows, or complex UI** → build a hi-fi clickable prototype with working states
- **Data presentation** → design the chart/dashboard as the primary artifact
- **Animation** → make it move; use CSS keyframes or JS timelines

## Your output rules

1. **Always output a complete HTML file** — start with \`<!DOCTYPE html>\`, end with \`</html>\`. No fragments, no partial snippets.
2. **Self-contained** — inline all CSS in \`<style>\` and all JS in \`<script>\`. CDN links for fonts or libraries are fine.
3. **Three variations** — unless told otherwise, always produce exactly **3 distinct variations** within a single HTML file:
   - **Variation A** — conventional, safe, closest to established patterns
   - **Variation B** — balanced, refines the concept with one interesting choice
   - **Variation C** — bold, novel, pushes the aesthetic or interaction in a surprising direction
   Present them side by side or as navigable sections. Label them clearly (A / B / C).
4. **No filler content** — every element must earn its place. Never pad with placeholder stats, dummy icons, or lorem ipsum sections. Less is more.

## Design quality bar

**Colors**: Use \`oklch()\` to define harmonious palettes instead of raw hex. Match any brand context given. No aggressive gradients.

**Typography**: Commit to a clear type scale. Never use Inter, Roboto, or Arial — pick something with character (e.g. DM Sans, Geist, Epilogue, Instrument Serif, Sora). Load from Google Fonts.

**Spacing**: Generous. Cards: 24px+ padding. Pages: 40–64px margins. Use CSS grid — it is your friend.

**Details**: \`text-wrap: pretty\`, subtle \`box-shadow\` layering, smooth \`transition\` (150–200ms ease), focus rings, hover states. These separate great from mediocre.

**Avoid AI design slop**:
- ❌ Rounded corners + left-border accent color containers
- ❌ Emoji as decoration (only if the brand explicitly uses them)
- ❌ SVG-drawn illustrations (use geometric shapes or placeholders instead)
- ❌ Aggressive gradient backgrounds
- ❌ Overused font families (Inter, Roboto, Arial, Fraunces)
- ❌ Unnecessary icons, stats, or filler numbers that add no meaning

## Context from user's session

The user's prompt will include their clarifying answers (output type, fidelity, style direction, reference context). Use those answers to shape which medium you pick, how polished you go, and what aesthetic direction to take.

## Output format

Respond with ONLY the raw HTML. No explanation, no markdown fences, no preamble.
Your response must start with: <!DOCTYPE html>
Your response must end with: </html>
`

// ─────────────────────────────────────────────────────────
// Model factory (same pattern as optimizer.ts)
// ─────────────────────────────────────────────────────────

function getModel(): ChatOpenAI | null {
  const configs = getCustomModelConfigs()
  const config = configs[0]
  if (!config || !config.apiKey) return null
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: 8192,
    temperature: 0.7,
    streaming: true,
  })
}

// ─────────────────────────────────────────────────────────
// Active sessions for cancellation
// ─────────────────────────────────────────────────────────

const activeSessions = new Map<string, AbortController>()

// ─────────────────────────────────────────────────────────
// IPC Registration
// ─────────────────────────────────────────────────────────

export function registerDesignHandlers(): void {
  // design:ask-questions — stream questions JSON from model
  ipcMain.on(
    "design:ask-questions",
    async (event, { sessionId, prompt }: { sessionId: string; prompt: string }) => {
      const channel = `design:questions:${sessionId}`
      const window = BrowserWindow.fromWebContents(event.sender)

      const send = (data: object) => {
        if (window && !window.isDestroyed()) {
          event.sender.send(channel, data)
        }
      }

      const existing = activeSessions.get(sessionId)
      if (existing) existing.abort()

      const controller = new AbortController()
      activeSessions.set(sessionId, controller)

      const model = getModel()
      if (!model) {
        send({ type: "error", error: "No model configured. Please set up a model in Settings." })
        return
      }

      let fullText = ""

      try {
        send({ type: "start" })

        const stream = await model.stream(
          [new SystemMessage(QUESTIONS_SYSTEM_PROMPT), new HumanMessage(prompt)],
          { signal: controller.signal }
        )

        for await (const chunk of stream) {
          if (controller.signal.aborted) break
          const token = typeof chunk.content === "string" ? chunk.content : ""
          if (token) fullText += token
        }

        // Parse JSON questions from model output
        const questions = parseQuestionsJson(fullText)
        send({ type: "done", questions })
      } catch (err) {
        if (controller.signal.aborted) {
          send({ type: "cancelled" })
        } else {
          const message = err instanceof Error ? err.message : String(err)
          console.error("[Design] Questions generation error:", message)
          send({ type: "error", error: message })
        }
      } finally {
        activeSessions.delete(sessionId)
      }
    }
  )

  // design:generate — streaming, same pattern as agent:invoke
  ipcMain.on(
    "design:generate",
    async (event, { sessionId, prompt }: { sessionId: string; prompt: string }) => {
      const channel = `design:stream:${sessionId}`
      const window = BrowserWindow.fromWebContents(event.sender)

      const send = (data: object) => {
        if (window && !window.isDestroyed()) {
          event.sender.send(channel, data)
        }
      }

      // Cancel any existing session with the same id
      const existing = activeSessions.get(sessionId)
      if (existing) existing.abort()

      const controller = new AbortController()
      activeSessions.set(sessionId, controller)

      const model = getModel()
      if (!model) {
        send({ type: "error", error: "No model configured. Please set up a model in Settings." })
        return
      }

      let fullText = ""

      try {
        send({ type: "start" })

        const stream = await model.stream(
          [new SystemMessage(DESIGN_SYSTEM_PROMPT), new HumanMessage(prompt)],
          { signal: controller.signal }
        )

        for await (const chunk of stream) {
          if (controller.signal.aborted) break
          const token = typeof chunk.content === "string" ? chunk.content : ""
          if (token) {
            fullText += token
            send({ type: "token", token })
          }
        }

        const html = extractHtml(fullText)
        send({ type: "done", html })
      } catch (err) {
        if (controller.signal.aborted) {
          send({ type: "cancelled" })
        } else {
          const message = err instanceof Error ? err.message : String(err)
          console.error("[Design] Generation error:", message)
          send({ type: "error", error: message })
        }
      } finally {
        activeSessions.delete(sessionId)
      }
    }
  )

  // design:cancel — abort an active session
  ipcMain.handle("design:cancel", (_event, sessionId: string) => {
    const controller = activeSessions.get(sessionId)
    if (controller) {
      controller.abort()
      activeSessions.delete(sessionId)
    }
  })
}

// ─────────────────────────────────────────────────────────
// HTML extraction helper
// ─────────────────────────────────────────────────────────

function extractHtml(text: string): string {
  // 1. 过滤 <think>...</think> 内容（支持多段、换行）
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()

  // 2. 去掉 ```html ... ``` 代码块标记
  const fenced = cleaned.match(/```html\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()

  // 3. 如果直接以 HTML 声明开头，直接返回
  if (cleaned.startsWith("<!DOCTYPE") || cleaned.startsWith("<html")) return cleaned

  return cleaned
}

function parseQuestionsJson(text: string): unknown[] {
  // Strip <think> blocks
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
  // Strip markdown code fences
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) cleaned = fenced[1].trim()
  // Find JSON array in the text
  const match = cleaned.match(/\[[\s\S]*\]/)
  if (match) {
    try {
      return JSON.parse(match[0]) as unknown[]
    } catch {
      // fall through
    }
  }
  return []
}
