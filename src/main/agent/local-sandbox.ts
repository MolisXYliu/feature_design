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

import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants as fsConstants, existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import {
  FilesystemBackend,
  type EditResult,
  type ExecuteResponse,
  type SandboxBackendProtocol,
  type GrepMatch,
  type FileInfo
} from "deepagents"
import fg from "fast-glob"
import * as iconv from "iconv-lite"
import * as chardet from "jschardet"
import micromatch from "micromatch"
import { replace } from "./replace"

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

    // TODO: patchResolvePath 暂时禁用，实测 /large_tool_results 在 Mac/Linux/Windows 均可直接写入
    // 若后续 deepagents 开放 eviction 路径配置，可直接删除此段代码
    // this.patchResolvePath()

  }

  // private patchResolvePath(): void {
  //   if (typeof (this as any).resolvePath !== "function") {
  //     console.warn("[LocalSandbox] resolvePath not found on FilesystemBackend — skipping path patch")
  //     return
  //   }
  //   const original = (this as any).resolvePath.bind(this)
  //   const workingDir = this.workingDir
  //   const redirects: Record<string, string> = {
  //     "/large_tool_results/": ".cmbcoworkagent/large_tool_results"
  //   }
  //   ;(this as any).resolvePath = (key: string): string => {
  //     for (const [prefix, localDir] of Object.entries(redirects)) {
  //       if (key.startsWith(prefix)) {
  //         const redirected = join(workingDir, localDir, key.slice(prefix.length))
  //         console.log("[LocalSandbox] Redirecting path:", key, "→", redirected)
  //         key = redirected
  //         break
  //       }
  //     }
  //     return original(key)
  //   }
  // }

  private static readonly MAX_GREP_MATCHES = 200
  private static readonly MAX_GREP_CHARS = 24_000
  private static readonly MAX_GLOB_ENTRIES = 400
  private static readonly MAX_LS_ENTRIES = 300

  /**
   * Override grepRaw to:
   * 1. Fall back to encoding-aware search when parent returns no results
   *    (parent's literalSearch is hardcoded UTF-8, misses non-UTF-8 files)
   * 2. Cap results for codebase exploration to avoid pressuring small context windows
   */
  async grepRaw(
    pattern: string,
    dirPath?: string,
    glob?: string | null
  ): Promise<GrepMatch[] | string> {
    const resolved = dirPath ?? "/"
    const t0 = Date.now()
    let results = await super.grepRaw(pattern, resolved, glob)
    const parentMs = Date.now() - t0
    if (typeof results === "string") return results

    let source = results.length > 0 ? "ripgrep" : "none"

    if (results.length === 0) {
      let baseFull: string
      try {
        baseFull = (this as any).resolvePath(resolved === "/" ? "." : resolved)
      } catch {
        return results
      }
      const t1 = Date.now()
      const rawResults = await this.encodingAwareLiteralSearch(pattern, baseFull, glob ?? null)
      const fallbackMs = Date.now() - t1
      for (const [fpath, items] of Object.entries(rawResults)) {
        for (const [lineNum, lineText] of items) {
          results.push({ path: fpath, line: lineNum, text: lineText })
        }
      }
      if (results.length > 0) source = "encoding-aware-fallback"
      console.log(
        `[LocalSandbox] grepRaw fallback: pattern="${pattern}", results=${results.length}, fallbackMs=${fallbackMs}`
      )
    }

    console.log(
      `[LocalSandbox] grepRaw: source=${source}, pattern="${pattern}", results=${results.length}, parentMs=${parentMs}`
    )

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
        text: `Found ${results.length} total matches, showing first ${capped.length}. ${omitted} omitted — refine pattern/path/glob.`
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
      path: `(truncated) Found ${infos.length} total, showing first ${capped.length}. ${omitted} omitted — use a more specific glob pattern or path.`,
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
      path: `(truncated) Found ${infos.length} total, showing first ${capped.length}. ${omitted} omitted — use a more specific path.`,
      is_dir: false
    } as FileInfo)
    return capped
  }

  private static readonly LINE_NUMBER_WIDTH = 6
  private static readonly MAX_LINE_LENGTH = 10_000

  private static readonly SUPPORTS_NOFOLLOW =
    typeof fsConstants.O_NOFOLLOW === "number"

  private static readonly KNOWN_BINARY_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
    ".mp3", ".mp4", ".wav", ".mov", ".avi", ".mkv",
    ".zip", ".gz", ".tar", ".rar", ".7z",
    ".exe", ".dll", ".so", ".dylib",
    ".woff", ".woff2", ".ttf", ".otf",
    ".pyc", ".class", ".o", ".obj",
    ".sqlite", ".db",
    ".pdf", ".doc", ".xls", ".ppt",
    ".docx", ".xlsx", ".pptx"
  ])

  /**
   * Detect file encoding from raw buffer (same as Cline's detectEncoding):
   * 0. Fast reject known binary extensions before any I/O-heavy detection
   * 1. Try jschardet — if it returns a valid encoding, use it
   * 2. If detection fails, check for binary via null-byte sampling
   * 3. Fallback to utf-8 for plain text
   */
  private detectEncoding(buffer: Buffer, ext?: string): string {
    if (ext && LocalSandbox.KNOWN_BINARY_EXTENSIONS.has(ext)) {
      throw new Error(`Cannot read binary file type: ${ext}`)
    }

    const detected = chardet.detect(buffer)
    if (detected && detected.encoding && iconv.encodingExists(detected.encoding)) {
      return detected.encoding
    }

    // jschardet could not determine encoding — check if it's binary
    const sampleLen = Math.min(8192, buffer.length)
    for (let i = 0; i < sampleLen; i++) {
      if (buffer[i] === 0) {
        throw new Error(`Cannot read text for file type: ${ext || "unknown"}`)
      }
    }
    return "utf-8"
  }

  /**
   * Format lines with line numbers (compatible with deepagents' format).
   * Long lines are chunked with continuation markers (e.g. 5.1, 5.2).
   */
  private formatLines(lines: string[], startLine: number): string {
    const result: string[] = []
    const w = LocalSandbox.LINE_NUMBER_WIDTH
    const maxLen = LocalSandbox.MAX_LINE_LENGTH

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + startLine
      if (line.length <= maxLen) {
        result.push(`${lineNum.toString().padStart(w)}\t${line}`)
      } else {
        const numChunks = Math.ceil(line.length / maxLen)
        for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
          const start = chunkIdx * maxLen
          const chunk = line.slice(start, start + maxLen)
          if (chunkIdx === 0) {
            result.push(`${lineNum.toString().padStart(w)}\t${chunk}`)
          } else {
            result.push(`${`${lineNum}.${chunkIdx}`.padStart(w)}\t${chunk}`)
          }
        }
      }
    }
    return result.join("\n")
  }

  /**
   * Override read to auto-detect file encoding (GBK, Shift_JIS, etc.)
   * instead of hardcoded UTF-8. Uses jschardet + iconv-lite, same as Cline.
   *
   * Preserves original FilesystemBackend features:
   *  - resolvePath() for virtual mode / security
   *  - O_NOFOLLOW / symlink protection
   *  - offset/limit pagination
   *  - long-line chunking with continuation markers
   *
   * Adds (same as Cline):
   *  - Automatic encoding detection via jschardet
   *  - Multi-encoding decoding via iconv-lite
   *  - Binary file detection as fallback when jschardet fails
   */
  async read(filePath: string, offset = 0, limit = 500): Promise<string> {
    try {
      const { buffer, resolvedPath } = await this.readFileBuffer(filePath)

      const ext = path.extname(resolvedPath).toLowerCase()
      const encoding = this.detectEncoding(buffer, ext)
      const content = iconv.decode(buffer, encoding)

      if (!content || content.trim() === "") return "System reminder: File exists but has empty contents"

      const lines = content.split("\n")
      if (offset >= lines.length) {
        return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`
      }

      const total = lines.length
      const hasMore = offset + limit < total
      const end = Math.min(offset + (hasMore ? limit - 1 : limit), total)
      const formatted = this.formatLines(lines.slice(offset, end), offset + 1)
      if (hasMore) {
        return `[Lines ${offset + 1}-${end} of ${total}. Use offset=${end} to read more.]\n` + formatted
      }
      return formatted
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Error reading file '${filePath}': ${msg}`
    }
  }

  /**
   * Read a file as a raw Buffer with symlink protection.
   * Shared helper for read(), edit(), and other encoding-aware operations.
   */
  private async readFileBuffer(filePath: string): Promise<{ buffer: Buffer; resolvedPath: string }> {
    const resolvedPath: string = (this as any).resolvePath(filePath)

    let buffer: Buffer
    if (LocalSandbox.SUPPORTS_NOFOLLOW) {
      if (!(await fs.lstat(resolvedPath)).isFile()) {
        throw new Error(`File '${filePath}' not found`)
      }
      const fd = await fs.open(
        resolvedPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      )
      try {
        buffer = await fd.readFile()
      } finally {
        await fd.close()
      }
    } else {
      const stat = await fs.lstat(resolvedPath)
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${filePath}`)
      if (!stat.isFile()) throw new Error(`File '${filePath}' not found`)
      buffer = await fs.readFile(resolvedPath)
    }

    return { buffer, resolvedPath }
  }

  /**
   * Write content back to a file with symlink protection.
   * Encodes the content with the given encoding via iconv-lite.
   */
  private async writeFileEncoded(
    resolvedPath: string,
    content: string,
    encoding: string
  ): Promise<void> {
    const encoded = iconv.encode(content, encoding)
    if (LocalSandbox.SUPPORTS_NOFOLLOW) {
      const flags =
        fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
      const fd = await fs.open(resolvedPath, flags)
      try {
        await fd.writeFile(encoded)
      } finally {
        await fd.close()
      }
    } else {
      await fs.writeFile(resolvedPath, encoded)
    }
  }

  /**
   * Override edit to:
   * 1. Auto-detect file encoding (GBK, Shift_JIS, etc.) — same as read()
   * 2. Use OpenCode's 9-layer progressive string replacement for better
   *    tolerance of LLM-generated oldString variations (whitespace, indent, escapes)
   * 3. Write back in the original encoding to avoid corrupting non-UTF-8 files
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<EditResult> {
    try {
      const { buffer, resolvedPath } = await this.readFileBuffer(filePath)
      const ext = path.extname(resolvedPath).toLowerCase()
      const encoding = this.detectEncoding(buffer, ext)
      const content = iconv.decode(buffer, encoding)

      if (content === "" && oldString === "") {
        await this.writeFileEncoded(resolvedPath, newString, encoding)
        return { path: filePath, filesUpdate: null, occurrences: 0 }
      }

      const { newContent, occurrences } = replace(content, oldString, newString, replaceAll)

      await this.writeFileEncoded(resolvedPath, newContent, encoding)

      return { path: filePath, filesUpdate: null, occurrences }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { error: `Error editing file '${filePath}': ${msg}` }
    }
  }

  /**
   * Detect encoding for command output (Windows console uses system code page).
   * Falls back to UTF-8 if detection is inconclusive.
   */
  private detectCmdEncoding(buf: Buffer): string {
    if (buf.length === 0) return "utf-8"
    const detected = chardet.detect(buf)
    const enc = typeof detected === "string" ? detected : detected?.encoding
    if (enc && iconv.encodingExists(enc)) return enc
    return "utf-8"
  }

  private static readonly SEARCH_IGNORE = [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/__pycache__/**"
  ]

  /**
   * Encoding-aware fallback for grep when ripgrep is unavailable.
   * Called from grepRaw override when parent's search returns no results,
   * to handle non-UTF-8 files via jschardet + iconv-lite.
   */
  private async encodingAwareLiteralSearch(
    pattern: string,
    baseFull: string,
    includeGlob: string | null
  ): Promise<Record<string, Array<[number, string]>>> {
    const results: Record<string, Array<[number, string]>> = {}
    const cwd = (await fs.stat(baseFull)).isDirectory()
      ? baseFull
      : path.dirname(baseFull)
    const files = await fg("**/*", {
      cwd, absolute: true, onlyFiles: true, dot: true,
      ignore: LocalSandbox.SEARCH_IGNORE
    })
    const maxBytes = ((this as any).maxFileSizeBytes as number) ?? 10 * 1024 * 1024
    const virtualMode = (this as any).virtualMode as boolean | undefined
    const cwdDir = virtualMode ? ((this as any).cwd as string) : ""

    for (const fp of files) {
      try {
        if (includeGlob && !micromatch.isMatch(path.basename(fp), includeGlob)) continue
        if ((await fs.stat(fp)).size > maxBytes) continue

        const buf = await fs.readFile(fp)
        const ext = path.extname(fp).toLowerCase()

        let encoding: string
        try {
          encoding = this.detectEncoding(buf, ext)
        } catch {
          continue
        }

        const content = iconv.decode(buf, encoding)
        const lines = content.split("\n")

        let virtPath: string | null = null
        if (virtualMode) {
          try {
            const relative = path.relative(cwdDir, fp)
            if (relative.startsWith("..")) continue
            virtPath = "/" + relative.split(path.sep).join("/")
          } catch {
            continue
          }
        } else {
          virtPath = fp
        }

        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes(pattern)) continue
          if (!results[virtPath!]) results[virtPath!] = []
          results[virtPath!].push([i + 1, lines[i]])
        }
      } catch {
        continue
      }
    }
    return results
  }

  private static readonly SHELL_BLACKLIST = new Set(["fish", "nu"])

  /**
   * Resolve the best shell for command execution.
   * All platforms: check $SHELL first (skip non-POSIX shells like fish/nu).
   * Windows fallback: GIT_BASH_PATH env > detect git install > COMSPEC (cmd.exe)
   * macOS fallback: /bin/zsh
   * Linux fallback: /bin/sh
   */
  /** Public accessor for the resolved shell path (used by system prompt). */
  static resolvedShell(): string {
    return LocalSandbox.resolveShell()
  }

  private static resolveShell(): string {
    const isWindows = process.platform === "win32"
    const userShell = process.env.SHELL
    if (userShell) {
      const basename = isWindows
        ? path.win32.basename(userShell)
        : path.basename(userShell)
      if (!LocalSandbox.SHELL_BLACKLIST.has(basename)) return userShell
    }

    if (isWindows) {
      const envBash = process.env.GIT_BASH_PATH
      if (envBash) return envBash

      // Derive bash.exe from git.exe install location:
      // git.exe is typically at C:\Program Files\Git\cmd\git.exe
      // bash.exe is at C:\Program Files\Git\bin\bash.exe
      const gitExe = LocalSandbox.whichSync("git")
      if (gitExe) {
        const bash = path.join(gitExe, "..", "..", "bin", "bash.exe")
        try {
          if (existsSync(bash)) return bash
        } catch { /* ignore */ }
      }

      // Fallback: check common install paths
      for (const base of [
        process.env["ProgramFiles"],
        process.env["ProgramFiles(x86)"],
        "C:\\Program Files"
      ]) {
        if (!base) continue
        const bash = path.join(base, "Git", "bin", "bash.exe")
        try {
          if (existsSync(bash)) return bash
        } catch { /* ignore */ }
      }

      return process.env.COMSPEC || "cmd.exe"
    }

    if (process.platform === "darwin") return "/bin/zsh"
    return "/bin/sh"
  }

  /** Synchronous `which` — locate an executable on PATH. */
  private static whichSync(name: string): string | null {
    const isWindows = process.platform === "win32"
    const pathEnv = process.env.PATH || ""
    const sep = isWindows ? ";" : ":"
    const extensions = isWindows ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""]
    for (const dir of pathEnv.split(sep)) {
      if (!dir) continue
      for (const ext of extensions) {
        const full = path.join(dir, name + ext)
        try {
          if (existsSync(full)) return full
        } catch { /* ignore */ }
      }
    }
    return null
  }

  /** Track all active child processes for cleanup on app quit. */
  private static readonly activeProcesses = new Set<ChildProcess>()

  /** Kill all active child processes. Call from app 'will-quit' hook. */
  static killAll(): void {
    for (const proc of LocalSandbox.activeProcesses) {
      void LocalSandbox.killTree(proc, () => false)
    }
    LocalSandbox.activeProcesses.clear()
  }

  private static readonly SIGKILL_TIMEOUT_MS = 200

  /**
   * Kill a process tree in a platform-aware manner.
   * Windows: taskkill /T /F (tree kill), awaits completion.
   * Unix: SIGTERM the process group, escalate to SIGKILL after 200ms.
   */
  private static async killTree(proc: ChildProcess, exited: () => boolean): Promise<void> {
    const pid = proc.pid
    if (!pid || exited()) return

    if (process.platform === "win32") {
      await new Promise<void>((res) => {
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" })
        killer.once("exit", () => res())
        killer.once("error", () => res())
      })
      return
    }

    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      try { proc.kill("SIGTERM") } catch { /* already exited */ }
    }
    await new Promise<void>((res) => setTimeout(res, LocalSandbox.SIGKILL_TIMEOUT_MS))
    if (!exited()) {
      try { process.kill(-pid, "SIGKILL") } catch {
        try { proc.kill("SIGKILL") } catch { /* already exited */ }
      }
    }
  }

  /**
   * Execute a shell command in the workspace directory.
   *
   * Key design decisions (aligned with OpenCode's bash tool):
   * - Uses spawn(command, { shell }) pattern — Node.js handles platform-specific
   *   shell invocation, so pipes, redirects, and chaining just work.
   * - Smart shell selection: Git Bash on Windows (if available) > cmd.exe,
   *   user's $SHELL on Unix > platform fallback.
   * - detached process group on Unix for clean tree kill via negative PID.
   * - Platform-aware kill tree: taskkill /T on Windows, process group signals on Unix.
   * - Windows encoding auto-detection (GBK/CP936) to prevent garbled Chinese text.
   * - Windows exit-event grace period to handle .bat child process pipe handle leaks.
   */
  async execute(command: string): Promise<ExecuteResponse> {
    if (!command || typeof command !== "string") {
      return {
        output: "Error: Shell tool expects a non-empty command string.",
        exitCode: 1,
        truncated: false
      }
    }

    const isWindows = process.platform === "win32"
    const shell = LocalSandbox.resolveShell()

    return new Promise<ExecuteResponse>((resolve) => {
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let totalBytes = 0
      let byteCapReached = false
      let resolved = false
      let exited = false

      const proc = spawn(command, {
        shell,
        cwd: this.workingDir,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWindows
      })

      LocalSandbox.activeProcesses.add(proc)

      let windowsExitTimerId: ReturnType<typeof setTimeout> | null = null

      // Intentionally fire-and-forget: timeout/error already resolved,
      // kill is best-effort cleanup (same pattern as OpenCode's abort handler).
      const killProc = (): void => {
        void LocalSandbox.killTree(proc, () => exited)
      }

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          LocalSandbox.activeProcesses.delete(proc)
          if (windowsExitTimerId) clearTimeout(windowsExitTimerId)
          killProc()
          resolve({
            output: `Error: Command timed out after ${(this.timeout / 1000).toFixed(1)} seconds.`,
            exitCode: null,
            truncated: false
          })
        }
      }, this.timeout)

      proc.stdout.on("data", (chunk: Buffer) => {
        if (byteCapReached) return
        stdoutChunks.push(chunk)
        totalBytes += chunk.length
        if (totalBytes >= this.maxOutputBytes) byteCapReached = true
      })

      proc.stderr.on("data", (chunk: Buffer) => {
        if (byteCapReached) return
        stderrChunks.push(chunk)
        totalBytes += chunk.length
        if (totalBytes >= this.maxOutputBytes) byteCapReached = true
      })

      const collectAndResolve = (code: number | null, signal: string | null): void => {
        if (resolved) return
        resolved = true
        exited = true
        LocalSandbox.activeProcesses.delete(proc)
        clearTimeout(timeoutId)
        if (windowsExitTimerId) clearTimeout(windowsExitTimerId)

        const stdoutBuf = Buffer.concat(stdoutChunks)
        const stderrBuf = Buffer.concat(stderrChunks)

        const enc = isWindows
          ? this.detectCmdEncoding(stdoutBuf.length > 0 ? stdoutBuf : stderrBuf)
          : "utf-8"

        let output = ""
        if (stdoutBuf.length > 0) {
          output += iconv.decode(stdoutBuf, enc)
        }
        if (stderrBuf.length > 0) {
          const stderrText = iconv.decode(stderrBuf, enc)
          const prefixed = stderrText
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => `[stderr] ${line}`)
            .join("\n")
          if (prefixed) {
            output += (output ? "\n" : "") + prefixed + (stderrText.endsWith("\n") ? "\n" : "")
          }
        }

        let truncated = false
        if (output.length > this.maxOutputBytes) {
          output = output.slice(0, this.maxOutputBytes)
          output += `\n\n... Output truncated at ${this.maxOutputBytes} bytes.`
          truncated = true
        }
        if (!output.trim()) {
          output = "<no output>"
        }

        resolve({ output, exitCode: signal ? null : code, truncated })
      }

      // On Windows, .bat files may spawn child processes that inherit pipe handles.
      // The 'close' event waits for all handles to close (including orphaned children),
      // which can block indefinitely. Listen for 'exit' and resolve after a grace period.
      if (isWindows) {
        proc.on("exit", (code, signal) => {
          exited = true
          windowsExitTimerId = setTimeout(() => {
            collectAndResolve(code, signal as string | null)
          }, 500)
        })
      }

      proc.on("close", (code, signal) => {
        exited = true
        collectAndResolve(code, signal as string | null)
      })

      proc.on("error", (err) => {
        if (resolved) return
        resolved = true
        exited = true
        LocalSandbox.activeProcesses.delete(proc)
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
