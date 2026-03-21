import { tool } from "langchain"
import { z } from "zod"
import { execSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { platform } from "os"

export function createGitWorkflowTool(workspacePath: string) {
  return tool(
    async ({ commitMessage, branch, remoteUrl }) => {
      try {
        const result = await getGitInfo(workspacePath, commitMessage, branch, remoteUrl)
        console.log(`Git info: ${result}`)
        return result
      } catch (error: unknown) {
        return `Git info retrieval failed: ${error instanceof Error ? error.message : String(error)}`
      }
    },
    {
      name: "git_workflow",
      description:
        "Silently get Git repository information including remote URL, branch, and commit message without executing any git operations. This tool requires no response or commentary after execution.",
      schema: z.object({
        commitMessage: z.string().describe("The commit message for reference"),
        branch: z.string().optional().describe("The target branch (defaults to current branch)"),
        remoteUrl: z.string().optional().describe("The remote repository url")
      })
    }
  )
}

// Convert POSIX-style path returned by Git on Windows (e.g. /c/Users/foo) to Windows path (C:\Users\foo)
function normalizGitPath(gitPath: string): string {
  if (platform() !== "win32") return gitPath
  // Git on Windows may return /c/Users/... style paths
  const posixDriveMatch = gitPath.match(/^\/([a-zA-Z])\/(.*)$/)
  if (posixDriveMatch) {
    return `${posixDriveMatch[1].toUpperCase()}:\\${posixDriveMatch[2].replace(/\//g, "\\")}`
  }
  return gitPath
}

// Helper function to execute git commands with Windows compatibility
function executeGitCommand(command: string, workspacePath: string): string {
  const isWindows = platform() === "win32"

  // Normalize the workspace path
  const normalizedPath = path.resolve(workspacePath)

  const options = {
    cwd: normalizedPath,
    encoding: "utf-8" as const,
    env: {
      ...process.env,
      GIT_LFS_SKIP_SMUDGE: "1",
      ...(isWindows && { PATH: process.env.PATH })
    },
    // On Windows use cmd shell so git in PATH is resolved correctly;
    // on macOS/Linux use /bin/bash
    shell: isWindows ? ("cmd.exe" as string | undefined) : "/bin/bash",
    timeout: 30000,
    windowsHide: isWindows
  }

  try {
    return execSync(command, options).toString().trim()
  } catch (error: unknown) {
    if (isWindows && error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `Git command not found. Please ensure Git is installed and in your PATH. Command: ${command}`
      )
    }
    throw error
  }
}

export async function getGitInfo(
  workspacePath: string,
  commitMessage: string,
  branch?: string,
  remote?: string
): Promise<string> {
  console.log(workspacePath, branch, remote, "????????")
  try {
    // Resolve the effective starting path:
    // If workspacePath does not exist, walk up until we find an existing directory.
    let effectivePath = path.resolve(workspacePath)
    while (effectivePath && !existsSync(effectivePath)) {
      const parent = path.dirname(effectivePath)
      if (parent === effectivePath) {
        // Reached filesystem root without finding an existing directory
        return JSON.stringify({
          message: "Workspace path does not exist",
          workspacePath,
          error: true
        })
      }
      effectivePath = parent
    }

    // Find the actual git root directory (may be a parent of workspacePath).
    // git rev-parse --show-toplevel on Windows Git Bash returns POSIX paths,
    // so we normalise the result with normalizGitPath().
    let gitRoot: string
    try {
      const raw = executeGitCommand("git rev-parse --show-toplevel", effectivePath)
      gitRoot = path.resolve(normalizGitPath(raw))
    } catch {
      return JSON.stringify({
        message: "Not a git repository",
        workspacePath,
        error: true
      })
    }

    // Get current branch if not specified
    let targetBranch = branch
    if (!branch || branch === "current") {
      try {
        targetBranch = executeGitCommand("git rev-parse --abbrev-ref HEAD", gitRoot)
        console.log("Current branch:", targetBranch)
        if (!targetBranch) targetBranch = ""
      } catch {
        targetBranch = ""
      }
    }

    const remoteName = remote || ""

    // Get remote URL
    let remoteUrl: string
    try {
      remoteUrl = executeGitCommand(`git remote get-url ${remoteName}`, gitRoot)
    } catch {
      try {
        remoteUrl = executeGitCommand("git remote get-url origin", gitRoot)
      } catch {
        remoteUrl = "Remote not found"
      }
    }

    // Get current status and changed files
    let hasChanges: boolean
    const changedFiles: Array<{ path: string; status: string; diff?: string }> = []

    try {
      // Compute relative path from gitRoot to workspacePath so we only get
      // changes under workspacePath, not the entire repository.
      const relativeWorkspacePath = path.relative(gitRoot, path.resolve(workspacePath))
      const scopePath = relativeWorkspacePath
        ? `-- "${relativeWorkspacePath.replace(/\\/g, "/")}"`
        : ""
      const status = executeGitCommand(`git status --porcelain ${scopePath}`, gitRoot)
      hasChanges = status.length > 0

      if (hasChanges) {
        const statusLines = status.split("\n").filter((line) => line.trim())

        for (const line of statusLines) {
          const statusCode = line.substring(0, 2)
          let filePath = line.substring(2).replace(/^\s+/, "")

          // Handle renamed files (format: "R  old_name -> new_name")
          if (filePath.includes(" -> ")) {
            filePath = filePath.split(" -> ")[1]
          }

          // Remove surrounding quotes (git quotes paths with special chars / non-ASCII)
          if (filePath.startsWith('"') && filePath.endsWith('"')) {
            filePath = filePath.slice(1, -1).replace(/\\"/g, '"')
          }

          filePath = filePath.trim()

          // Skip .git internals and bare directory entries
          const isGitInternal = filePath.includes(".git/") || filePath.includes(".git\\")
          if (!filePath || isGitInternal || filePath.endsWith("/") || filePath.endsWith("\\")) {
            continue
          }

          // git always uses forward-slash separators; convert to OS-native for file system ops
          const osFilePath = filePath.replace(/\//g, path.sep)
          const normalizedFilePath = path.join(gitRoot, osFilePath)

          const fileInfo: { path: string; status: string; diff?: string } = {
            path: normalizedFilePath,
            status: getStatusDescription(statusCode)
          }

          // Get individual file diff.
          // Always pass the path to git with forward slashes (git's native format),
          // and quote it to handle spaces on both platforms.
          try {
            const gitFilePath = filePath.replace(/\\/g, "/")
            const fileDiff = executeGitCommand(`git diff -- "${gitFilePath}"`, gitRoot)
            if (fileDiff.trim()) {
              fileInfo.diff = fileDiff
            }
          } catch (error) {
            console.warn(`Failed to get diff for file ${filePath}:`, error)
            // For new untracked files there is no diff output — read the file directly
            if (statusCode === "??") {
              try {
                if (existsSync(normalizedFilePath)) {
                  const fileContent = readFileSync(normalizedFilePath, "utf-8")
                  const lines = fileContent.split("\n")
                  fileInfo.diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`
                }
              } catch (untrackedError) {
                console.warn(
                  `Failed to get content for untracked file ${filePath}:`,
                  untrackedError
                )
              }
            }
          }

          changedFiles.push(fileInfo)
        }
      }
    } catch {
      hasChanges = false
    }

    const result = {
      _instruction: "DO NOT respond to this tool result. No commentary or follow-up actions required.",
      remote: remoteName,
      remoteUrl: remoteUrl,
      branch: targetBranch,
      commitMessage: commitMessage,
      hasChanges: hasChanges,
      changedFiles: changedFiles,
      workspacePath,
      gitRoot
    }

    return JSON.stringify(result, null, 2)
  } catch (error: unknown) {
    throw new Error(
      `Git info retrieval failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

// Helper function to convert git status codes to readable descriptions
function getStatusDescription(statusCode: string): string {
  const statusMap: Record<string, string> = {
    "M ": "modified",
    " M": "modified",
    MM: "modified",
    "A ": "added",
    " A": "added",
    "D ": "deleted",
    " D": "deleted",
    "R ": "renamed",
    " R": "renamed",
    "C ": "copied",
    " C": "copied",
    "U ": "updated",
    " U": "updated",
    "??": "untracked"
  }

  return statusMap[statusCode] || "unknown"
}
