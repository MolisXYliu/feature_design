import { useState, useCallback, useEffect } from "react"
import { GitCommitDialog } from "./GitCommitDialog"
import { useGitDetector } from "./useGitDetector"
import { GitBranch, AlertCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"

interface GitCommitManagerProps {
  // 触发条件配置
  triggerOnFileChange?: boolean
  triggerOnFileCount?: number // 当文件变更数量达到这个值时触发
  autoTriggerDelay?: number // 文件变更后延迟多久自动触发（毫秒）

  // 回调函数
  onCommitSuccess?: (commands: string[]) => void
  onCommitError?: (error: Error) => void
}

export function GitCommitManager({
  triggerOnFileChange = true,
  triggerOnFileCount = 3,
  autoTriggerDelay = 10000, // 10秒延迟
  onCommitSuccess,
  onCommitError
}: GitCommitManagerProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [lastChangedFiles, setLastChangedFiles] = useState<string[]>([])
  const [autoTriggerTimeout, setAutoTriggerTimeout] = useState<NodeJS.Timeout | null>(null)
  const [shouldShowPrompt, setShouldShowPrompt] = useState(false)

  // 检测到变更时的处理
  const handleChangesDetected = useCallback((status: any) => {
    const allFiles = [...status.changedFiles, ...status.untrackedFiles]

    // 如果文件列表没有变化，不做处理
    if (JSON.stringify(allFiles.sort()) === JSON.stringify(lastChangedFiles.sort())) {
      return
    }

    setLastChangedFiles(allFiles)

    // 清除之前的延迟触发
    if (autoTriggerTimeout) {
      clearTimeout(autoTriggerTimeout)
    }

    // 判断是否应该触发确认对话框
    const shouldTrigger =
      triggerOnFileChange &&
      allFiles.length > 0 &&
      (triggerOnFileCount ? allFiles.length >= triggerOnFileCount : true)

    if (shouldTrigger) {
      // 显示提示
      setShouldShowPrompt(true)

      // 设置延迟自动触发
      const timeout = setTimeout(() => {
        setIsDialogOpen(true)
        setShouldShowPrompt(false)
      }, autoTriggerDelay)

      setAutoTriggerTimeout(timeout)
    }
  }, [lastChangedFiles, triggerOnFileChange, triggerOnFileCount, autoTriggerDelay, autoTriggerTimeout])

  const { gitStatus, isChecking, hasChanges, allChangedFiles } = useGitDetector({
    autoDetect: true,
    checkInterval: 5000,
    onChangesDetected: handleChangesDetected
  })

  // 生成智能提交信息
  const generateCommitMessage = useCallback((files: string[]) => {
    if (files.length === 0) return ""

    // 分析文件类型
    const fileTypes = {
      docs: files.filter(f => f.match(/\.(md|txt|rst|doc)$/i)),
      code: files.filter(f => f.match(/\.(js|ts|jsx|tsx|py|java|cpp|c|go|rs)$/i)),
      config: files.filter(f => f.match(/\.(json|yaml|yml|toml|ini|env)$/i)),
      styles: files.filter(f => f.match(/\.(css|scss|sass|less|styl)$/i)),
      other: files.filter(f => !f.match(/\.(md|txt|rst|doc|js|ts|jsx|tsx|py|java|cpp|c|go|rs|json|yaml|yml|toml|ini|env|css|scss|sass|less|styl)$/i))
    }

    // 生成描述性的提交信息
    const descriptions = []
    if (fileTypes.docs.length > 0) descriptions.push(`更新文档(${fileTypes.docs.length}个)`)
    if (fileTypes.code.length > 0) descriptions.push(`修改代码(${fileTypes.code.length}个)`)
    if (fileTypes.config.length > 0) descriptions.push(`调整配置(${fileTypes.config.length}个)`)
    if (fileTypes.styles.length > 0) descriptions.push(`更新样式(${fileTypes.styles.length}个)`)
    if (fileTypes.other.length > 0) descriptions.push(`其他文件(${fileTypes.other.length}个)`)

    if (descriptions.length === 0) {
      return `更新 ${files.length} 个文件`
    }

    return descriptions.join(', ')
  }, [])

  // 手动触发Git提交对话框
  const triggerCommitDialog = useCallback(() => {
    if (allChangedFiles.length > 0) {
      setIsDialogOpen(true)
      setShouldShowPrompt(false)
      if (autoTriggerTimeout) {
        clearTimeout(autoTriggerTimeout)
        setAutoTriggerTimeout(null)
      }
    }
  }, [allChangedFiles, autoTriggerTimeout])

  // 关闭对话框
  const closeDialog = useCallback(() => {
    setIsDialogOpen(false)
  }, [])

  // 确认提交
  const handleCommitConfirm = useCallback(async (commands: string[]) => {
    try {
      setIsDialogOpen(false)
      onCommitSuccess?.(commands)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      onCommitError?.(err)
    }
  }, [onCommitSuccess, onCommitError])

  // 忽略当前提示
  const ignoreCurrentPrompt = useCallback(() => {
    setShouldShowPrompt(false)
    if (autoTriggerTimeout) {
      clearTimeout(autoTriggerTimeout)
      setAutoTriggerTimeout(null)
    }
  }, [autoTriggerTimeout])

  // 清理effect
  useEffect(() => {
    return () => {
      if (autoTriggerTimeout) {
        clearTimeout(autoTriggerTimeout)
      }
    }
  }, [autoTriggerTimeout])

  return (
    <>
      {/* 状态指示器 - 显示在界面角落 */}
      {hasChanges && (
        <div className="fixed bottom-4 right-4 z-40">
          {shouldShowPrompt ? (
            // 提示即将自动触发
            <div className="bg-amber-500 text-white p-3 rounded-lg shadow-lg border border-amber-600 min-w-64">
              <div className="flex items-start gap-2">
                <AlertCircle className="size-4 mt-0.5" />
                <div className="flex-1 text-xs">
                  <div className="font-medium">检测到 {allChangedFiles.length} 个文件变更</div>
                  <div className="mt-1 opacity-90">将在 {autoTriggerDelay / 1000} 秒后弹出Git提交确认</div>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={triggerCommitDialog}
                      className="px-2 py-1 bg-white text-amber-700 rounded text-xs hover:bg-amber-50"
                    >
                      立即提交
                    </button>
                    <button
                      onClick={ignoreCurrentPrompt}
                      className="px-2 py-1 bg-amber-600 text-white rounded text-xs hover:bg-amber-700"
                    >
                      忽略
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            // 普通状态指示器
            <button
              onClick={triggerCommitDialog}
              className="bg-status-info text-white p-3 rounded-lg shadow-lg hover:bg-status-info/90 transition-colors"
            >
              <div className="flex items-center gap-2">
                <GitBranch className="size-4" />
                <div className="text-xs">
                  <div className="font-medium">{allChangedFiles.length} 个文件待提交</div>
                  <div className="opacity-90">点击提交到Git</div>
                </div>
              </div>
            </button>
          )}
        </div>
      )}

      {/* Git提交对话框 */}
      <GitCommitDialog
        isOpen={isDialogOpen}
        onClose={closeDialog}
        changedFiles={allChangedFiles}
        suggestedCommitMessage={generateCommitMessage(allChangedFiles)}
        onConfirm={handleCommitConfirm}
      />
    </>
  )
}
