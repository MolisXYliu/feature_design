import { tool } from "langchain"
import { z } from "zod"
import { execSync } from "child_process"
import { existsSync } from "fs"
import path from "path"

export function createGitWorkflowTool(workspacePath: string) {
  return tool(
    async ({ commitMessage, branch, remoteUrl }) => {
      try {
        const result = await getGitInfo(workspacePath, commitMessage, branch, remoteUrl)
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

    // Get current status and changed files
    let hasChanges: boolean
    let changedFiles: Array<{ path: string; status: string; oldContent?: string; newContent?: string; diff?: string }> = []

    try {
      const status = execSync("git status --porcelain", {
        cwd: workspacePath,
        encoding: "utf-8"
      }).trim()
      hasChanges = status.length > 0

      if (hasChanges) {
        const statusLines = status.split('\n').filter(line => line.trim())

        for (const line of statusLines) {
          const statusCode = line.substring(0, 2)
          const filePath = line.substring(3).trim()

          // Skip binary files and directories
          if (filePath.includes('.git/') || filePath.endsWith('/')) {
            continue
          }

          const fileInfo: any = {
            path: filePath,
            status: getStatusDescription(statusCode)
          }

          try {
            // Get file diff for text files
            const fullFilePath = path.join(workspacePath, filePath)
            if (existsSync(fullFilePath)) {
              // Get diff for the file
              const diffOutput = execSync(`git diff HEAD -- "${filePath}"`, {
                cwd: workspacePath,
                encoding: "utf-8"
              })

              if (diffOutput.trim()) {
                fileInfo.diff = diffOutput

                // Try to extract old and new content from diff
                try {
                  fileInfo.oldContent = execSync(`git show HEAD:"${filePath}"`, {
                    cwd: workspacePath,
                    encoding: "utf-8"
                  })
                } catch {
                  fileInfo.oldContent = ""
                }

                try {
                  fileInfo.newContent = execSync(`cat "${fullFilePath}"`, {
                    cwd: workspacePath,
                    encoding: "utf-8"
                  })
                } catch {
                  fileInfo.newContent = ""
                }
              }
            }
          } catch (error) {
            // Handle cases where file might not exist in HEAD (new files)
            if (statusCode.includes('A')) {
              try {
                const fullFilePath = path.join(workspacePath, filePath)
                const newContent = execSync(`cat "${fullFilePath}"`, {
                  cwd: workspacePath,
                  encoding: "utf-8"
                })
                fileInfo.oldContent = ""
                fileInfo.newContent = newContent
                fileInfo.diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${newContent.split('\n').length} @@\n${newContent.split('\n').map(line => '+' + line).join('\n')}`
              } catch {
                // Ignore if we can't read the file
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
      remote: remoteName,
      remoteUrl: remoteUrl,
      branch: targetBranch,
      commitMessage: commitMessage,
      hasChanges: hasChanges,
      changedFiles: changedFiles
    }

    return JSON.stringify(result, null, 2)

  } catch (error: any) {
    throw new Error(`Git info retrieval failed: ${error.message}`)
  }
}

// Helper function to convert git status codes to readable descriptions
function getStatusDescription(statusCode: string): string {
  const statusMap: Record<string, string> = {
    'M ': 'modified',
    ' M': 'modified',
    'MM': 'modified',
    'A ': 'added',
    ' A': 'added',
    'D ': 'deleted',
    ' D': 'deleted',
    'R ': 'renamed',
    ' R': 'renamed',
    'C ': 'copied',
    ' C': 'copied',
    'U ': 'updated',
    ' U': 'updated',
    '??': 'untracked'
  }

  return statusMap[statusCode] || 'unknown'
}

