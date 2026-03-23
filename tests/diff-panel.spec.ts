/**
 * Playwright Electron E2E test: optimizer candidate diff view
 *
 * Verifies that when a "patch" candidate card is expanded in the Evolution Panel,
 * the SKILL.MD 变更 section renders a diff view (react-diff-viewer <table>)
 * instead of a plain Markdown fallback.
 *
 * Run:
 *   npx tsx tests/diff-panel.spec.ts
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
  log("Checking prerequisites...")
  if (!fs.existsSync(MAIN_ENTRY)) throw new Error(`No built output at ${MAIN_ENTRY} — run npm run build first`)
  const candidatesFile = path.join(process.env.HOME ?? "/", ".cmbcoworkagent", "optimizer-candidates.json")
  if (!fs.existsSync(candidatesFile)) throw new Error(`No candidates file at ${candidatesFile}`)
  const candidates: Array<{ action: string }> = JSON.parse(fs.readFileSync(candidatesFile, "utf-8"))
  if (!candidates.some((c) => c.action === "patch")) throw new Error("No patch candidates found")
  log("✅ Prerequisites OK")

  log("🚀 Launching Electron app...")
  let app: ElectronApplication | undefined

  try {
    app = await electron.launch({
      executablePath: ELECTRON_BIN,
      args: [MAIN_ENTRY],
      cwd: PROJECT_ROOT,
      timeout: 30_000,
    })

    const page = await app.firstWindow()
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2_500)
    log("✅ Window loaded")
    await shot(page, "01-initial")

    // ── Step 1: Click "自定义" in the left sidebar → opens CustomizeView ─────
    log("Clicking 自定义 in sidebar...")
    const customizeLink = page.locator("text=自定义").first()
    await customizeLink.waitFor({ timeout: 10_000 })
    await customizeLink.click()
    await page.waitForTimeout(1_000)
    await shot(page, "02-customize-view")
    log("✅ CustomizeView open")

    // ── Step 2: Click "自优化" tab inside CustomizeView ───────────────────────
    log("Clicking 自优化 tab...")
    const selfOptTab = page.locator("text=自优化").first()
    await selfOptTab.waitFor({ timeout: 10_000 })
    await selfOptTab.click()
    await page.waitForTimeout(1_000)
    await shot(page, "03-selfopt-tab")
    log("✅ On 自优化 tab (EvolutionPanel)")

    // ── Step 3: Click the "优化候选" sub-tab ──────────────────────────────────
    log("Looking for 优化候选 sub-tab...")
    const optimizationTab = page.locator("text=优化候选").first()
    await optimizationTab.waitFor({ timeout: 10_000 })
    await optimizationTab.click()
    await page.waitForTimeout(800)
    await shot(page, "04-optimization-tab")
    log("✅ On 优化候选 sub-tab")

    // ── Step 3: Find patch candidate card and expand it ───────────────────────
    log("Looking for patch candidate card (更新 badge)...")
    // The card has a "更新" badge for patch action
    const patchCard = page.locator(".rounded-lg.border").filter({ has: page.locator("text=更新") }).first()
    await patchCard.waitFor({ timeout: 10_000 })
    log("✅ Found patch candidate card")

    // Click the expand toggle (first button = ChevronRight)
    const toggle = patchCard.locator("button").first()
    await toggle.click()
    await page.waitForTimeout(800)
    await shot(page, "05-card-expanded")
    log("✅ Card expanded")

    // ── Step 4: Verify label is "SKILL.md 变更" ───────────────────────────────
    const label = page.locator("text=SKILL.md 变更")
    await label.waitFor({ timeout: 5_000 })
    log('✅ Label "SKILL.md 变更" visible')

    // ── Step 5: Wait for loading spinner to resolve ───────────────────────────
    log("Waiting for old skill content to load...")
    const spinner = page.locator("text=正在加载旧版内容")
    // Spinner may be brief — wait for it to appear then disappear, or just wait for hidden
    await spinner.waitFor({ state: "hidden", timeout: 15_000 }).catch(() =>
      log("  (spinner not seen — load may be instant)")
    )
    await page.waitForTimeout(500)
    await shot(page, "06-after-load")

    // ── Step 6: Assert diff table rendered ────────────────────────────────────
    log("Checking for diff view (react-diff-viewer table)...")
    const diffTable = page.locator("table").first()
    const diffVisible = await diffTable.isVisible().catch(() => false)

    if (diffVisible) {
      const rowCount = await page.locator("table tr").count()
      await shot(page, "07-diff-success")
      log(`✅ PASS: Diff table visible with ${rowCount} rows`)
    } else {
      // Diagnose what is shown instead
      const fallbackVisible = await page.locator(".prose").first().isVisible().catch(() => false)
      await shot(page, "fail-no-diff")
      const hint = fallbackVisible
        ? "Markdown fallback shown — old skill content not loaded (skill name mismatch or IPC failure)"
        : "Neither diff nor markdown found"
      throw new Error(`FAIL: Diff view not rendered. ${hint}`)
    }

    log("\n🎉 Test passed — diff view is working correctly!")
  } finally {
    if (app) await app.close().catch(() => {})
  }
}

run().catch((err: Error) => {
  console.error(`\n❌ ${err.message}`)
  process.exit(1)
})
