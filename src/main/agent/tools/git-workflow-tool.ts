import { tool } from "langchain"
import { z } from "zod"
import { execSync } from "child_process"
import { existsSync } from "fs"
import path from "path"

export function createGitWorkflowTool(workspacePath: string) {
  return tool(
    async ({ commitMessage, branch, remote }) => {
      try {
        const result = await getGitInfo(workspacePath, commitMessage, branch, remote)
        console.log(`Git info: ${result}`)
        return result
      } catch (error: any) {
        return `Git info retrieval failed: ${error.message}`
      }
    },
    {
      name: "git_workflow",
      description: "Get Git repository information including remote URL, branch, and commit message without executing any git operations",
      schema: z.object({
        commitMessage: z.string().describe("The commit message for reference"),
        branch: z.string().optional().describe("The target branch (defaults to current branch)"),
        remoteUrl: z.string().optional().describe("The remote repository url")
      })
    }
  )
}

export async function getGitInfo(
  workspacePath: string,
  commitMessage: string,
  branch?: string,
  remote?: string
): Promise<string> {
  try {
    // Check if we're in a git repository
    if (!existsSync(path.join(workspacePath, ".git"))) {
      return "Not a git repository"
    }

    // Get current branch if not specified
    let targetBranch = branch
    if (!branch || branch === "current") {
      try {
        targetBranch = execSync("git branch --show-current", {
          cwd: workspacePath,
          encoding: "utf-8"
        }).trim()

        if (!targetBranch) {
          targetBranch = "main"
        }
      } catch {
        targetBranch = "main"
      }
    }

    const remoteName = remote || "origin"

    // Get remote URL
    let remoteUrl: string
    try {
      remoteUrl = execSync(`git remote get-url ${remoteName}`, {
        cwd: workspacePath,
        encoding: "utf-8"
      }).trim()
    } catch {
      remoteUrl = "Remote not found"
    }

    // Get current status
    let hasChanges: boolean
    try {
      const status = execSync("git status --porcelain", {
        cwd: workspacePath,
        encoding: "utf-8"
      }).trim()
      hasChanges = status.length > 0
    } catch {
      hasChanges = false
    }

    const result = {
      remote: remoteName,
      remoteUrl: remoteUrl,
      branch: targetBranch,
      commitMessage: commitMessage,
      hasChanges: hasChanges
    }

    return JSON.stringify(result, null, 2)

  } catch (error: any) {
    throw new Error(`Git info retrieval failed: ${error.message}`)
  }
}
