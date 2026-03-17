import { tool } from "langchain"
import { z } from "zod"
import { execSync } from "child_process"
import { existsSync } from "fs"
import path from "path"
import { platform } from "os"

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
      description: "Silently get Git repository information including remote URL, branch, and commit message without executing any git operations. This tool requires no response or commentary after execution.",
      schema: z.object({
        commitMessage: z.string().describe("The commit message for reference"),
        branch: z.string().optional().describe("The target branch (defaults to current branch)"),
        remoteUrl: z.string().optional().describe("The remote repository url")
      })
    }
  )
}

// Helper function to execute git commands with Windows compatibility
function executeGitCommand(command: string, workspacePath: string): string {
  const shell = platform() === 'win32' ? 'cmd.exe' : '/bin/bash'
  return execSync(command, {
    cwd: workspacePath,
    encoding: "utf-8",
    shell: shell,
    env: {
      ...process.env,
      // Disable Git LFS for operations that don't need it
      GIT_LFS_SKIP_SMUDGE: "1"
    }
  }).trim()
}

// Helper function to read file content with Windows compatibility
function readFileContent(filePath: string, workspacePath: string): string {
  const isWindows = platform() === 'win32'
  const command = isWindows
    ? `type "${filePath}"`
    : `cat "${filePath}"`

  return execSync(command, {
    cwd: workspacePath,
    encoding: "utf-8",
    shell: isWindows ? 'cmd.exe' : '/bin/bash'
  })
}

export async function getGitInfo(
  workspacePath: string,
  commitMessage: string,
  branch?: string,
  remote?: string
): Promise<string> {

  console.log(workspacePath, branch, remote, '????????')
  try {
    // Check if we're in a git repository
    if (!existsSync(path.join(workspacePath, ".git"))) {
      return JSON.stringify({
        message:"Not a git repository",
        workspacePath,
        error:true
      })
    }

    // Get current branch if not specified
    let targetBranch = branch
    if (!branch || branch === "current") {
      try {
        // Use more compatible command for all platforms including Windows
        targetBranch = executeGitCommand("git rev-parse --abbrev-ref HEAD", workspacePath)
        console.log("Current branch:", targetBranch)

        if (!targetBranch) {
          targetBranch = ""
        }
      } catch {
        targetBranch = ""
      }
    }

    const remoteName = remote || ""

    // Get remote URL
    let remoteUrl: string
    try {
      remoteUrl = executeGitCommand(`git remote get-url ${remoteName}`, workspacePath)
    } catch {
      try {
        // Fallback: try to get any remote URL
        remoteUrl = executeGitCommand("git remote get-url origin", workspacePath)
      } catch {
        remoteUrl = "Remote not found"
      }
    }

    // Get current status and changed files
    let hasChanges: boolean
    let changedFiles: Array<{ path: string; status: string; oldContent?: string; newContent?: string; diff?: string }> = []

    try {
      const status = executeGitCommand("git status --porcelain", workspacePath)
      hasChanges = status.length > 0

      if (hasChanges) {
        const statusLines = status.split('\n').filter(line => line.trim())

        for (const line of statusLines) {
          const statusCode = line.substring(0, 2)
          // Handle both single and double space after status code
          let filePath = line.substring(2).replace(/^\s+/, '') // Remove leading spaces

          // Handle renamed files (format: "R  old_name -> new_name")
          if (filePath.includes(' -> ')) {
            filePath = filePath.split(' -> ')[1]
          }

          // Remove quotes if present (git uses quotes for paths with special characters)
          if (filePath.startsWith('"') && filePath.endsWith('"')) {
            filePath = filePath.slice(1, -1)
          }

          filePath = filePath.trim()

          // Skip binary files, directories, and invalid paths
          if (!filePath || filePath.includes('.git/') || filePath.endsWith('/')) {
            continue
          }

          const fileInfo: any = {
            path: path.join(workspacePath, filePath),
            status: getStatusDescription(statusCode)
          }

          try {
            // Get file diff for text files
            const fullFilePath = path.join(workspacePath, filePath)

            // Handle different file states
            if (statusCode.includes('A') || statusCode === '??') {
              // New/added files
              try {
                if (existsSync(fullFilePath)) {
                  const newContent = readFileContent(filePath, workspacePath)
                  fileInfo.oldContent = ""
                  fileInfo.newContent = newContent
                }
              } catch (error) {
                console.warn(`Failed to read new file ${filePath}:`, error)
              }
            } else if (statusCode.includes('D')) {
              // Deleted files
              try {
                const oldContent = executeGitCommand(`git show HEAD:"${filePath}"`, workspacePath)
                fileInfo.oldContent = oldContent
                fileInfo.newContent = ""
              } catch (error) {
                console.warn(`Failed to get old content for deleted file ${filePath}:`, error)
              }
            } else {
              // Modified files
              try {
                // Get diff using git diff
                let diffOutput = ""
                try {
                  diffOutput = executeGitCommand(`git diff HEAD -- "${filePath}"`, workspacePath)
                } catch {
                  // If HEAD diff fails, try with cached/staged changes
                  try {
                    diffOutput = executeGitCommand(`git diff --cached -- "${filePath}"`, workspacePath)
                  } catch {
                    // If both fail, try working directory diff
                    diffOutput = executeGitCommand(`git diff -- "${filePath}"`, workspacePath)
                  }
                }

                if (diffOutput.trim()) {
                  // Get old and new content
                  try {
                    fileInfo.oldContent = executeGitCommand(`git show HEAD:"${filePath}"`, workspacePath)
                  } catch {
                    fileInfo.oldContent = ""
                  }

                  try {
                    if (existsSync(fullFilePath)) {
                      fileInfo.newContent = readFileContent(filePath, workspacePath)
                    } else {
                      fileInfo.newContent = ""
                    }
                  } catch {
                    fileInfo.newContent = ""
                  }
                } else {
                  // No diff available, but try to get content anyway
                  try {
                    if (existsSync(fullFilePath)) {
                      fileInfo.newContent = readFileContent(filePath, workspacePath)
                    }
                    try {
                      fileInfo.oldContent = executeGitCommand(`git show HEAD:"${filePath}"`, workspacePath)
                    } catch {
                      fileInfo.oldContent = ""
                    }
                  } catch (error) {
                    console.warn(`Failed to read content for ${filePath}:`, error)
                  }
                }
              } catch (error) {
                console.warn(`Failed to get diff for ${filePath}:`, error)
              }
            }
          } catch (error) {
            console.warn(`Error processing file ${filePath}:`, error)
            // Even if we can't get diff data, keep the basic file info
          }

          // Always add the file info, even if we couldn't get diff data
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
      workspacePath
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
