import { useState, useEffect } from "react"
import { GitBranch, AlertTriangle, Play, Check, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

interface GitFileOperationPromptProps {
  filePath: string
  operation: string // 'write_file' or 'edit_file'
}

export function GitFileOperationPrompt({ filePath, operation }: GitFileOperationPromptProps) {
  const [showGitOptions, setShowGitOptions] = useState(false)
  const [commitMessage, setCommitMessage] = useState("")
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionResult, setExecutionResult] = useState<{ success: boolean; output?: string } | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [gitInfo, setGitInfo] = useState<{
    branch?: string
    remote?: string
    hasRemote?: boolean
    status?: string
    ahead?: number
    behind?: number
  }>({})

  useEffect(() => {
    // 生成智能提交信息
    const fileName = filePath.split("/").pop() || filePath
    const actionText = operation === "edit_file" ? "更新" : "创建"
    setCommitMessage(`${actionText}: ${fileName}`)

    // 获取Git仓库信息
    fetchGitInfo()
  }, [filePath, operation])

  const fetchGitInfo = async () => {
    try {
      // 根据文件路径确定正确的Git仓库根目录
      const fileDir = filePath.substring(0, filePath.lastIndexOf('/')) || '.'
      const repoPath = await window.electron.ipcRenderer.invoke("execute-git-command", `git -C "${fileDir}" rev-parse --show-toplevel`) as string

      // 获取当前分支（在正确的仓库中）
      const branch = await window.electron.ipcRenderer.invoke("execute-git-command", `git -C "${repoPath.trim()}" branch --show-current`) as string

      // 获取远程信息（在正确的仓库中）
      let remote = ""
      let hasRemote = false
      let remoteName = ""
      try {
        // 使用 git remote -v 获取远程仓库信息，这样更可靠
        const remotesVerbose = await window.electron.ipcRenderer.invoke("execute-git-command", `git -C "${repoPath.trim()}" remote -v`) as string
        console.log("Git remotes -v:", remotesVerbose)

        if (remotesVerbose && remotesVerbose.trim()) {
          // 解析输出，格式通常是: name url (fetch) 或 name url (push)
          const lines = remotesVerbose.trim().split('\n')
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
      const status = await window.electron.ipcRenderer.invoke("execute-git-command", `git -C "${repoPath.trim()}" status --porcelain`) as string

      // 获取ahead/behind信息（在正确的仓库中）
      let ahead = 0
      let behind = 0
      if (hasRemote && remoteName) {
        try {
          const aheadBehind = await window.electron.ipcRenderer.invoke("execute-git-command", `git -C "${repoPath.trim()}" rev-list --left-right --count HEAD...${remoteName}/${branch.trim()}`) as string
          const [aheadStr, behindStr] = aheadBehind.trim().split('\t')
          ahead = parseInt(aheadStr) || 0
          behind = parseInt(behindStr) || 0
        } catch {
          // 无法获取ahead/behind信息
        }
      }

      setGitInfo({
        branch: branch.trim(),
        remote: remote.trim(),
        hasRemote,
        status: status.trim(),
        ahead,
        behind
      })
    } catch (error) {
      console.error("获取Git信息失败:", error)
      // 设置默认状态，避免组件崩溃
      setGitInfo({
        branch: "unknown",
        remote: "",
        hasRemote: false,
        status: "",
        ahead: 0,
        behind: 0
      })
    }
  }

  const handleShowGitOptions = () => {
    setShowGitOptions(true)
  }

  const handleHideGitOptions = () => {
    setShowGitOptions(false)
    setExecutionResult(null)
    setCurrentStep(0)
  }

  const executeGitCommands = async () => {
    setIsExecuting(true)
    setExecutionResult(null)

    // 根据文件路径确定正确的Git仓库根目录
    let repoPath = ""
    try {
      const fileDir = filePath.substring(0, filePath.lastIndexOf('/')) || '.'
      repoPath = await window.electron.ipcRenderer.invoke("execute-git-command", `git -C "${fileDir}" rev-parse --show-toplevel`) as string
      repoPath = repoPath.trim()
    } catch (error) {
      console.error("无法确定Git仓库路径:", error)
      setExecutionResult({ success: false, output: "无法确定Git仓库路径" })
      setIsExecuting(false)
      return
    }

    const commands = [
      `git -C "${repoPath}" add "${filePath}"`,
      `git -C "${repoPath}" commit -m "${commitMessage.trim()}"`,
      gitInfo.hasRemote ? `git -C "${repoPath}" push` : null
    ].filter(Boolean) as string[]

    try {
      for (let i = 0; i < commands.length; i++) {
        setCurrentStep(i)
        try {
          const result = await window.electron.ipcRenderer.invoke("execute-git-command", commands[i])
          console.log(`Git命令执行成功: ${commands[i]}`, result)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          setExecutionResult({ success: false, output: errorMessage })
          console.error(`Git命令执行失败: ${commands[i]}`, error)
          return // 停止执行后续命令
        }
      }

      setExecutionResult({ success: true, output: "所有Git命令执行成功" })

      // 重新获取Git信息以更新状态
      await fetchGitInfo()
    } catch (error) {
      console.error("执行Git命令时发生错误:", error)
      setExecutionResult({
        success: false,
        output: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setIsExecuting(false)
      setCurrentStep(0)
    }
  }

  if (!showGitOptions) {
    return (
      <div className="flex items-start gap-2 p-2 bg-blue-50/90 dark:bg-blue-950/90 border border-blue-200 dark:border-blue-800 rounded">
        <GitBranch className="size-4 text-blue-600 dark:text-blue-400 mt-0.5" />
        <div className="flex-1 text-xs">
          <div className="font-medium text-blue-800 dark:text-blue-200">
            文件已{operation === "edit_file" ? "修改" : "创建"}
          </div>
          <div className="text-blue-700 dark:text-blue-300 mt-1">
            是否要提交到Git？
          </div>
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleShowGitOptions}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              <GitBranch className="size-3" />
              提交到Git
            </button>
            <button
              onClick={() => {/* 忽略提示 */}}
              className="px-2 py-1 text-xs border border-blue-200 dark:border-blue-700 rounded hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors"
            >
              暂时跳过
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3 border border-border rounded p-3 bg-background-elevated">
      {/* 标题和Git仓库信息 */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-status-info" />
          <span className="text-sm font-medium">Git 提交</span>
          <Badge variant="outline" className="text-xs">
            {filePath.split("/").pop()}
          </Badge>
        </div>

        {/* Git仓库状态信息 */}
        {gitInfo.branch && (
          <div className="grid grid-cols-1 gap-2 text-xs bg-background/50 p-2 rounded border">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">分支:</span>
              <Badge variant="secondary" className="text-xs font-mono">
                {gitInfo.branch}
              </Badge>
              {/*{(gitInfo.ahead && gitInfo.ahead > 0) && (*/}
              {/*  <Badge variant="warning" className="text-xs">*/}
              {/*    +{gitInfo.ahead} 提交待推送*/}
              {/*  </Badge>*/}
              {/*)}*/}
              {/*{(gitInfo.behind && gitInfo.behind > 0) && (*/}
              {/*  <Badge variant="critical" className="text-xs">*/}
              {/*    -{gitInfo.behind} 提交待拉取*/}
              {/*  </Badge>*/}
              {/*)}*/}
            </div>

            {gitInfo.hasRemote ? (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">远程:</span>
                <span className="font-mono text-xs truncate">{gitInfo.remote}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">远程:</span>
                <Badge variant="warning" className="text-xs">
                  未配置远程仓库
                </Badge>
              </div>
            )}

            {gitInfo.status && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">状态:</span>
                <span className="text-xs">
                  {gitInfo.status.split('\n').length} 个文件有变更
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 提交信息编辑 */}
      <div className="space-y-2">
        <div className="text-xs font-medium">提交信息:</div>
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          disabled={isExecuting}
          placeholder="请输入提交信息..."
          className="w-full p-2 text-xs border border-border rounded resize-none"
          rows={2}
        />
      </div>

      {/* 执行步骤显示 */}
      {(isExecuting || executionResult) && (
        <div className="space-y-2">
          <div className="text-xs font-medium">执行进度:</div>
          <div className="space-y-1">
            {[
              {
                step: 0,
                label: "添加文件到暂存区",
                command: `git add "${filePath}"`,
                info: `将 ${filePath.split("/").pop()} 添加到暂存区`
              },
              {
                step: 1,
                label: "提交更改",
                command: `git commit -m "${commitMessage.trim()}"`,
                info: `分支: ${gitInfo.branch || 'unknown'} | 信息: ${commitMessage.trim()}`
              },
              ...(gitInfo.hasRemote ? [{
                step: 2,
                label: "推送到远程仓库",
                command: "git push",
                info: `推送到 ${gitInfo.remote ? gitInfo.remote.split('/').pop()?.replace('.git', '') : 'origin'} / ${gitInfo.branch || 'main'}`
              }] : [])
            ].map(({ step, label, command, info }) => (
              <div
                key={step}
                className={cn(
                  "flex flex-col gap-1 p-2 rounded text-xs border",
                  currentStep === step && isExecuting && "bg-status-info/10 border-status-info/20",
                  currentStep > step && "bg-status-nominal/10 border-status-nominal/20",
                  currentStep < step && "bg-background border-border/50"
                )}
              >
                <div className="flex items-center gap-2">
                  {currentStep > step ? (
                    <Check className="size-3 text-status-nominal" />
                  ) : currentStep === step && isExecuting ? (
                    <div className="size-3 border border-status-info rounded-full border-t-transparent animate-spin" />
                  ) : (
                    <div className="size-3 rounded-full border border-border" />
                  )}
                  <div className="flex-1">
                    <div className="font-medium">{label}</div>
                    <div className="font-mono text-muted-foreground text-[10px]">{command}</div>
                  </div>
                  {currentStep === step && isExecuting && (
                    <Badge variant="outline" className="animate-pulse">执行中</Badge>
                  )}
                  {currentStep > step && (
                    <Badge variant="nominal">完成</Badge>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground ml-5 pl-1 border-l border-border/30">
                  {info}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 执行结果 */}
      {executionResult && (
        <div className="space-y-2">
          <div
            className={cn(
              "p-2 rounded text-xs border",
              executionResult.success
                ? "bg-status-nominal/10 border-status-nominal/20 text-status-nominal"
                : "bg-status-critical/10 border-status-critical/20 text-status-critical"
            )}
          >
            <div className="flex items-center gap-2 font-medium">
              {executionResult.success ? (
                <Check className="size-3" />
              ) : (
                <X className="size-3" />
              )}
              {executionResult.success ? "Git提交成功" : "Git提交失败"}
            </div>
            {executionResult.output && (
              <pre className="mt-1 text-xs whitespace-pre-wrap">{executionResult.output}</pre>
            )}
            {executionResult.success && (
              <div className="mt-2 text-[10px] text-status-nominal/70">
                ✓ 文件已添加到Git历史记录
                {gitInfo.hasRemote && " ✓ 更改已推送到远程仓库"}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <button
          onClick={executeGitCommands}
          disabled={isExecuting || !commitMessage.trim() || (executionResult?.success === true)}
          className="flex items-center gap-1 px-3 py-1.5 text-xs bg-status-nominal text-background rounded hover:bg-status-nominal/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Play className="size-3" />
          {isExecuting ? "提交中..." : executionResult?.success ? "已提交" : "确认提交"}
        </button>

        <button
          onClick={handleHideGitOptions}
          disabled={isExecuting}
          className="px-3 py-1.5 text-xs border border-border rounded hover:bg-background-interactive disabled:opacity-50 transition-colors"
        >
          {executionResult ? "关闭" : "取消"}
        </button>

        {!gitInfo.hasRemote && (
          <span className="text-xs text-amber-600">
            ⚠️ 仅本地提交 (无远程仓库)
          </span>
        )}
      </div>
    </div>
  )
}
