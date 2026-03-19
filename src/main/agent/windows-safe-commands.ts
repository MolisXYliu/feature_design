import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

export type WindowsShellKind = "powershell" | "cmd" | "bash" | "unknown"

const POWERSHELL_PARSER_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'

$payload = $env:CODEX_POWERSHELL_PAYLOAD
if ([string]::IsNullOrEmpty($payload)) {
    Write-Output '{"status":"parse_failed"}'
    exit 0
}

try {
    $source =
        [System.Text.Encoding]::Unicode.GetString(
            [System.Convert]::FromBase64String($payload)
        )
} catch {
    Write-Output '{"status":"parse_failed"}'
    exit 0
}

$tokens = $null
$errors = $null

$ast = $null
try {
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        $source,
        [ref]$tokens,
        [ref]$errors
    )
} catch {
    Write-Output '{"status":"parse_failed"}'
    exit 0
}

if ($errors.Count -gt 0) {
    Write-Output '{"status":"parse_errors"}'
    exit 0
}

function Convert-CommandElement {
    param($element)

    if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return @($element.Value)
    }

    if ($element -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
        if ($element.NestedExpressions.Count -gt 0) {
            return $null
        }
        return @($element.Value)
    }

    if ($element -is [System.Management.Automation.Language.ConstantExpressionAst]) {
        return @($element.Value.ToString())
    }

    if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {
        if ($element.Argument -eq $null) {
            return @('-' + $element.ParameterName)
        }

        if ($element.Argument -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            return @('-' + $element.ParameterName, $element.Argument.Value)
        }

        if ($element.Argument -is [System.Management.Automation.Language.ConstantExpressionAst]) {
            return @('-' + $element.ParameterName, $element.Argument.Value.ToString())
        }

        return $null
    }

    return $null
}

function Convert-PipelineElement {
    param($element)

    if ($element -is [System.Management.Automation.Language.CommandAst]) {
        if ($element.Redirections.Count -gt 0) {
            return $null
        }

        if (
            $element.InvocationOperator -ne $null -and
            $element.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown
        ) {
            return $null
        }

        $parts = @()
        foreach ($commandElement in $element.CommandElements) {
            $converted = Convert-CommandElement $commandElement
            if ($converted -eq $null) {
                return $null
            }
            $parts += $converted
        }
        return $parts
    }

    if ($element -is [System.Management.Automation.Language.CommandExpressionAst]) {
        if ($element.Redirections.Count -gt 0) {
            return $null
        }

        if ($element.Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
            $innerPipeline = $element.Expression.Pipeline
            if ($innerPipeline -and $innerPipeline.PipelineElements.Count -eq 1) {
                return Convert-PipelineElement $innerPipeline.PipelineElements[0]
            }
        }

        return $null
    }

    return $null
}

function Add-CommandsFromPipelineAst {
    param($pipeline, $commands)

    if ($pipeline.PipelineElements.Count -eq 0) {
        return $false
    }

    foreach ($element in $pipeline.PipelineElements) {
        $words = Convert-PipelineElement $element
        if ($words -eq $null -or $words.Count -eq 0) {
            return $false
        }
        $null = $commands.Add($words)
    }

    return $true
}

function Add-CommandsFromPipelineChain {
    param($chain, $commands)

    if (-not (Add-CommandsFromPipelineBase $chain.LhsPipelineChain $commands)) {
        return $false
    }

    if (-not (Add-CommandsFromPipelineAst $chain.RhsPipeline $commands)) {
        return $false
    }

    return $true
}

function Add-CommandsFromPipelineBase {
    param($pipeline, $commands)

    if ($pipeline -is [System.Management.Automation.Language.PipelineAst]) {
        return Add-CommandsFromPipelineAst $pipeline $commands
    }

    if ($pipeline -is [System.Management.Automation.Language.PipelineChainAst]) {
        return Add-CommandsFromPipelineChain $pipeline $commands
    }

    return $false
}

$commands = [System.Collections.ArrayList]::new()

foreach ($statement in $ast.EndBlock.Statements) {
    if (-not (Add-CommandsFromPipelineBase $statement $commands)) {
        $commands = $null
        break
    }
}

if ($commands -ne $null) {
    $normalized = [System.Collections.ArrayList]::new()
    foreach ($cmd in $commands) {
        if ($cmd -is [string]) {
            $null = $normalized.Add(@($cmd))
            continue
        }

        if ($cmd -is [System.Array] -or $cmd -is [System.Collections.IEnumerable]) {
            $null = $normalized.Add(@($cmd))
            continue
        }

        $normalized = $null
        break
    }

    $commands = $normalized
}

$result = if ($commands -eq $null) {
    @{ status = 'unsupported' }
} else {
    @{ status = 'ok'; commands = $commands }
}

,$result | ConvertTo-Json -Depth 3
`

const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "show", "diff", "cat-file", "branch"])
const SAFE_POWERSHELL_COMMANDS = new Set([
  "echo", "write-output", "write-host",
  "dir", "ls", "get-childitem", "gci",
  "cat", "type", "gc", "get-content",
  "select-string", "sls", "findstr",
  "measure-object", "measure",
  "get-location", "gl", "pwd",
  "test-path", "tp",
  "resolve-path", "rvpa",
  "select-object", "select",
  "get-item"
])
const SIDE_EFFECTING_POWERSHELL_CMDLETS = new Set([
  "set-content", "add-content", "out-file", "new-item", "remove-item", "move-item",
  "copy-item", "rename-item", "start-process", "stop-process"
])
const UNSAFE_RIPGREP_FLAGS = new Set(["--search-zip", "-z"])
const UNSAFE_RIPGREP_FLAGS_WITH_VALUES = ["--pre", "--hostname-bin"]
const UNSAFE_GIT_FLAGS = new Set(["--output", "--ext-diff", "--textconv", "--exec", "--paginate"])
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c", "--config-env", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree"
])

let cachedParserScriptBase64: string | null = null
let cachedPowerShellExecutable: string | null | undefined

export function isKnownSafeWindowsCommand(command: string, shellKind: WindowsShellKind): boolean {
  if (process.platform !== "win32") return false

  const trimmed = command.trim()
  if (!trimmed) return false

  if (shellKind === "powershell") {
    const systemPowerShell = findPowerShellExecutable()
    if (systemPowerShell) {
      const commands = parsePowerShellScript(systemPowerShell, trimmed)
      if (commands && commands.every((cmd) => isSafePowerShellCommand(cmd))) {
        return true
      }
    }
  }

  const tokens = tokenizeCommand(trimmed)
  if (!tokens || tokens.length === 0) return false

  const commands = tryParsePowerShellCommandSequence(tokens)
  if (!commands) return false

  return commands.every((cmd) => isSafePowerShellCommand(cmd))
}

function tryParsePowerShellCommandSequence(command: string[]): string[][] | null {
  const [exe, ...rest] = command
  if (!isPowerShellExecutable(exe)) return null
  return parsePowerShellInvocation(exe, rest)
}

function parsePowerShellInvocation(executable: string, args: string[]): string[][] | null {
  if (args.length === 0) return null

  let index = 0
  while (index < args.length) {
    const arg = args[index]
    const lower = arg.toLowerCase()

    switch (true) {
      case lower === "-command":
      case lower === "/command":
      case lower === "-c": {
        const script = args[index + 1]
        if (!script || index + 2 !== args.length) return null
        return parsePowerShellScript(executable, script)
      }
      case lower.startsWith("-command:"):
      case lower.startsWith("/command:"): {
        if (index + 1 !== args.length) return null
        const script = arg.split(/:(.*)/s)[1]
        return script ? parsePowerShellScript(executable, script) : null
      }
      case lower === "-nologo":
      case lower === "-noprofile":
      case lower === "-noninteractive":
      case lower === "-mta":
      case lower === "-sta":
        index += 1
        continue
      case lower === "-encodedcommand":
      case lower === "-ec":
      case lower === "-file":
      case lower === "/file":
      case lower === "-windowstyle":
      case lower === "-executionpolicy":
      case lower === "-workingdirectory":
        return null
      default:
        if (lower.startsWith("-")) return null
        return parsePowerShellScript(executable, joinArgumentsAsScript(args.slice(index)))
    }
  }

  return null
}

function parsePowerShellScript(executable: string, script: string): string[][] | null {
  const parserExecutable = isPowerShellExecutable(executable) ? executable : findPowerShellExecutable()
  if (!parserExecutable) return parsePowerShellScriptConservatively(script)

  const encodedParserScript = getEncodedParserScript()
  const encodedPayload = encodePowerShellBase64(script)
  const output = spawnSync(
    parserExecutable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedParserScript],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, CODEX_POWERSHELL_PAYLOAD: encodedPayload }
    }
  )

  if (output.error || output.status !== 0 || !output.stdout) {
    return parsePowerShellScriptConservatively(script)
  }

  try {
    const parsed = JSON.parse(output.stdout.trim()) as {
      status?: string
      commands?: unknown
    }
    if (parsed.status !== "ok" || !Array.isArray(parsed.commands) || parsed.commands.length === 0) {
      return parsePowerShellScriptConservatively(script)
    }

    const commands: string[][] = []
    for (const command of parsed.commands) {
      if (!Array.isArray(command) || command.length === 0 || command.some((word) => typeof word !== "string" || !word)) {
        return parsePowerShellScriptConservatively(script)
      }
      commands.push(command as string[])
    }
    return commands
  } catch {
    return parsePowerShellScriptConservatively(script)
  }
}

function isSafePowerShellCommand(words: string[]): boolean {
  if (words.length === 0) return false

  for (const word of words) {
    const inner = word
      .trim()
      .replace(/^[()]+|[()]+$/g, "")
      .replace(/^-+/, "")
      .toLowerCase()
    if (SIDE_EFFECTING_POWERSHELL_CMDLETS.has(inner)) {
      return false
    }
  }

  const command = words[0]
    .trim()
    .replace(/^[()]+|[()]+$/g, "")
    .replace(/^-+/, "")
    .toLowerCase()

  if (SAFE_POWERSHELL_COMMANDS.has(command)) {
    return true
  }

  switch (command) {
    case "git":
      return isSafeGitCommand(words)
    case "rg":
      return isSafeRipgrep(words)
    default:
      return false
  }
}

function isSafeRipgrep(words: string[]): boolean {
  return !words.slice(1).some((arg) => {
    const lower = arg.toLowerCase()
    return (
      UNSAFE_RIPGREP_FLAGS.has(lower) ||
      UNSAFE_RIPGREP_FLAGS_WITH_VALUES.some((flag) => lower === flag || lower.startsWith(flag + "="))
    )
  })
}

function isSafeGitCommand(words: string[]): boolean {
  if (hasGitConfigOverride(words)) return false

  const subcommandInfo = findGitSubcommand(words)
  if (!subcommandInfo || !SAFE_GIT_SUBCOMMANDS.has(subcommandInfo.subcommand)) {
    return false
  }

  const args = words.slice(subcommandInfo.index + 1)
  if (!gitArgsAreReadOnly(args)) return false

  if (subcommandInfo.subcommand === "branch") {
    return gitBranchIsReadOnly(args)
  }

  return true
}

function hasGitConfigOverride(words: string[]): boolean {
  return words.some((arg) => {
    const lower = arg.toLowerCase()
    return lower === "-c" || lower === "--config-env" || lower.startsWith("-c") || lower.startsWith("--config-env=")
  })
}

function findGitSubcommand(words: string[]): { index: number; subcommand: string } | null {
  let skipNext = false

  for (let index = 1; index < words.length; index++) {
    const word = words[index]
    const lower = word.toLowerCase()

    if (skipNext) {
      skipNext = false
      continue
    }

    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(lower)) {
      skipNext = true
      continue
    }

    if (
      lower.startsWith("--config-env=") ||
      lower.startsWith("--exec-path=") ||
      lower.startsWith("--git-dir=") ||
      lower.startsWith("--namespace=") ||
      lower.startsWith("--super-prefix=") ||
      lower.startsWith("--work-tree=") ||
      (lower.startsWith("-c") && lower.length > 2)
    ) {
      continue
    }

    if (word === "--" || word.startsWith("-")) continue

    return { index, subcommand: lower }
  }

  return null
}

function gitArgsAreReadOnly(args: string[]): boolean {
  return !args.some((arg) => {
    const lower = arg.toLowerCase()
    return UNSAFE_GIT_FLAGS.has(lower) || lower.startsWith("--output=") || lower.startsWith("--exec=")
  })
}

function gitBranchIsReadOnly(args: string[]): boolean {
  if (args.length === 0) return true

  let sawReadOnlyFlag = false
  for (const arg of args) {
    const lower = arg.toLowerCase()
    switch (lower) {
      case "--list":
      case "-l":
      case "--show-current":
      case "-a":
      case "--all":
      case "-r":
      case "--remotes":
      case "-v":
      case "-vv":
      case "--verbose":
        sawReadOnlyFlag = true
        break
      default:
        if (lower.startsWith("--format=")) {
          sawReadOnlyFlag = true
          break
        }
        return false
    }
  }

  return sawReadOnlyFlag
}

function isPowerShellExecutable(executable: string): boolean {
  const executableName = path.basename(executable).toLowerCase()
  return ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executableName)
}

function findPowerShellExecutable(): string | null {
  if (cachedPowerShellExecutable !== undefined) {
    return cachedPowerShellExecutable
  }

  for (const executable of ["pwsh", "powershell"]) {
    const resolved = whichSync(executable)
    if (resolved) {
      cachedPowerShellExecutable = resolved
      return resolved
    }
  }

  cachedPowerShellExecutable = null
  return null
}

function whichSync(name: string): string | null {
  const pathEnv = process.env.PATH || ""
  const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")

  for (const dir of pathEnv.split(";")) {
    if (!dir) continue
    for (const ext of ["", ...pathExt]) {
      const candidate = path.join(dir, ext ? `${name}${ext}` : name)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }

  return null
}

function getEncodedParserScript(): string {
  if (!cachedParserScriptBase64) {
    cachedParserScriptBase64 = encodePowerShellBase64(POWERSHELL_PARSER_SCRIPT)
  }
  return cachedParserScriptBase64
}

function encodePowerShellBase64(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64")
}

function joinArgumentsAsScript(args: string[]): string {
  return args.map((arg, index) => {
    if (index === 0) return arg
    return quoteArgument(arg)
  }).join(" ")
}

function quoteArgument(arg: string): string {
  if (!arg) return "''"
  if ([...arg].every((char) => !/\s/.test(char))) return arg
  return `'${arg.replace(/'/g, "''")}'`
}

function parsePowerShellScriptConservatively(script: string): string[][] | null {
  if (!script.trim()) return null
  if (script.includes("$(") || script.includes("${") || script.includes("@(") || script.includes("`")) {
    return null
  }

  const segments = splitPowerShellScript(script)
  if (!segments || segments.length === 0) return null

  const commands: string[][] = []
  for (const segment of segments) {
    const normalizedSegment = unwrapOuterParens(segment.trim())
    if (!normalizedSegment) return null

    const tokens = tokenizeCommand(normalizedSegment)
    if (!tokens || tokens.length === 0) return null
    if (tokens.some((token) => token.includes("$") || token.includes("`") || token.includes("@(") || token.includes("$("))) {
      return null
    }

    commands.push(tokens)
  }

  return commands
}

function splitPowerShellScript(script: string): string[] | null {
  const segments: string[] = []
  let current = ""
  let quote: "'" | "\"" | null = null
  let depth = 0

  for (let index = 0; index < script.length; index++) {
    const char = script[index]
    const next = script[index + 1] ?? ""

    if (quote) {
      current += char
      if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "'" || char === "\"") {
      quote = char
      current += char
      continue
    }

    if (char === "(") {
      depth += 1
      current += char
      continue
    }

    if (char === ")") {
      depth -= 1
      if (depth < 0) return null
      current += char
      continue
    }

    if (depth === 0) {
      if (char === ">" || char === "<") return null
      if (char === "&" && next !== "&") return null

      const doubleOperator = char + next
      if (doubleOperator === "&&" || doubleOperator === "||") {
        if (!pushPowerShellSegment(segments, current)) return null
        current = ""
        index += 1
        continue
      }

      if (char === "|" || char === ";") {
        if (!pushPowerShellSegment(segments, current)) return null
        current = ""
        continue
      }
    }

    current += char
  }

  if (quote || depth !== 0) return null
  if (!pushPowerShellSegment(segments, current)) return null
  return segments
}

function pushPowerShellSegment(segments: string[], segment: string): boolean {
  const trimmed = segment.trim()
  if (!trimmed) return false
  segments.push(trimmed)
  return true
}

function unwrapOuterParens(segment: string): string | null {
  let current = segment.trim()
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0
    let wrapsWholeSegment = true
    let quote: "'" | "\"" | null = null

    for (let index = 0; index < current.length; index++) {
      const char = current[index]
      if (quote) {
        if (char === quote) quote = null
        continue
      }

      if (char === "'" || char === "\"") {
        quote = char
        continue
      }

      if (char === "(") depth += 1
      if (char === ")") depth -= 1

      if (depth === 0 && index < current.length - 1) {
        wrapsWholeSegment = false
        break
      }
    }

    if (!wrapsWholeSegment || depth !== 0 || quote) {
      break
    }

    current = current.slice(1, -1).trim()
  }

  return current || null
}

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | "\"" | null = null
  let escaped = false

  for (let index = 0; index < command.length; index++) {
    const char = command[index]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === "'" || char === "\"") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (escaped || quote) return null
  if (current) tokens.push(current)
  return tokens
}
