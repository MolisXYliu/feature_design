import { ipcMain } from "electron"
import { execSync } from "child_process"

interface GitStatus {
  hasChanges: boolean
  changedFiles: string[]
  untrackedFiles: string[]
  stagedFiles: string[]
}

// 获取当前工作目录
function getCurrentWorkingDirectory(): string {
  try {
    // 尝试获取Git仓库根目录
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd: process.cwd()
    }).trim()
    return gitRoot
  } catch {
    // 如果不是Git仓库，返回当前工作目录
    return process.cwd()
  }
}

// 执行Git命令
function executeGitCommand(command: string, cwd?: string): string {
  try {
    const workingDir = cwd || getCurrentWorkingDirectory()
    const result = execSync(command, {
      encoding: "utf-8",
      cwd: workingDir,
      timeout: 30000 // 30秒超时
    })
    return result.trim()
  } catch (error: any) {
    if (error.stderr) {
      throw new Error(error.stderr.toString().trim())
    } else if (error.stdout) {
      return error.stdout.toString().trim()
    } else {
      throw new Error(`命令执行失败: ${error.message}`)
    }
  }
}

// 获取Git状态
function getGitStatus(): GitStatus {
  try {
    // 检查是否在Git仓库中
    try {
      executeGitCommand("git rev-parse --git-dir")
    } catch {
      return {
        hasChanges: false,
        changedFiles: [],
        untrackedFiles: [],
        stagedFiles: []
      }
    }

    const status: GitStatus = {
      hasChanges: false,
      changedFiles: [],
      untrackedFiles: [],
      stagedFiles: []
    }

    // 获取修改的文件
    try {
      const modifiedFiles = executeGitCommand("git diff --name-only")
      if (modifiedFiles) {
        status.changedFiles = modifiedFiles.split("\n").filter(f => f.trim())
      }
    } catch {
      // 忽略错误，可能没有修改的文件
    }

    // 获取未跟踪的文件
    try {
      const untrackedFiles = executeGitCommand("git ls-files --others --exclude-standard")
      if (untrackedFiles) {
        status.untrackedFiles = untrackedFiles.split("\n").filter(f => f.trim())
      }
    } catch {
      // 忽略错误
    }

    // 获取暂存的文件
    try {
      const stagedFiles = executeGitCommand("git diff --cached --name-only")
      if (stagedFiles) {
        status.stagedFiles = stagedFiles.split("\n").filter(f => f.trim())
      }
    } catch {
      // 忽略错误
    }

    // 检查是否有任何变更
    status.hasChanges =
      status.changedFiles.length > 0 ||
      status.untrackedFiles.length > 0 ||
      status.stagedFiles.length > 0

    return status
  } catch (error) {
    console.error("获取Git状态失败:", error)
    return {
      hasChanges: false,
      changedFiles: [],
      untrackedFiles: [],
      stagedFiles: []
    }
  }
}

// 注册Git相关的IPC处理器
export function registerGitHandlers(): void {
  // 获取Git状态
  ipcMain.handle("git-status", async (): Promise<GitStatus> => {
    try {
      return getGitStatus()
    } catch (error) {
      console.error("[IPC] git-status error:", error)
      throw error
    }
  })

  // 执行Git命令
  ipcMain.handle("execute-git-command", async (_, command: string): Promise<string> => {
    try {
      console.log("[IPC] 执行Git命令:", command)

      // 安全检查 - 只允许特定的Git命令
      const allowedCommands = [
        /^git(\s+-C\s+"[^"]*")?\s+add/,
        /^git(\s+-C\s+"[^"]*")?\s+commit/,
        /^git(\s+-C\s+"[^"]*")?\s+push/,
        /^git(\s+-C\s+"[^"]*")?\s+pull/,
        /^git(\s+-C\s+"[^"]*")?\s+status/,
        /^git(\s+-C\s+"[^"]*")?\s+diff/,
        /^git(\s+-C\s+"[^"]*")?\s+log/,
        /^git(\s+-C\s+"[^"]*")?\s+branch/,
        /^git(\s+-C\s+"[^"]*")?\s+checkout/,
        /^git(\s+-C\s+"[^"]*")?\s+merge/,
        /^git(\s+-C\s+"[^"]*")?\s+reset/,
        /^git(\s+-C\s+"[^"]*")?\s+stash/,
        /^git(\s+-C\s+"[^"]*")?\s+remote/,
        /^git(\s+-C\s+"[^"]*")?\s+rev-list/,
        /^git(\s+-C\s+"[^"]*")?\s+rev-parse/,
        /^git(\s+-C\s+"[^"]*")?\s+ls-files/
      ]

      const isAllowed = allowedCommands.some(pattern => pattern.test(command.trim()))
      if (!isAllowed) {
        throw new Error(`不允许执行的命令: ${command}`)
      }

      const result = executeGitCommand(command)
      console.log("[IPC] Git命令执行成功:", command, "结果:", result)

      return result
    } catch (error) {
      console.error("[IPC] execute-git-command error:", error)
      throw error
    }
  })

  // 执行任意命令（使用cmd）
  ipcMain.handle("execute-command", async (_, command: string): Promise<string> => {
    try {
      console.log("[IPC] 执行命令:", command)

      const result = execSync(command, {
        encoding: "utf-8",
        cwd: getCurrentWorkingDirectory(),
        timeout: 30000, // 30秒超时
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
      })

      console.log("[IPC] 命令执行成功:", command, "结果:", result.trim())
      return result.trim()
    } catch (error: any) {
      console.error("[IPC] execute-command error:", error)
      if (error.stderr) {
        throw new Error(error.stderr.toString().trim())
      } else if (error.stdout) {
        return error.stdout.toString().trim()
      } else {
        throw new Error(`命令执行失败: ${error.message}`)
      }
    }
  })

  console.log("[IPC] Git handlers registered")
}
