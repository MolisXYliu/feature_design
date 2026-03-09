import { useState, useEffect } from "react"
import { Terminal, Play, Edit, Check, X, AlertTriangle, GitBranch, FileText } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

interface GitCommitDialogProps {
  isOpen: boolean
  onClose: () => void
  changedFiles: string[]
  suggestedCommitMessage?: string
  onConfirm: (commands: string[]) => Promise<void>
}

interface GitCommandStep {
  command: string
  description: string
  type: 'add' | 'commit' | 'push'
}

export function GitCommitDialog({
  isOpen,
  onClose,
  changedFiles,
  suggestedCommitMessage,
  onConfirm
}: GitCommitDialogProps) {
  const [commitMessage, setCommitMessage] = useState(suggestedCommitMessage || "")
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [executionResults, setExecutionResults] = useState<Array<{ success: boolean; output?: string }>>([])
  const [customCommands, setCustomCommands] = useState<string[]>([])
  const [editingCommand, setEditingCommand] = useState<number | null>(null)
  const [editValue, setEditValue] = useState("")

  useEffect(() => {
    if (isOpen) {
      setSelectedFiles(changedFiles)
      setCommitMessage(suggestedCommitMessage || `更新文件: ${changedFiles.slice(0, 3).join(', ')}${changedFiles.length > 3 ? '等' : ''}`)
      setCurrentStep(0)
      setExecutionResults([])
      generateCommands()
    }
  }, [isOpen, changedFiles, suggestedCommitMessage])

  const generateCommands = () => {
    const commands: string[] = []

    // 添加文件到暂存区
    if (selectedFiles.length > 0) {
      commands.push(`git add ${selectedFiles.map((f) => `"${f}"`).join(" ")}`)
    }

    // 提交
    if (commitMessage.trim()) {
      commands.push(`git commit -m "${commitMessage.trim()}"`)
    }

    // 推送到远程
    commands.push("git push")

    setCustomCommands(commands)
  }

  useEffect(() => {
    generateCommands()
  }, [selectedFiles, commitMessage])

  const gitSteps: GitCommandStep[] = [
    { command: customCommands[0] || "", description: "添加文件到暂存区", type: 'add' },
    { command: customCommands[1] || "", description: "提交更改", type: 'commit' },
    { command: customCommands[2] || "", description: "推送到远程仓库", type: 'push' }
  ]

  const handleFileToggle = (file: string) => {
    setSelectedFiles(prev =>
      prev.includes(file)
        ? prev.filter(f => f !== file)
        : [...prev, file]
    )
  }

  const handleEditCommand = (index: number) => {
    setEditingCommand(index)
    setEditValue(customCommands[index])
  }

  const handleSaveCommand = () => {
    if (editingCommand !== null) {
      const newCommands = [...customCommands]
      newCommands[editingCommand] = editValue
      setCustomCommands(newCommands)
      setEditingCommand(null)
      setEditValue("")
    }
  }

  const handleCancelEdit = () => {
    setEditingCommand(null)
    setEditValue("")
  }

  const executeCommands = async () => {
    setIsExecuting(true)
    const results: Array<{ success: boolean; output?: string }> = []

    try {
      for (let i = 0; i < customCommands.length; i++) {
        const command = customCommands[i]
        if (!command.trim()) continue

        setCurrentStep(i)

        try {
          const result = await window.electron.ipcRenderer.invoke('execute-git-command', command)
          results.push({ success: true, output: result })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          results.push({ success: false, output: errorMessage })
          break // 停止执行后续命令
        }
      }

      setExecutionResults(results)

      // 如果所有命令都成功执行，调用确认回调
      if (results.every(r => r.success)) {
        await onConfirm(customCommands)
      }
    } catch (error) {
      console.error('执行Git命令时发生错误:', error)
    } finally {
      setIsExecuting(false)
      setCurrentStep(0)
    }
  }

  const handleClose = () => {
    if (!isExecuting) {
      onClose()
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
      <div className="bg-background border border-border rounded-lg shadow-lg w-[600px] max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <GitBranch className="size-5 text-status-info" />
            <h2 className="text-sm font-medium">Git 提交确认</h2>
          </div>
          <button
            onClick={handleClose}
            disabled={isExecuting}
            className="p-1 hover:bg-background-interactive rounded disabled:opacity-50"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="p-4 max-h-[calc(80vh-120px)] overflow-y-auto">
          {/* 警告信息 */}
          <div className="flex items-start gap-2 p-3 bg-amber-50/90 dark:bg-amber-950/90 border border-amber-200 dark:border-amber-800 rounded mb-4">
            <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div className="text-xs">
              <div className="font-medium text-amber-800 dark:text-amber-200">
                检测到 {changedFiles.length} 个文件发生变更
              </div>
              <div className="text-amber-700 dark:text-amber-300">
                请确认要提交的文件和提交信息
              </div>
            </div>
          </div>

          {/* 文件列表 */}
          <div className="mb-4">
            <div className="text-xs font-medium mb-2">要提交的文件:</div>
            <div className="space-y-1 max-h-32 overflow-y-auto border border-border rounded p-2">
              {changedFiles.map((file) => (
                <label key={file} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-background-interactive p-1 rounded">
                  <input
                    type="checkbox"
                    checked={selectedFiles.includes(file)}
                    onChange={() => handleFileToggle(file)}
                    disabled={isExecuting}
                    className="rounded"
                  />
                  <FileText className="size-3 text-muted-foreground" />
                  <span className="font-mono truncate">{file}</span>
                </label>
              ))}
            </div>
          </div>

          {/* 提交信息 */}
          <div className="mb-4">
            <div className="text-xs font-medium mb-2">提交信息:</div>
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              disabled={isExecuting}
              placeholder="请输入提交信息..."
              className="w-full p-2 text-xs border border-border rounded resize-none"
              rows={3}
            />
          </div>

          {/* Git 命令预览 */}
          <div className="space-y-3">
            <div className="text-xs font-medium">将要执行的命令:</div>
            {gitSteps.map((step, index) => (
              <div
                key={index}
                className={cn(
                  "border border-border rounded-sm bg-background-elevated",
                  isExecuting && currentStep === index && "ring-2 ring-status-info/50",
                  executionResults[index] && (executionResults[index].success ? "border-status-nominal/50" : "border-status-critical/50")
                )}
              >
                {/* 命令头部 */}
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-background/50">
                  <Terminal className="size-3 text-status-info" />
                  <span className="text-xs font-medium">{step.description}</span>

                  {executionResults[index] && (
                    <Badge
                      variant={executionResults[index].success ? "nominal" : "critical"}
                      className="ml-auto"
                    >
                      {executionResults[index].success ? "成功" : "失败"}
                    </Badge>
                  )}

                  {isExecuting && currentStep === index && (
                    <Badge variant="outline" className="ml-auto animate-pulse">
                      执行中
                    </Badge>
                  )}
                </div>

                {/* 命令内容 */}
                <div className="p-3 space-y-2">
                  {editingCommand === index ? (
                    <div className="space-y-2">
                      <textarea
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="w-full p-2 text-xs font-mono bg-background border border-border rounded resize-none"
                        rows={Math.max(1, editValue.split('\n').length)}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleSaveCommand}
                          className="flex items-center gap-1 px-2 py-1 text-xs bg-status-nominal text-background rounded hover:bg-status-nominal/90"
                        >
                          <Check className="size-3" />
                          保存
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          className="flex items-center gap-1 px-2 py-1 text-xs border border-border rounded hover:bg-background-interactive"
                        >
                          <X className="size-3" />
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="font-mono text-xs bg-background p-2 rounded border border-border">
                        <div className="flex items-start gap-2">
                          <span className="text-status-info shrink-0">$</span>
                          <pre className="whitespace-pre-wrap break-all">{step.command}</pre>
                        </div>
                      </div>

                      {!isExecuting && (
                        <div className="flex justify-end">
                          <button
                            onClick={() => handleEditCommand(index)}
                            className="flex items-center gap-1 px-2 py-1 text-xs border border-border rounded hover:bg-background-interactive"
                          >
                            <Edit className="size-3" />
                            编辑
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {/* 执行结果 */}
                  {executionResults[index] && executionResults[index].output && (
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">执行结果:</div>
                      <pre
                        className={cn(
                          "text-xs font-mono p-2 rounded border overflow-auto max-h-24 whitespace-pre-wrap",
                          executionResults[index].success
                            ? "bg-status-nominal/10 border-status-nominal/20 text-status-nominal"
                            : "bg-status-critical/10 border-status-critical/20 text-status-critical"
                        )}
                      >
                        {executionResults[index].output}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={handleClose}
            disabled={isExecuting}
            className="px-3 py-1.5 text-xs border border-border rounded hover:bg-background-interactive disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={executeCommands}
            disabled={isExecuting || selectedFiles.length === 0 || !commitMessage.trim()}
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-status-nominal text-background rounded hover:bg-status-nominal/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="size-3" />
            {isExecuting ? "执行中..." : "确认提交"}
          </button>
        </div>
      </div>
    </div>
  )
}
