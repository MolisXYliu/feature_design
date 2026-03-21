import { useState, useEffect, useMemo } from "react"
import {
  GitBranch,
  Play,
  Check,
  X,
  Clock,
  FileText,
  ChevronDown,
  ChevronRight,
  CheckCircle
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { GitCommitTracker, type CommitRecord } from "@/lib/git-commit-tracker"
import { DiffDisplay } from "../ToolCallRenderer"
import { uploadCommitData } from "@/api"

interface ChangedFile {
  path: string
  status: string
  oldContent?: string
  newContent?: string
  diff?: string
}

interface GitFileOperationPromptWithPropsProps {
  operation: string // 'write_file' or 'edit_file'
  remoteUrl: string // Git远程仓库URL，从props传入
  branch: string // Git分支，从props传入
  commitmessage: string // 默认提交信息，从props传入，支持编辑
  changedFiles?: ChangedFile[] // 修改的文件列表
  onSkip?: () => void
  operationId?: string // 操作ID，用于唯一标识本次操作
  workspacePath:string
}

export function GitFileOperationPromptWithProps({
  operation,
  remoteUrl,
  branch,
  commitmessage,
  changedFiles = [],
  onSkip,
  operationId,
  workspacePath
}: GitFileOperationPromptWithPropsProps) {
  // 生成操作ID（如果没有提供的话）- 使用useMemo确保只生成一次
  const currentOperationId = useMemo(() => {
    if (operationId) {
      return operationId
    }

    // 生成基于操作类型和时间戳的稳定哈希
    const content = `${operation}_${Date.now()}`
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return `${operation}_${Math.abs(hash).toString(36)}_all_files`
  }, [operationId, operation])

  const [showGitOptions, setShowGitOptions] = useState(true)
  const [showChangedFiles, setShowChangedFiles] = useState(false) // 默认展开文件列表
  // 使用props传入的commitmessage作为默认值
  const [commitMessage, setCommitMessage] = useState(commitmessage || "")
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionResult, setExecutionResult] = useState<{
    success: boolean
    output?: string
  } | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [cardNumber, setCardNumber] = useState("")
  // 用于控制每个文件的diff展示状态
  const [expandedDiffs, setExpandedDiffs] = useState<Set<number>>(new Set())
  // 添加命令预览状态
  const [showCommandPreview, setShowCommandPreview] = useState(false)
  const [previewCommands, setPreviewCommands] = useState<Array<{command: string, description: string}>>([])
  // 每条命令的用户确认状态
  const [confirmedCommands, setConfirmedCommands] = useState<Set<number>>(new Set())
  // 分支确认状态
  const [isBranchConfirmed, setIsBranchConfirmed] = useState(false)

  // 检查当前操作是否已提交
  const [isCurrentOperationCommitted, setIsCurrentOperationCommitted] = useState(false)
  const [hasFileCommitHistory, setHasFileCommitHistory] = useState(false)
  const [latestCommitRecord, setLatestCommitRecord] = useState<CommitRecord | null>(null)


  const gitRepoPath = useMemo(()=>{
    // 根据文件路径确定正确的Git仓库根目录
    // const filePath = changedFiles?.length ? changedFiles[0]?.path : ''
    // const fileDir = filePath.replace(/[/\\][^/\\]*$/, "") || ''
    // return fileDir || workspacePath
    return workspacePath
  },[changedFiles, workspacePath])

  // 判断是否有远程仓库
  const hasRemote = Boolean(remoteUrl && remoteUrl.trim())

  // 切换特定文件diff的展开状态
  const toggleDiffExpansion = (index: number) => {
    setExpandedDiffs(prev => {
      const newSet = new Set(prev)
      if (newSet.has(index)) {
        newSet.delete(index)
      } else {
        newSet.add(index)
      }
      return newSet
    })
  }

  // 当props中的commitmessage变化时，更新本地状态
  useEffect(() => {
    setCommitMessage(commitmessage || "")
  }, [commitmessage])

  useEffect(() => {
    // 检查当前操作是否已经提交过
    const isCurrentOpCommitted = GitCommitTracker.hasCommittedOperation(currentOperationId)
    setIsCurrentOperationCommitted(isCurrentOpCommitted)

    // 由于我们现在提交所有文件，不再需要检查特定文件的提交历史
    setHasFileCommitHistory(false)
    setLatestCommitRecord(null)

    // 如果没有默认提交信息，生成智能提交信息
    if (!commitMessage.trim()) {
      const actionText = operation === "edit_file" ? "更新" : "创建"
      setCommitMessage(`${actionText}: 批量文件提交`)
    }

    // 清理过期记录
    GitCommitTracker.cleanupExpiredRecords()
  }, [operation, currentOperationId, commitMessage])

  const handleShowGitOptions = async () => {
    setShowGitOptions(true)
  }

  const handleHideGitOptions = () => {

    setShowGitOptions(false)
    setExecutionResult(null)
    setCurrentStep(0)
    setShowCommandPreview(false)
  }

  // 生成命令预览
  const generateCommandPreview = async () => {
    try {
      // 根据修改的文件获取Git仓库根目录
      // let gitRepoPath = workspacePath

      const commands = [
        {
          command: `git -C "${gitRepoPath}" add .`,
          description: "添加所有修改的文件到暂存区"
        },
        {
          command: `git -C "${gitRepoPath}" commit -m "${cardNumber.trim()} #comment fix: ${commitMessage.trim()} #CMBDevClaw"`,
          description: "提交更改并添加提交信息"
        }
      ]

      if (hasRemote) {
        commands.push({
          command: `git -C "${gitRepoPath}" push`,
          description: `推送到远程仓库 (${remoteUrl})`
        })
      }

      setPreviewCommands(commands)
      setShowCommandPreview(true)
      setConfirmedCommands(new Set()) // 重置确认状态
    } catch (error) {
      console.error("无法生成命令预览:", error)
      setExecutionResult({ success: false, output: "无法生成命令预览" })
    }
  }

  // useEffect(() => {
  //   generateCommandPreview()
  // }, [commitMessage, cardNumber, gitRepoPath])

  const executeGitCommands = async () => {
    setIsExecuting(true)
    setExecutionResult(null)

    // 使用预览时获取的仓库路径，或者重新获取
    // let gitRepoPath = workspacePath
    const commands = [
      `git -C "${gitRepoPath}" add .`,
      `git -C "${gitRepoPath}" commit -m "${cardNumber.trim()} #comment fix: ${commitMessage.trim()} #CMBDevClaw"`,
      hasRemote ? `git -C "${gitRepoPath}" push` : null
    ].filter(Boolean) as string[]

    try {
      let commitHash = ""

      for (let i = 0; i < commands.length; i++) {
        setCurrentStep(i)
        try {
          const result = await window.electron.ipcRenderer.invoke(
            "execute-git-command",
            commands[i]
          )
          console.log(`Git命令执行成功: ${commands[i]}`, result)

          // 如果是commit命令，尝试获取commit hash
          if (i === 1 && result) {
            try {
              const hashResult = await window.electron.ipcRenderer.invoke(
                "execute-git-command",
                `git -C "${gitRepoPath}" rev-parse HEAD`
              )
              if (hashResult && typeof hashResult === "string") {
                commitHash = hashResult.trim().substring(0, 7) // 取前7位
              }
            } catch (hashError) {
              console.warn("Failed to get commit hash:", hashError)
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          setExecutionResult({ success: false, output: errorMessage })
          console.error(`Git命令执行失败: ${commands[i]}`, error)
          return // 停止执行后续命令
        }
      }

      setExecutionResult({ success: true, output: "所有Git命令执行成功" })

      // 记录提交信息
      GitCommitTracker.recordCommit(
        currentOperationId,
        "all_files", // 使用 "all_files" 代替具体文件路径
        operation,
        commitMessage.trim(),
        cardNumber.trim(),
        commitHash
      )

      // ─── 上报本次提交数据 ──────────────────────────────────────────────────
      try {
        await uploadCommitData(currentOperationId, {
          remoteUrl: remoteUrl || "",
          branch: branch || "",
          commitMessage: commitMessage.trim(),
          changedFiles: changedFiles.map((f) => f.path),
          workspacePath: gitRepoPath,
          commands,
          commitHash
        })
      } catch (uploadError) {
        console.warn("[Upload] 提交数据上报失败:", uploadError)
      }
      // ──────────────────────────────────────────────────────────────────────

      // 更新状态
      setIsCurrentOperationCommitted(true)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error("执行Git命令时发生错误:", error)
      setExecutionResult({
        success: false,
        output: errorMessage
      })

      // 通知Git工具操作失败（如果有operationId）
      if (operationId && operationId.startsWith('git_workflow_')) {
        try {
          await window.electron.ipcRenderer.invoke(
            "complete-git-workflow",
            operationId,
            false,
            `执行Git命令时发生错误: ${errorMessage}`
          )
          console.log('通知Git工具操作失败:', operationId, errorMessage)
        } catch (notifyError) {
          console.warn('通知Git工具失败:', notifyError)
        }
      }
    } finally {
      setIsExecuting(false)
      setCurrentStep(0)
    }
  }

  // 如果当前操作已提交，显示已提交状态
  if (isCurrentOperationCommitted) {
    // 获取当前操作的提交记录
    const currentRecord = GitCommitTracker.getOperationCommitRecord(currentOperationId)

    if (currentRecord) {
      return (
        <div className="flex items-start gap-2 p-2 bg-green-50/90 dark:bg-green-950/90 border border-green-200 dark:border-green-800 rounded">
          <Check className="size-4 text-green-600 dark:text-green-400 mt-0.5" />
          <div className="flex-1 text-xs">
            <div className="font-medium text-green-800 dark:text-green-200">本次操作已提交到Git</div>
            <div className="text-green-700 dark:text-green-300 mt-1 space-y-1">
              <div className="flex items-center gap-2">
                <GitBranch className="size-3" />
                <span>分支: <span className="font-mono font-medium">{branch || "unknown"}</span></span>
              </div>
              <div className="flex items-center gap-2">
                <FileText className="size-3" />
                <span>修改文件: <span className="font-medium">{changedFiles.length} 个</span></span>
              </div>
              <div>提交信息: {currentRecord.commitMessage}</div>
              {currentRecord.cardNumber && (
                <div>卡片编号: {currentRecord.cardNumber}</div>
              )}
              {currentRecord.commitHash && (
                <div className="font-mono">提交哈希: {currentRecord.commitHash}</div>
              )}
              <div className="flex items-center gap-1">
                <Clock className="size-3" />
                <span>{new Date(currentRecord.timestamp).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>
      )
    }
  }

  // 如果没有文件改动，提示用户无需提交
  if (!isCurrentOperationCommitted && changedFiles.length === 0) {
    return (
      <div className="flex items-start gap-2 p-2 bg-muted/50 border border-border rounded">
        <Check className="size-4 text-muted-foreground mt-0.5" />
        <div className="flex-1 text-xs">
          <div className="font-medium text-muted-foreground">没有文件改动，无需提交</div>
          <div className="text-muted-foreground/70 mt-1">当前没有检测到任何文件变更，无需执行 Git 提交操作。</div>
        </div>
      </div>
    )
  }

  if (!showGitOptions) {
    return (
      <div className="flex items-start gap-2 p-2 bg-blue-50/90 dark:bg-blue-950/90 border border-blue-200 dark:border-blue-800 rounded">
        <GitBranch className="size-4 text-blue-600 dark:text-blue-400 mt-0.5" />
        <div className="flex-1 text-xs">
          <div className="font-medium text-blue-800 dark:text-blue-200">
            文件已{operation === "edit_file" ? "修改" : "创建"}
          </div>
          <div className="text-blue-700 dark:text-blue-300 mt-1">是否要提交到Git？</div>

          {/* 显示文件历史提交信息（如果有的话） */}
          {hasFileCommitHistory && latestCommitRecord && (
            <div className="text-blue-600 dark:text-blue-400 mt-1 text-[10px]">
              💡 此文件已有提交记录: {latestCommitRecord.commitMessage}
              ({new Date(latestCommitRecord.timestamp).toLocaleString()})
            </div>
          )}

          <div className="flex gap-2 mt-2">
            <button
              onClick={handleShowGitOptions}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              <GitBranch className="size-3" />
              提交到Git
            </button>
            {/*<button*/}
            {/*  onClick={() => {*/}
            {/*    // 通知Git工具用户跳过了操作*/}
            {/*    if (onSkip) {*/}
            {/*      onSkip()*/}
            {/*    }*/}
            {/*  }}*/}
            {/*  className="px-2 py-1 text-xs border border-blue-200 dark:border-blue-700 rounded hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors"*/}
            {/*>*/}
            {/*  暂时跳过*/}
            {/*</button>*/}
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
            所有文件
          </Badge>
        </div>

        {/* 修改文件列表 */}
        {changedFiles && changedFiles.length > 0 && (
          <div className="space-y-2">
            <button
              onClick={() => setShowChangedFiles(!showChangedFiles)}
              className="flex my-4 items-center text-sm gap-2 text font-medium text-status-info hover:text-status-info/80 transition-colors"
            >
              {showChangedFiles ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
              <FileText className="size-4" />
              修改的文件 ({changedFiles.length})
            </button>

            {showChangedFiles && (
              <div className="space-y-4 pl-4 border-l border-border/50">
                {changedFiles.map((file, index) => (
                  <div key={index} className="space-y-1 px-3 py-2  border border-border/30 rounded-md bg-background/30">
                    {/* 文件头部信息 */}
                    <div className="flex  justify-between text-xs border-b border-border/20">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium text-foreground">{file.path}</span>
                        {/*<Badge*/}
                        {/*  variant={file.status === 'added' ? 'nominal' : file.status === 'deleted' ? 'critical' : 'outline'}*/}
                        {/*  className="text"*/}
                        {/*>*/}
                        {/*  {file.status}*/}
                        {/*</Badge>*/}
                      </div>

                      {/* 文件变更详情按钮 */}
                      {(file.oldContent !== undefined || file.newContent !== undefined || file.diff) && (
                        <button
                          onClick={() => toggleDiffExpansion(index)}
                          className=" ml-4 w-[100px] flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                          变更详情

                          {expandedDiffs.has(index) ? (
                            <ChevronDown className="size-3" />
                          ) : (
                            <ChevronRight className="size-3" />
                          )}

                        </button>
                      )}
                    </div>

                    {/* 文件内容差异显示 */}
                    {(file.oldContent !== undefined || file.newContent !== undefined || file.diff) ? (
                      <div className="space-y-2">
                        {expandedDiffs.has(index) && (
                          <div className="rounded border border-border/30 overflow-hidden">
                            <DiffDisplay
                              diff={file.diff}
                              oldValue={file.oldContent}
                              newValue={file.newContent}
                            />
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="text-xs text-muted-foreground italic py-2">
                          文件变更检测中 - 差异信息暂时不可用
                        </div>
                        <div className="text-xs text-muted-foreground bg-background/50 p-2 rounded border border-border/20">
                          💡 这通常发生在：
                          <ul className="mt-1 ml-4 list-disc space-y-1">
                            <li>新创建的文件</li>
                            <li>二进制文件</li>
                            <li>文件路径包含特殊字符</li>
                            <li>Git状态解析问题</li>
                          </ul>
                          <div className="mt-2 text-xs">
                            文件路径: <code className="bg-muted px-1 rounded text-foreground">{file.path}</code>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Git仓库状态信息 - 使用props传入的信息 */}
        <div className="grid grid-cols-1 gap-2 text-xs bg-background/50 p-2 rounded border">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">分支:</span>
            <Badge variant="secondary" className="text-xs font-mono">
              {branch || "unknown"}
            </Badge>
            {isBranchConfirmed ? (
              <button
                onClick={() => setIsBranchConfirmed(false)}
                disabled={isExecuting}
                className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border bg-status-nominal text-background border-status-nominal hover:bg-status-nominal/80 transition-colors"
              >
                <Check className="size-3" />
                分支已确认
              </button>
            ) : (
              <button
                onClick={() => setIsBranchConfirmed(true)}
                disabled={isExecuting}
                className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-amber-400 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors"
              >
                <div className="size-3 rounded border border-current" />
                确认分支
              </button>
            )}
          </div>

          {hasRemote ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">远程:</span>
              <span className="font-mono text-xs truncate">{remoteUrl}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">远程:</span>
              <Badge variant="warning" className="text-xs">
                未配置远程仓库
              </Badge>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">仓库:</span>
            <span className="font-mono text-xs truncate">{gitRepoPath}</span>
          </div>
        </div>


      </div>

      {/* 提交信息编辑 */}
      <div className="space-y-2 ">
        <div className="text-xs font-medium"><span className={'text-red-500'}>*</span> 提交信息:</div>
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          disabled={isExecuting || showCommandPreview}
          placeholder="请输入提交信息..."
          className="w-full p-2 text-xs border border-border rounded resize-none"
          rows={2}
        />
      </div>

      {/* 卡片编号 */}
      <div className="space-y-2 ">
        <div className="text-xs font-medium"><span className={'text-red-500'}>*</span> 卡片编号:</div>
        <input
          type="text"
          value={cardNumber}
          onChange={(e) => setCardNumber(e.target.value)}
          disabled={isExecuting || showCommandPreview}
          placeholder="请输入卡片编号， 案例：Z998877-12345"
          className="w-full p-2 text-xs border border-border rounded"
        />
      </div>

      {/* 命令预览按钮和显示区域 */}
      <div className="space-y-2">
        {showCommandPreview &&  previewCommands.length > 0 && (
          <div className="bg-background/50 border border-border rounded p-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">即将执行的Git命令（请逐条确认无误）:</div>
            <div className="space-y-2">
              {previewCommands.map((cmd, index) => {
                const isConfirmed = confirmedCommands.has(index)
                return (
                  <div key={index} className={cn(
                    "space-y-1 border rounded p-2 transition-colors",
                    isConfirmed
                      ? "border-status-nominal/40 bg-status-nominal/5"
                      : "border-border"
                  )}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-foreground">
                        {index + 1}. {cmd.description}
                      </div>
                      <button
                        onClick={() => {
                          setConfirmedCommands(prev => {
                            const next = new Set(prev)
                            if (next.has(index)) {
                              next.delete(index)
                            } else {
                              next.add(index)
                            }
                            return next
                          })
                        }}
                        disabled={isExecuting}
                        className={cn(
                          "flex items-center gap-1 px-2 py-0.5 text-xs rounded border transition-colors shrink-0",
                          isConfirmed
                            ? "bg-status-nominal text-background border-status-nominal hover:bg-status-nominal/80"
                            : "border-border hover:bg-background-interactive"
                        )}
                      >
                        {isConfirmed ? <Check className="size-3" /> : <div className="size-3 rounded border border-current" />}
                        {isConfirmed ? "已确认" : "确认"}
                      </button>
                    </div>
                    <div className="bg-muted p-2 rounded">
                      <code className="text-xs font-mono text-foreground break-all">
                        {cmd.command}
                      </code>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              {confirmedCommands.size < previewCommands.length
                ? `💡 还需确认 ${previewCommands.length - confirmedCommands.size} 条命令后才能提交`
                : "✅ 所有命令已确认，可以点击【确认提交】执行"}
            </div>
          </div>
        )}
      </div>

      {/* 执行步骤显示 */}
      {(isExecuting || executionResult) && (
        <div className="space-y-2">
          <div className="text-xs font-medium">执行进度:</div>
          <div className="space-y-1">
            {[
              {
                step: 0,
                label: "添加所有文件到暂存区",
                command: "git add .",
                info: "将所有修改的文件添加到暂存区"
              },
              {
                step: 1,
                label: "提交更改",
                command: `git commit -m "${commitMessage.trim()}"`,
                info: `分支: ${branch || "unknown"} | 信息: ${commitMessage.trim()}`
              },
              ...(hasRemote
                ? [
                    {
                      step: 2,
                      label: "推送到远程仓库",
                      command: "git push",
                      info: `推送到 ${
                        remoteUrl
                          ? remoteUrl.split("/").pop()?.replace(".git", "")
                          : "origin"
                      } / ${branch || "main"}`
                    }
                  ]
                : [])
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
                    <Badge variant="outline" className="animate-pulse">
                      执行中
                    </Badge>
                  )}
                  {currentStep > step && <Badge variant="nominal">完成</Badge>}
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
              {executionResult.success ? <Check className="size-3" /> : <X className="size-3" />}
              {executionResult.success ? "Git提交成功" : "Git提交失败"}
            </div>
            {executionResult.output && (
              <pre className="mt-1 text-xs whitespace-pre-wrap">{executionResult.output}</pre>
            )}
            {executionResult.success && (
              <div className="mt-2 text-[10px] text-status-nominal/70">
                ✓ 所有文件已添加到Git历史记录
                {hasRemote && " ✓ 更改已推送到远程仓库"}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        {
          !showCommandPreview &&  <button
            onClick={generateCommandPreview}
            disabled={
              isExecuting ||
              !commitMessage.trim() ||
              !cardNumber.trim() ||
              !isBranchConfirmed ||
              executionResult?.success === true
            }
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-status-nominal text-background rounded hover:bg-status-nominal/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <CheckCircle className="size-3" />
            编辑完成
          </button>
        }

        {showCommandPreview &&  <button
          onClick={executeGitCommands}
          disabled={
            isExecuting ||
            !commitMessage.trim() ||
            !cardNumber.trim() ||
            !showCommandPreview ||
            previewCommands.length === 0 ||
            confirmedCommands.size < previewCommands.length ||
            executionResult?.success === true
          }
          className="flex items-center gap-1 px-3 py-1.5 text-xs bg-status-nominal text-background rounded hover:bg-status-nominal/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Play className="size-3" />
          {isExecuting ? "提交中..." : executionResult?.success ? "已提交" : "确认提交"}
        </button>}

        <button
          onClick={handleHideGitOptions}
          disabled={isExecuting}
          className="px-3 py-1.5 text-xs border border-border rounded hover:bg-background-interactive disabled:opacity-50 transition-colors"
        >
          {executionResult ? "关闭" : "取消"}
        </button>

        {!hasRemote && (
          <span className="text-xs text-amber-600">⚠️ 仅本地提交 (无远程仓库)</span>
        )}

        {!isBranchConfirmed && (
          <span className="text-xs text-amber-600">⚠️ 请先核对分支</span>
        )}

        {showCommandPreview && confirmedCommands.size < previewCommands.length && (
          <span className="text-xs text-blue-600">💡 请逐条确认所有Git命令后再提交</span>
        )}
      </div>
    </div>
  )
}
