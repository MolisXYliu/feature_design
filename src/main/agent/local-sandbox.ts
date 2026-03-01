/**
 * LocalSandbox: Execute shell commands locally on the host machine.
 *
 * Extends FilesystemBackend with command execution capability.
 * Commands run in the workspace directory with configurable timeout and output limits.
 *
 * Security note: This has NO built-in safeguards except for the human-in-the-loop
 * middleware provided by the agent framework. All command approval should be
 * handled via HITL configuration.
 */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import {
  FilesystemBackend,
  type ExecuteResponse,
  type SandboxBackendProtocol,
  type GrepMatch,
  type FileInfo
} from "deepagents"

/**
 * Options for LocalSandbox configuration.
 */
export interface LocalSandboxOptions {
  /** Root directory for file operations and command execution (default: process.cwd()) */
  rootDir?: string
  /** Enable virtual path mode where "/" maps to rootDir (default: false) */
  virtualMode?: boolean
  /** Maximum file size in MB for file operations (default: 10) */
  maxFileSizeMb?: number
  /** Command timeout in milliseconds (default: 120000 = 2 minutes) */
  timeout?: number
  /** Maximum output bytes before truncation (default: 100000 = ~100KB) */
  maxOutputBytes?: number
  /** Environment variables to pass to commands (default: process.env) */
  env?: Record<string, string>
}

/**
 * LocalSandbox backend with shell command execution.
 *
 * Extends FilesystemBackend to inherit all file operations (ls, read, write,
 * edit, glob, grep) and adds execute() for running shell commands locally.
 *
 * @example
 * ```typescript
 * const sandbox = new LocalSandbox({
 *   rootDir: '/path/to/workspace',
 *   virtualMode: true,
 *   timeout: 60_000,
 * });
 *
 * const result = await sandbox.execute('npm test');
 * console.log(result.output);
 * console.log('Exit code:', result.exitCode);
 * ```
 */
export class LocalSandbox extends FilesystemBackend implements SandboxBackendProtocol {
  /** Unique identifier for this sandbox instance */
  readonly id: string

  private readonly timeout: number
  private readonly maxOutputBytes: number
  private readonly env: Record<string, string>
  private readonly workingDir: string

  constructor(options: LocalSandboxOptions = {}) {
    super({
      rootDir: options.rootDir,
      virtualMode: options.virtualMode,
      maxFileSizeMb: options.maxFileSizeMb
    })

    this.id = `local-sandbox-${randomUUID().slice(0, 8)}`
    this.timeout = options.timeout ?? 120_000 // 2 minutes default
    this.maxOutputBytes = options.maxOutputBytes ?? 100_000 // ~100KB default
    this.env = options.env ?? ({ ...process.env } as Record<string, string>)
    this.workingDir = options.rootDir ?? process.cwd()

    this.patchResolvePath()
  }

  /**
   * Patch resolvePath at instance level to redirect deepagents' internal
   * path (/large_tool_results/...) into the workspace directory.
   * Covers ALL file operations (read, write, edit, list, grep, glob)
   * since they all funnel through resolvePath internally.
   */
  private patchResolvePath(): void {
    if (typeof (this as any).resolvePath !== "function") {
      console.warn("[LocalSandbox] resolvePath not found on FilesystemBackend — skipping path patch")
      return
    }
    const original = (this as any).resolvePath.bind(this)
    const workingDir = this.workingDir
    const redirects: Record<string, string> = {
      "/large_tool_results/": ".cmbcoworkagent/large_tool_results"
    }
    ;(this as any).resolvePath = (key: string): string => {
      for (const [prefix, localDir] of Object.entries(redirects)) {
        if (key.startsWith(prefix)) {
          const redirected = join(workingDir, localDir, key.slice(prefix.length))
          console.log("[LocalSandbox] Redirecting path:", key, "→", redirected)
          key = redirected
          break
        }
      }
      return original(key)
    }
  }

  private static readonly MAX_GREP_MATCHES = 200
  private static readonly MAX_GREP_CHARS = 24_000
  private static readonly MAX_GLOB_ENTRIES = 400
  private static readonly MAX_LS_ENTRIES = 300

  /**
   * Override grepRaw to cap results for codebase exploration.
   * In this LocalSandbox path (FilesystemBackend-based), grep results can
   * otherwise grow very large and pressure small model context windows.
   */
  async grepRaw(
    pattern: string,
    path?: string,
    glob?: string | null
  ): Promise<GrepMatch[] | string> {
    const results = await super.grepRaw(pattern, path ?? "/", glob)
    if (typeof results === "string") return results
    if (results.length === 0) return results

    const capped: GrepMatch[] = []
    let charCount = 0

    for (const match of results) {
      if (capped.length >= LocalSandbox.MAX_GREP_MATCHES) break
      const estChars = match.path.length + match.text.length + 16
      if (charCount + estChars > LocalSandbox.MAX_GREP_CHARS) break
      capped.push(match)
      charCount += estChars
    }

    if (capped.length < results.length) {
      const omitted = results.length - capped.length
      console.log(
        "[LocalSandbox] grepRaw capped results:",
        `${capped.length}/${results.length}`,
        `(omitted ${omitted}, chars=${charCount})`
      )
      capped.push({
        path: "(truncated)",
        line: 0,
        text: `... ${omitted} more matches omitted. Refine pattern/path/glob and run grep again.`
      })
    }

    return capped
  }

  /**
   * Cap glob results because repository-wide globs can easily return thousands
   * of files and consume context on small windows.
   */
  async globInfo(pattern: string, path = "/"): Promise<FileInfo[]> {
    const infos = await super.globInfo(pattern, path)
    if (infos.length <= LocalSandbox.MAX_GLOB_ENTRIES) return infos

    const capped = infos.slice(0, LocalSandbox.MAX_GLOB_ENTRIES)
    const omitted = infos.length - capped.length
    console.log(
      "[LocalSandbox] globInfo capped results:",
      `${capped.length}/${infos.length}`,
      `for pattern=${pattern}`
    )
    capped.push({
      path: `(truncated) ... ${omitted} more files omitted. Use a more specific glob pattern or path.`,
      is_dir: false
    } as FileInfo)
    return capped
  }

  /**
   * Light cap for ls to avoid pathological large directory listings.
   */
  async lsInfo(path: string): Promise<FileInfo[]> {
    const infos = await super.lsInfo(path)
    if (infos.length <= LocalSandbox.MAX_LS_ENTRIES) return infos

    const capped = infos.slice(0, LocalSandbox.MAX_LS_ENTRIES)
    const omitted = infos.length - capped.length
    console.log(
      "[LocalSandbox] lsInfo capped results:",
      `${capped.length}/${infos.length}`,
      `for path=${path}`
    )
    capped.push({
      path: `(truncated) ... ${omitted} more entries omitted. Use a more specific path.`,
      is_dir: false
    } as FileInfo)
    return capped
  }

  /**
   * Execute a shell command in the workspace directory.
   *
   * @param command - Shell command string to execute
   * @returns ExecuteResponse with combined output, exit code, and truncation flag
   *
   * @example
   * ```typescript
   * const result = await sandbox.execute('echo "Hello World"');
   * // result.output: "Hello World\n"
   * // result.exitCode: 0
   * // result.truncated: false
   * ```
   */
  async execute(command: string): Promise<ExecuteResponse> {
    if (!command || typeof command !== "string") {
      return {
        output: "Error: Shell tool expects a non-empty command string.",
        exitCode: 1,
        truncated: false
      }
    }

    return new Promise<ExecuteResponse>((resolve) => {
      const outputParts: string[] = []
      let totalBytes = 0
      let truncated = false
      let resolved = false

      // Determine shell based on platform
      const isWindows = process.platform === "win32"
      const shell = isWindows ? "cmd.exe" : "/bin/sh"
      const shellArgs = isWindows ? ["/c", command] : ["-c", command]

      const proc = spawn(shell, shellArgs, {
        cwd: this.workingDir,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"]
      })

      // Handle timeout
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          proc.kill("SIGTERM")
          // Give it a moment, then force kill
          setTimeout(() => proc.kill("SIGKILL"), 1000)
          resolve({
            output: `Error: Command timed out after ${(this.timeout / 1000).toFixed(1)} seconds.`,
            exitCode: null,
            truncated: false
          })
        }
      }, this.timeout)

      // Collect stdout
      proc.stdout.on("data", (data: Buffer) => {
        if (truncated) return

        const chunk = data.toString()
        const newTotal = totalBytes + chunk.length

        if (newTotal > this.maxOutputBytes) {
          // Truncate to fit within limit
          const remaining = this.maxOutputBytes - totalBytes
          if (remaining > 0) {
            outputParts.push(chunk.slice(0, remaining))
          }
          truncated = true
          totalBytes = this.maxOutputBytes
        } else {
          outputParts.push(chunk)
          totalBytes = newTotal
        }
      })

      // Collect stderr with [stderr] prefix per line
      proc.stderr.on("data", (data: Buffer) => {
        if (truncated) return

        const chunk = data.toString()
        // Prefix each line with [stderr]
        const prefixedLines = chunk
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => `[stderr] ${line}`)
          .join("\n")

        if (prefixedLines.length === 0) return

        const withNewline = prefixedLines + (chunk.endsWith("\n") ? "\n" : "")
        const newTotal = totalBytes + withNewline.length

        if (newTotal > this.maxOutputBytes) {
          const remaining = this.maxOutputBytes - totalBytes
          if (remaining > 0) {
            outputParts.push(withNewline.slice(0, remaining))
          }
          truncated = true
          totalBytes = this.maxOutputBytes
        } else {
          outputParts.push(withNewline)
          totalBytes = newTotal
        }
      })

      // Handle process exit
      proc.on("close", (code, signal) => {
        if (resolved) return
        resolved = true
        clearTimeout(timeoutId)

        let output = outputParts.join("")

        // Add truncation notice if needed
        if (truncated) {
          output += `\n\n... Output truncated at ${this.maxOutputBytes} bytes.`
        }

        // If no output, show placeholder
        if (!output.trim()) {
          output = "<no output>"
        }

        resolve({
          output,
          exitCode: signal ? null : code,
          truncated
        })
      })

      // Handle spawn errors
      proc.on("error", (err) => {
        if (resolved) return
        resolved = true
        clearTimeout(timeoutId)

        resolve({
          output: `Error: Failed to execute command: ${err.message}`,
          exitCode: 1,
          truncated: false
        })
      })
    })
  }
}
