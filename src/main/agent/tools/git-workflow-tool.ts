import { tool } from "langchain"
import { z } from "zod"
import { execSync } from "child_process"
import { existsSync } from "fs"
import path from "path"
import { useCallback } from "react";

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

const fetchGitInfo = async  (fileDir)=>{
  try {
    // 根据文件路径确定正确的Git仓库根目录
    // const fileDir = filePath.replace(/[/\\][^/\\]*$/, "") || "."
    const repoPath = (await window.electron.ipcRenderer.invoke(
      "execute-git-command",
      `git -C "${fileDir}" rev-parse --show-toplevel`
    )) as string

    // 获取当前分支（在正确的仓库中）
    const branch = (await window.electron.ipcRenderer.invoke(
      "execute-git-command",
      `git -C "${repoPath.trim()}" rev-parse --abbrev-ref HEAD`
    )) as string

    // 获取远程信息（在正确的仓库中）
    let remote = ""
    let hasRemote = false
    let remoteName = ""
    try {
      // 使用 git remote -v 获取远程仓库信息，这样更可靠
      const remotesVerbose = (await window.electron.ipcRenderer.invoke(
        "execute-git-command",
        `git -C "${repoPath.trim()}" remote -v`
      )) as string
      console.log("Git remotes -v:", remotesVerbose)

      if (remotesVerbose && remotesVerbose.trim()) {
        // 解析输出，格式通常是: name url (fetch) 或 name url (push)
        const lines = remotesVerbose.trim().split("\n")
        const remoteMap = new Map<string, string>()

        for (const line of lines) {
          const parts = line.trim().split(/\s+/)
          if (parts.length >= 2) {
            const name = parts[0]
            const url = parts[1]
            remoteMap.set(name, url)
          }
        }

        console.log("Parsed remotes:", Array.from(remoteMap.entries()))

        if (remoteMap.size > 0) {
          // 使用第一个远程仓库
          const firstRemote = Array.from(remoteMap.entries())[0]
          remoteName = firstRemote[0]
          remote = firstRemote[1]
          hasRemote = true
          console.log("Selected remote:", remoteName, remote)
        }
      }
    } catch (error) {
      console.error("Failed to get remotes:", error)
      // 没有远程仓库
    }

    // 获取仓库状态（在正确的仓库中）
    const status = (await window.electron.ipcRenderer.invoke(
      "execute-git-command",
      `git -C "${repoPath.trim()}" status --porcelain`
    )) as string

    // 获取ahead/behind信息（在正确的仓库中）
    let ahead = 0
    let behind = 0
    if (hasRemote && remoteName) {
      try {
        const aheadBehind = (await window.electron.ipcRenderer.invoke(
          "execute-git-command",
          `git -C "${repoPath.trim()}" rev-list --left-right --count HEAD...${remoteName}/${branch.trim()}`
        )) as string
        const [aheadStr, behindStr] = aheadBehind.trim().split("\t")
        ahead = parseInt(aheadStr) || 0
        behind = parseInt(behindStr) || 0
      } catch {
        // 无法获取ahead/behind信息
      }
    }

    const gitInfo = {
      branch: branch.trim(),
      remote: remote.trim(),
      hasRemote,
      status: status.trim(),
      ahead,
      behind
    }
  } catch (error) {
    console.error("获取Git信息失败:", error)
  }
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
        // Use more compatible command instead of --show-current
        //   targetBranch = execSync("git branch --show-current", { 这个代码windows不支持
        targetBranch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: workspacePath,
          encoding: "utf-8"
        }).trim()
        console.log("Current branch:", targetBranch)

        if (!targetBranch) {
          targetBranch = ""
        }
      } catch {
        targetBranch = ""
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
                  const newContent = execSync(`cat "${fullFilePath}"`, {
                    cwd: workspacePath,
                    encoding: "utf-8"
                  })
                  fileInfo.oldContent = ""
                  fileInfo.newContent = newContent
                  // const lines = newContent.split('\n')
                  // fileInfo.diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}`
                }
              } catch (error) {
                console.warn(`Failed to read new file ${filePath}:`, error)
              }
            } else if (statusCode.includes('D')) {
              // Deleted files
              try {
                const oldContent = execSync(`git show HEAD:"${filePath}"`, {
                  cwd: workspacePath,
                  encoding: "utf-8"
                })
                fileInfo.oldContent = oldContent
                fileInfo.newContent = ""
                // const lines = oldContent.split('\n')
                // fileInfo.diff = `--- a/${filePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map(line => '-' + line).join('\n')}`
              } catch (error) {
                console.warn(`Failed to get old content for deleted file ${filePath}:`, error)
              }
            } else {
              // Modified files
              try {
                // Get diff using git diff
                let diffOutput = ""
                try {
                  diffOutput = execSync(`git diff HEAD -- "${filePath}"`, {
                    cwd: workspacePath,
                    encoding: "utf-8"
                  })
                } catch {
                  // If HEAD diff fails, try with cached/staged changes
                  try {
                    diffOutput = execSync(`git diff --cached -- "${filePath}"`, {
                      cwd: workspacePath,
                      encoding: "utf-8"
                    })
                  } catch {
                    // If both fail, try working directory diff
                    diffOutput = execSync(`git diff -- "${filePath}"`, {
                      cwd: workspacePath,
                      encoding: "utf-8"
                    })
                  }
                }

                if (diffOutput.trim()) {
                  // fileInfo.diff = diffOutput

                  // Get old and new content
                  try {
                    fileInfo.oldContent = execSync(`git show HEAD:"${filePath}"`, {
                      cwd: workspacePath,
                      encoding: "utf-8"
                    })
                  } catch {
                    fileInfo.oldContent = ""
                  }

                  try {
                    if (existsSync(fullFilePath)) {
                      fileInfo.newContent = execSync(`cat "${fullFilePath}"`, {
                        cwd: workspacePath,
                        encoding: "utf-8"
                      })
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
                      fileInfo.newContent = execSync(`cat "${fullFilePath}"`, {
                        cwd: workspacePath,
                        encoding: "utf-8"
                      })
                    }
                    try {
                      fileInfo.oldContent = execSync(`git show HEAD:"${filePath}"`, {
                        cwd: workspacePath,
                        encoding: "utf-8"
                      })
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
