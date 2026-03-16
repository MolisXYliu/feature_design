import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { v4 as uuid } from "uuid"
import { deleteTraceById, deleteTraces, getTracesDir } from "../agent/trace/collector"

let testDir = ""

function writeTrace(threadId: string, traceId: string): void {
  const dir = join(testDir, threadId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${traceId}.jsonl`), JSON.stringify({ traceId }) + "\n", "utf-8")
}

beforeEach(() => {
  testDir = join(tmpdir(), `cmb-trace-${uuid()}`)
  process.env.CMB_COWORK_TRACES_DIR = testDir
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  delete process.env.CMB_COWORK_TRACES_DIR
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
})

describe("trace deletion", () => {
  it("deletes a single trace file", () => {
    writeTrace("t1", "trace-ok")

    const result = deleteTraceById("trace-ok")

    expect(result.success).toBe(true)
    expect(existsSync(join(getTracesDir(), "t1", "trace-ok.jsonl"))).toBe(false)
  })

  it("returns partial failures for batch delete", () => {
    writeTrace("t1", "trace-good")

    const badDir = join(getTracesDir(), "t1", "trace-bad.jsonl")
    mkdirSync(badDir, { recursive: true })

    const result = deleteTraces(["trace-good", "trace-bad", "trace-missing"])

    expect(result.deletedIds).toContain("trace-good")
    expect(result.deletedIds).toContain("trace-missing")
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].traceId).toBe("trace-bad")
  })

  it("is idempotent for missing trace", () => {
    const result = deleteTraceById("not-found")
    expect(result.success).toBe(true)
  })

  it("deletes matching trace from multi-line jsonl file", () => {
    const dir = join(getTracesDir(), "t2")
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, "mixed.jsonl")
    writeFileSync(
      filePath,
      `${JSON.stringify({ traceId: "trace-a", foo: 1 })}\n${JSON.stringify({ traceId: "trace-b", foo: 2 })}\n`,
      "utf-8"
    )

    const result = deleteTraceById("trace-b")

    expect(result.success).toBe(true)
    const remain = existsSync(filePath) ? readFileSync(filePath, "utf-8") : ""
    expect(remain).toContain("\"trace-a\"")
    expect(remain).not.toContain("\"trace-b\"")
  })
})
