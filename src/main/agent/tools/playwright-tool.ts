import { randomUUID } from "crypto"
import { existsSync, mkdirSync } from "fs"
import path from "path"
import { tool } from "langchain"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { z } from "zod"

const ACTIONS = [
  "launch",
  "goto",
  "click",
  "fill",
  "type",
  "press",
  "wait_for_selector",
  "text_content",
  "screenshot",
  "set_active",
  "list_sessions",
  "close",
  "close_all"
] as const

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle", "commit"] as const
const WAIT_FOR_STATE = ["attached", "detached", "visible", "hidden"] as const
const CHANNELS = ["chrome", "chrome-beta", "msedge", "msedge-beta", "msedge-dev"] as const

interface PlaywrightSession {
  browser: Browser
  context: BrowserContext
  page: Page
  createdAt: number
  lastUsedAt: number
}

const sessions = new Map<string, PlaywrightSession>()
let activeSessionId: string | null = null

const playwrightSchema = z.object({
  action: z.enum(ACTIONS).describe(
    "Browser action: launch/goto/click/fill/type/press/wait_for_selector/text_content/screenshot/set_active/list_sessions/close/close_all"
  ),
  sessionId: z.string().optional().describe(
    "Playwright session ID. Optional: if omitted, uses active session."
  ),
  url: z.string().optional().describe("Target URL for goto or optional initial URL for launch."),
  selector: z.string().optional().describe("DOM selector used by click/fill/type/wait_for_selector/text_content."),
  text: z.string().optional().describe("Input text for fill/type."),
  key: z.string().optional().describe("Keyboard key for press, e.g. Enter, Escape, Control+A."),
  timeoutMs: z.number().int().min(1).max(180000).optional().describe(
    "Timeout in milliseconds for actions. Defaults to 30s."
  ),
  headless: z.boolean().optional().describe("Headless mode for launch. Defaults to false on desktop."),
  waitUntil: z.enum(WAIT_UNTIL).optional().describe("Navigation wait strategy for goto/launch."),
  waitForState: z.enum(WAIT_FOR_STATE).optional().describe("Selector state for wait_for_selector."),
  slowMoMs: z.number().int().min(0).max(1000).optional().describe("Slow motion delay in ms for launch."),
  channel: z.enum(CHANNELS).optional().describe(
    "Browser channel for launch. Useful on Windows when Playwright Chromium is not installed (e.g. msedge or chrome)."
  ),
  executablePath: z.string().optional().describe(
    "Custom browser executable path for launch (absolute path, or relative to workspace)."
  ),
  viewportWidth: z.number().int().min(200).max(8000).optional().describe("Browser viewport width."),
  viewportHeight: z.number().int().min(200).max(8000).optional().describe("Browser viewport height."),
  screenshotPath: z.string().optional().describe(
    "Screenshot output path. Relative paths are resolved from workspace root."
  ),
  fullPage: z.boolean().optional().describe("Whether screenshot captures full page. Defaults to true.")
})

function resolveSession(sessionId?: string): { id: string; session: PlaywrightSession } | null {
  const requested = sessionId?.trim()
  const id = requested || activeSessionId
  if (!id) return null
  const session = sessions.get(id)
  if (!session) return null
  return { id, session }
}

function buildError(message: string): string {
  return JSON.stringify({ success: false, error: message })
}

function touchSession(session: PlaywrightSession): void {
  session.lastUsedAt = Date.now()
}

function getDefaultScreenshotPath(workspacePath: string): string {
  const dir = path.join(workspacePath, ".cmbdevclaw", "playwright")
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `screenshot-${Date.now()}.png`)
}

function resolveOutputPath(workspacePath: string, screenshotPath?: string): string {
  if (!screenshotPath) return getDefaultScreenshotPath(workspacePath)
  return path.isAbsolute(screenshotPath)
    ? screenshotPath
    : path.resolve(workspacePath, screenshotPath)
}

function resolveExecutablePath(workspacePath: string, executablePath?: string): string | undefined {
  if (!executablePath) return undefined
  return path.isAbsolute(executablePath)
    ? executablePath
    : path.resolve(workspacePath, executablePath)
}

function getMissingBrowserHelp(): string {
  if (process.platform === "win32") {
    return [
      "Windows hints:",
      "1) Launch with channel='msedge' or channel='chrome' to use installed browsers.",
      "2) Or install Playwright Chromium to workspace:",
      "   PowerShell: $env:PLAYWRIGHT_BROWSERS_PATH='.playwright-browsers'; npx playwright install chromium",
      "   CMD: set PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers && npx playwright install chromium"
    ].join("\n")
  }
  return "Run: PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npx playwright install chromium"
}

async function summarizeSession(id: string, session: PlaywrightSession): Promise<{
  sessionId: string
  url: string
  title: string
  createdAt: number
  lastUsedAt: number
  active: boolean
}> {
  let title = ""
  try {
    title = await session.page.title()
  } catch {
    title = ""
  }
  return {
    sessionId: id,
    url: session.page.url(),
    title,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    active: id === activeSessionId
  }
}

export function createPlaywrightTool(workspacePath: string) {
  const localBrowsersPath = path.join(workspacePath, ".playwright-browsers")

  return tool(
    async (input) => {
      const timeout = input.timeoutMs ?? 30_000
      const waitUntil = input.waitUntil ?? "domcontentloaded"

      try {
        switch (input.action) {
          case "launch": {
            if (existsSync(localBrowsersPath)) {
              process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsersPath
            }
            const baseLaunchOptions = {
              headless: input.headless ?? false,
              slowMo: input.slowMoMs
            }
            const resolvedExecutablePath = resolveExecutablePath(workspacePath, input.executablePath)
            const attempts: Array<{ label: string; options: Parameters<typeof chromium.launch>[0] }> = []

            if (resolvedExecutablePath) {
              attempts.push({
                label: `executablePath:${resolvedExecutablePath}`,
                options: { ...baseLaunchOptions, executablePath: resolvedExecutablePath }
              })
            } else if (input.channel) {
              attempts.push({
                label: `channel:${input.channel}`,
                options: { ...baseLaunchOptions, channel: input.channel }
              })
            } else {
              attempts.push({ label: "chromium", options: { ...baseLaunchOptions } })
              if (process.platform === "win32") {
                attempts.push({ label: "channel:msedge", options: { ...baseLaunchOptions, channel: "msedge" } })
                attempts.push({ label: "channel:chrome", options: { ...baseLaunchOptions, channel: "chrome" } })
              } else {
                attempts.push({ label: "channel:chrome", options: { ...baseLaunchOptions, channel: "chrome" } })
              }
            }

            let browser: Browser | null = null
            let launchMode = ""
            const launchErrors: string[] = []
            for (const attempt of attempts) {
              try {
                browser = await chromium.launch(attempt.options)
                launchMode = attempt.label
                break
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error)
                const compact = message.split("\n")[0]
                launchErrors.push(`${attempt.label}: ${compact}`)
              }
            }

            if (!browser) {
              throw new Error(
                `Failed to launch browser.\n${launchErrors.join("\n")}\n${getMissingBrowserHelp()}`
              )
            }

            const context = await browser.newContext({
              viewport: input.viewportWidth && input.viewportHeight
                ? { width: input.viewportWidth, height: input.viewportHeight }
                : undefined
            })
            const page = await context.newPage()
            const sessionId = randomUUID()
            const now = Date.now()
            sessions.set(sessionId, {
              browser,
              context,
              page,
              createdAt: now,
              lastUsedAt: now
            })
            activeSessionId = sessionId
            if (input.url) {
              await page.goto(input.url, { waitUntil, timeout })
            }
            const title = await page.title().catch(() => "")
            return JSON.stringify({
              success: true,
              sessionId,
              launchMode,
              url: page.url(),
              title,
              active: true
            })
          }

          case "goto": {
            if (!input.url) return buildError("url is required for goto")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            const response = await target.session.page.goto(input.url, { waitUntil, timeout })
            touchSession(target.session)
            return JSON.stringify({
              success: true,
              sessionId: target.id,
              status: response?.status() ?? null,
              url: target.session.page.url(),
              title: await target.session.page.title().catch(() => "")
            })
          }

          case "click": {
            if (!input.selector) return buildError("selector is required for click")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            await target.session.page.click(input.selector, { timeout })
            touchSession(target.session)
            return JSON.stringify({ success: true, sessionId: target.id, action: "click", selector: input.selector })
          }

          case "fill": {
            if (!input.selector) return buildError("selector is required for fill")
            if (input.text == null) return buildError("text is required for fill")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            await target.session.page.fill(input.selector, input.text, { timeout })
            touchSession(target.session)
            return JSON.stringify({ success: true, sessionId: target.id, action: "fill", selector: input.selector })
          }

          case "type": {
            if (!input.selector) return buildError("selector is required for type")
            if (input.text == null) return buildError("text is required for type")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            await target.session.page.click(input.selector, { timeout })
            await target.session.page.type(input.selector, input.text, { timeout })
            touchSession(target.session)
            return JSON.stringify({ success: true, sessionId: target.id, action: "type", selector: input.selector })
          }

          case "press": {
            if (!input.key) return buildError("key is required for press")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            if (input.selector) {
              await target.session.page.press(input.selector, input.key, { timeout })
            } else {
              await target.session.page.keyboard.press(input.key)
            }
            touchSession(target.session)
            return JSON.stringify({ success: true, sessionId: target.id, action: "press", key: input.key, selector: input.selector ?? null })
          }

          case "wait_for_selector": {
            if (!input.selector) return buildError("selector is required for wait_for_selector")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            await target.session.page.waitForSelector(input.selector, {
              state: input.waitForState ?? "visible",
              timeout
            })
            touchSession(target.session)
            return JSON.stringify({
              success: true,
              sessionId: target.id,
              action: "wait_for_selector",
              selector: input.selector,
              state: input.waitForState ?? "visible"
            })
          }

          case "text_content": {
            if (!input.selector) return buildError("selector is required for text_content")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            const text = await target.session.page.textContent(input.selector, { timeout })
            touchSession(target.session)
            return JSON.stringify({
              success: true,
              sessionId: target.id,
              selector: input.selector,
              text: text ?? ""
            })
          }

          case "screenshot": {
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session. Call action=launch first.")
            const outPath = resolveOutputPath(workspacePath, input.screenshotPath)
            mkdirSync(path.dirname(outPath), { recursive: true })
            await target.session.page.screenshot({
              path: outPath,
              fullPage: input.fullPage ?? true
            })
            touchSession(target.session)
            return JSON.stringify({
              success: true,
              sessionId: target.id,
              path: outPath
            })
          }

          case "set_active": {
            if (!input.sessionId) return buildError("sessionId is required for set_active")
            const target = resolveSession(input.sessionId)
            if (!target) return buildError(`Session not found: ${input.sessionId}`)
            activeSessionId = target.id
            touchSession(target.session)
            return JSON.stringify({ success: true, activeSessionId: target.id })
          }

          case "list_sessions": {
            const list = await Promise.all(Array.from(sessions.entries()).map(([id, session]) => summarizeSession(id, session)))
            return JSON.stringify({
              success: true,
              activeSessionId,
              sessions: list
            })
          }

          case "close": {
            const target = resolveSession(input.sessionId)
            if (!target) return buildError("No active session to close.")
            await target.session.context.close().catch(() => {})
            await target.session.browser.close().catch(() => {})
            sessions.delete(target.id)
            if (activeSessionId === target.id) {
              activeSessionId = sessions.keys().next().value ?? null
            }
            return JSON.stringify({
              success: true,
              closedSessionId: target.id,
              activeSessionId
            })
          }

          case "close_all": {
            const ids = Array.from(sessions.keys())
            for (const id of ids) {
              const session = sessions.get(id)
              if (!session) continue
              await session.context.close().catch(() => {})
              await session.browser.close().catch(() => {})
              sessions.delete(id)
            }
            activeSessionId = null
            return JSON.stringify({ success: true, closedSessionIds: ids, activeSessionId: null })
          }

          default:
            return buildError(`Unsupported action: ${String(input.action)}`)
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("Executable doesn't exist") || message.includes("Failed to launch browser")) {
          return buildError(`${message}`)
        }
        return buildError(message)
      }
    },
    {
      name: "browser_playwright",
      description:
        "Open and automate a real browser with Playwright. Supports launching browser sessions, navigation, clicking, typing, key presses, waiting for selectors, reading text content, and screenshots.",
      schema: playwrightSchema
    }
  )
}
