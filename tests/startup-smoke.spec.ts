/**
 * Playwright Electron smoke test: verify app launches without white screen
 *
 * Checks:
 *  1. Electron window loads successfully
 *  2. ThreadSidebar renders (no showCustomizeView crash)
 *  3. Chat input area is visible
 *  4. No uncaught ReferenceError in renderer
 *
 * Run:
 *   npx tsx tests/startup-smoke.spec.ts
 */

import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import path from "path"
import fs from "fs"

const PROJECT_ROOT = path.resolve(__dirname, "..")
const ELECTRON_BIN = path.join(PROJECT_ROOT, "node_modules", ".bin", "electron")
const MAIN_ENTRY = path.join(PROJECT_ROOT, "out", "main", "index.js")
const SCREENSHOT_DIR = path.join(PROJECT_ROOT, "tests", "screenshots")

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`)
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const file = path.join(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  log(`📸 ${file}`)
}

async function run(): Promise<void> {
  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error(`No built output at ${MAIN_ENTRY} — run npm run build first`)
  }

  log("🚀 Launching Electron app...")
  let app: ElectronApplication | undefined
  const rendererErrors: string[] = []

  try {
    app = await electron.launch({
      executablePath: ELECTRON_BIN,
      args: [MAIN_ENTRY],
      cwd: PROJECT_ROOT,
      timeout: 30_000,
    })

    const page = await app.firstWindow()

    // Collect any uncaught JS errors from the renderer
    page.on("pageerror", (err) => {
      rendererErrors.push(err.message)
      log(`  ⚠️  Renderer error: ${err.message}`)
    })

    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(3_000)
    log("✅ Window loaded")
    await shot(page, "smoke-01-initial")

    // ── Check 1: Page is not blank ─────────────────────────────────────────
    const bodyText = await page.evaluate(() => document.body.innerText)
    const bodyHTML = await page.evaluate(() => document.body.innerHTML)
    if (bodyHTML.trim().length < 100) {
      await shot(page, "smoke-fail-blank")
      throw new Error("FAIL: Page body is essentially empty — white screen detected")
    }
    log(`✅ Page has content (${bodyHTML.length} chars)`)

    // ── Check 2: Sidebar rendered (ThreadSidebar) ──────────────────────────
    // The sidebar contains a "新建对话" button or thread list items
    const sidebarSelectors = [
      "text=新建对话",
      "[data-testid='thread-sidebar']",
      "text=Thread",
    ]
    let sidebarFound = false
    for (const sel of sidebarSelectors) {
      const el = page.locator(sel).first()
      const visible = await el.isVisible().catch(() => false)
      if (visible) {
        log(`✅ Sidebar visible (matched: "${sel}")`)
        sidebarFound = true
        break
      }
    }
    if (!sidebarFound) {
      // Try a broader check — something in the left panel area
      const leftPanel = page.locator("aside, [class*='sidebar'], [class*='Sidebar']").first()
      sidebarFound = await leftPanel.isVisible().catch(() => false)
      if (sidebarFound) {
        log("✅ Sidebar visible (matched: aside/sidebar class)")
      }
    }
    if (!sidebarFound) {
      await shot(page, "smoke-fail-no-sidebar")
      throw new Error("FAIL: ThreadSidebar not visible — component may have crashed")
    }

    // ── Check 3: Chat area rendered ────────────────────────────────────────
    const chatSelectors = [
      "textarea",
      "input[type='text']",
      "[placeholder*='消息']",
      "[placeholder*='message']",
      "text=发送",
    ]
    let chatFound = false
    for (const sel of chatSelectors) {
      const el = page.locator(sel).first()
      const visible = await el.isVisible().catch(() => false)
      if (visible) {
        log(`✅ Chat input visible (matched: "${sel}")`)
        chatFound = true
        break
      }
    }
    if (!chatFound) {
      await shot(page, "smoke-fail-no-chat")
      throw new Error("FAIL: Chat input not found — ChatContainer may have crashed")
    }

    // ── Check 4: No critical ReferenceErrors ───────────────────────────────
    const criticalErrors = rendererErrors.filter(
      (e) => e.includes("ReferenceError") || e.includes("is not defined")
    )
    if (criticalErrors.length > 0) {
      await shot(page, "smoke-fail-js-error")
      throw new Error(`FAIL: Renderer ReferenceErrors detected:\n  ${criticalErrors.join("\n  ")}`)
    }
    log("✅ No ReferenceErrors in renderer")

    await shot(page, "smoke-02-final")
    log("\n🎉 All checks passed — app launches without white screen!")

    // Print body text summary for visibility
    const preview = bodyText.slice(0, 200).replace(/\n+/g, " ")
    log(`   Page text preview: "${preview}..."`)

  } finally {
    if (app) await app.close().catch(() => {})
  }
}

run().catch((err: Error) => {
  console.error(`\n❌ ${err.message}`)
  process.exit(1)
})
