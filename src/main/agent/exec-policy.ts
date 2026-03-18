/**
 * Command safety policy engine.
 *
 * Classifies shell commands into safe / needs_approval / forbidden categories
 * based on pattern matching. Modelled after codex-rs is_known_safe_command()
 * and command_might_be_dangerous().
 */

import type { ExecSafetyLevel } from "../types"

export interface SafetyAssessment {
  level: ExecSafetyLevel
  reason?: string
}

// ── Safe command patterns ────────────────────────────────────────────────────
// These commands are read-only or produce no destructive side effects.

const SAFE_PREFIXES: string[] = [
  // filesystem read
  "ls", "dir", "cat", "head", "tail", "wc", "file", "stat",
  "tree", "find", "which", "where", "type",
  // text processing (read-only)
  "grep", "rg", "awk", "sed -n", "sort", "uniq", "cut", "tr",
  "diff", "comm",
  // info
  "echo", "printf", "pwd", "cd", "date", "whoami", "hostname",
  "uname", "env", "printenv", "id",
  // git read
  "git status", "git log", "git diff", "git branch", "git show",
  "git remote", "git tag", "git rev-parse", "git ls-files",
  "git blame", "git shortlog", "git stash list",
  // package info
  "npm list", "npm ls", "npm view", "npm info", "npm outdated",
  "pip list", "pip show", "pip freeze",
  "cargo --version", "rustc --version",
  // build read
  "make -n", "make --dry-run",
  // PowerShell read-only
  "get-childitem", "get-content", "get-item", "get-location",
  "get-process", "get-service", "get-date", "get-host",
  "test-path", "resolve-path", "select-string"
]

// ── Forbidden patterns ───────────────────────────────────────────────────────
// These are extremely dangerous and should never be auto-approved.

interface ForbiddenPattern {
  pattern: RegExp
  reason: string
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  // Unix
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/, reason: "rm -rf / is extremely dangerous" },
  { pattern: /\bmkfs\b/, reason: "mkfs formats disk partitions" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "dd to device can destroy data" },
  { pattern: /\bformat\s+[a-zA-Z]:/, reason: "format erases disk" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "system power control" },
  { pattern: /\bdel\s+\/s\s+\/q\s+[a-zA-Z]:\\/, reason: "recursive delete on drive root" },
  { pattern: /\brmdir\s+\/s\s+\/q\s+[a-zA-Z]:\\/, reason: "recursive rmdir on drive root" },
  { pattern: /\bcurl\s+.*\|\s*(ba)?sh\b/, reason: "piping remote script to shell" },
  { pattern: /\bwget\s+.*\|\s*(ba)?sh\b/, reason: "piping remote script to shell" },
  { pattern: /\b:(){ :\|:& };:/, reason: "fork bomb" },
  // PowerShell — drive root destruction
  { pattern: /\bRemove-Item\s+.*-Recurse\b.*[a-zA-Z]:\\\*?/i, reason: "PowerShell recursive delete on drive root" },
  { pattern: /\bRemove-Item\s+.*[a-zA-Z]:\\\*?.*-Recurse\b/i, reason: "PowerShell recursive delete on drive root" },
  { pattern: /\bri\s+.*-Recurse\b.*[a-zA-Z]:\\\*?/i, reason: "PowerShell recursive delete on drive root (alias)" },
  { pattern: /\bdel\s+.*-Recurse\b.*[a-zA-Z]:\\\*?/i, reason: "PowerShell recursive delete on drive root (alias)" },
  // PowerShell — disk format
  { pattern: /\bFormat-Volume\b/i, reason: "PowerShell formats disk volume" },
  { pattern: /\bClear-Disk\b/i, reason: "PowerShell clears disk" },
  // PowerShell — remote script execution
  { pattern: /\bInvoke-Expression\b.*\bInvoke-WebRequest\b/i, reason: "PowerShell downloads and executes remote script" },
  { pattern: /\biex\b.*\biwr\b/i, reason: "PowerShell downloads and executes remote script (alias)" },
  { pattern: /\bInvoke-Expression\b.*\bInvoke-RestMethod\b/i, reason: "PowerShell downloads and executes remote script" },
  { pattern: /\biex\b.*\birm\b/i, reason: "PowerShell downloads and executes remote script (alias)" },
  // PowerShell — system control
  { pattern: /\bStop-Computer\b/i, reason: "PowerShell shuts down computer" },
  { pattern: /\bRestart-Computer\b/i, reason: "PowerShell restarts computer" }
]

// ── Dangerous indicators ─────────────────────────────────────────────────────
// These patterns are not outright forbidden but warrant user review.

interface DangerousIndicator {
  pattern: RegExp
  reason: string
}

const DANGEROUS_INDICATORS: DangerousIndicator[] = [
  // Unix
  { pattern: /\brm\s+-[a-zA-Z]*r/, reason: "recursive file deletion" },
  { pattern: /\brm\s+-[a-zA-Z]*f/, reason: "forced file deletion" },
  { pattern: /\bgit\s+push\s+--force/, reason: "force push can rewrite history" },
  { pattern: /\bgit\s+push\s+-f\b/, reason: "force push can rewrite history" },
  { pattern: /\bgit\s+reset\s+--hard/, reason: "hard reset discards uncommitted changes" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: "git clean removes untracked files" },
  { pattern: /\bnpm\s+publish\b/, reason: "publishes package to registry" },
  { pattern: /\bcurl\s+.*-X\s*(DELETE|PUT|POST)/, reason: "mutating HTTP request" },
  { pattern: /\bchmod\s+777\b/, reason: "overly permissive file permissions" },
  { pattern: /\bchown\b/, reason: "changes file ownership" },
  { pattern: /\bnet\s+user\b/, reason: "Windows user management" },
  { pattern: /\breg\s+(add|delete)\b/i, reason: "Windows registry modification" },
  { pattern: /\bicacls\b.*\/grant/, reason: "modifies file ACLs" },
  { pattern: /\btakeown\b/, reason: "takes ownership of files" },
  { pattern: /\bsudo\b/, reason: "elevated privilege execution" },
  { pattern: /\bkill\s+-9\b/, reason: "force-kills a process" },
  { pattern: /\bdocker\s+rm\b/, reason: "removes Docker container" },
  { pattern: /\bdocker\s+rmi\b/, reason: "removes Docker image" },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: "writes directly to block device" },
  { pattern: /\bdrop\s+(table|database)\b/i, reason: "SQL destructive operation" },
  // PowerShell — destructive
  { pattern: /\bRemove-Item\b.*-Recurse\b/i, reason: "PowerShell recursive deletion" },
  { pattern: /\bRemove-Item\b.*-Force\b/i, reason: "PowerShell forced deletion" },
  { pattern: /\bri\s+.*-Recurse\b/i, reason: "PowerShell recursive deletion (alias)" },
  { pattern: /\bStop-Process\b.*-Force\b/i, reason: "PowerShell force-kills process" },
  { pattern: /\bSet-ExecutionPolicy\b/i, reason: "changes PowerShell script execution policy" },
  // PowerShell — user/ACL management
  { pattern: /\bNew-LocalUser\b/i, reason: "PowerShell creates local user" },
  { pattern: /\bRemove-LocalUser\b/i, reason: "PowerShell removes local user" },
  { pattern: /\bSet-Acl\b/i, reason: "PowerShell modifies file ACLs" },
  // PowerShell — network/remote
  { pattern: /\bInvoke-WebRequest\b.*-Method\s+(Post|Put|Delete)\b/i, reason: "PowerShell mutating HTTP request" },
  { pattern: /\bInvoke-RestMethod\b.*-Method\s+(Post|Put|Delete)\b/i, reason: "PowerShell mutating HTTP request" },
  { pattern: /\bInvoke-Expression\b/i, reason: "PowerShell dynamic code execution" },
  { pattern: /\biex\b/i, reason: "PowerShell dynamic code execution (alias)" },
  // Script execution — can contain arbitrary dangerous code
  { pattern: /\bnode\s+-e\b/, reason: "Node.js inline code execution" },
  { pattern: /\bnode\s+--eval\b/, reason: "Node.js inline code execution" },
  { pattern: /\bpython[3]?\s+-c\b/, reason: "Python inline code execution" }
]

/**
 * Assess whether a command is safe, needs approval, or is forbidden.
 *
 * Order of checks:
 *   1. Forbidden patterns (full string) — always checked first
 *   2. Dangerous indicators (full string) — checked before safe to prevent
 *      chained-command bypass (e.g. "echo ok && git push --force")
 *   3. Safe prefix — only if no chaining operators (&&, ||, ;) are present,
 *      to prevent "safe-prefix && dangerous-command" bypass
 *   4. Default: needs_approval
 */
export function assessCommandSafety(command: string, _cwd: string): SafetyAssessment {
  const trimmed = command.trim()
  if (!trimmed) {
    return { level: "safe" }
  }

  // 1. Check forbidden patterns first
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { level: "forbidden", reason }
    }
  }

  // 2. Check for dangerous indicators BEFORE safe prefix
  //    (prevents "safe-prefix && dangerous-command" bypass)
  for (const { pattern, reason } of DANGEROUS_INDICATORS) {
    if (pattern.test(trimmed)) {
      return { level: "needs_approval", reason }
    }
  }

  // 3. Check if command matches a known-safe prefix
  //    Skip if command contains chaining/piping/substitution operators —
  //    "echo ok | npm install", "ls & rm -rf /", "echo `dangerous`" etc.
  //    must not be auto-approved based on the first command alone.
  const hasChaining = /&&|\|\||[|;&\n`]|\$\(/.test(trimmed)
  if (!hasChaining) {
    const normalized = trimmed.toLowerCase()
    for (const prefix of SAFE_PREFIXES) {
      // Match "ls", "ls -la", etc. but not "lsblk"
      if (normalized === prefix || normalized.startsWith(prefix + " ") || normalized.startsWith(prefix + "\t")) {
        return { level: "safe" }
      }
    }
  }

  // 4. Default: needs approval (unknown commands are not auto-approved)
  return { level: "needs_approval", reason: hasChaining ? "chained command — requires review" : "unknown command — requires review" }
}
