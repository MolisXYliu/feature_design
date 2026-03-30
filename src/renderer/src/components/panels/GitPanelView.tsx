import { useState, useRef, useCallback, useEffect } from "react"
import {
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  Clock,
  XCircle,
  Loader2,
  AlertCircle,
  RotateCcw,
  Upload
} from "lucide-react"
import { cn } from "@/lib/utils"
import { DiffDisplay } from "@/components/chat/ToolCallRenderer"

export function GitPanelView({
  threadId,
  workspacePath
}: {
  threadId: string
  workspacePath: string | null
}): React.JSX.Element {
  const AUTO_PUSH_SUCCESS_MESSAGE = "已自动提交并推送成功（代码已写入当前 worktree 目录）"

  type PushStep = {
    step: "pull" | "commit" | "push" | "verify" | "final"
    status: "ok" | "failed" | "skipped"
    detail: string
  }

  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<"commit" | "push" | "reject" | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pushSteps, setPushSteps] = useState<PushStep[]>([])
  const [cardNumber, setCardNumber] = useState("")
  const [commitMessage, setCommitMessage] = useState("")
  const [expandedFilePath, setExpandedFilePath] = useState<string | null>(null)
  const [revertingFilePath, setRevertingFilePath] = useState<string | null>(null)
  const prevHasPendingRef = useRef<boolean | null>(null)
  const [state, setState] = useState<{
    success: boolean
    isWorktree: boolean
    taskId: string
    files: Array<{ path: string; diff: string; additions: number; deletions: number }>
    totals: { additions: number; deletions: number; fileCount: number }
    hasPendingDiff: boolean
    suggestedCommitMessage?: string
    error?: string
  } | null>(null)

  const refresh = useCallback(async () => {
    if (!threadId) return
    setLoading(true)
    try {
      const next = await window.api.workspace.getGitPanelState(threadId)
      setState(next)
      if (next.suggestedCommitMessage) {
        setCommitMessage((prev) => prev || next.suggestedCommitMessage || "")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [threadId])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const files = state?.files ?? []
    if (files.length === 0) {
      setExpandedFilePath(null)
      return
    }
    if (!expandedFilePath || !files.some((f) => f.path === expandedFilePath)) {
      setExpandedFilePath(files[0].path)
    }
  }, [state?.files, expandedFilePath])

  useEffect(() => {
    if (!threadId) return
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = window.api.workspace.onFilesChanged((data) => {
      if (data.threadId !== threadId) return
      if (refreshTimer) clearTimeout(refreshTimer)
      // Coalesce rapid file watcher events from a single edit/save.
      refreshTimer = setTimeout(() => {
        refresh()
      }, 120)
    })
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      cleanup()
    }
  }, [threadId, refresh])

  const runAction = useCallback(
    async (action: "commit" | "push" | "reject") => {
      if (!threadId) return
      const formattedCommitMessage = `${cardNumber.trim()} #comment fix:${commitMessage.trim()} #CMBDevClaw`
      if ((action === "commit" || action === "push") && !cardNumber.trim()) {
        setError("cardNumber 不能为空")
        return
      }
      if ((action === "commit" || action === "push") && !commitMessage.trim()) {
        setError("commitMessage 不能为空")
        return
      }
      setRunning(action)
      setError(null)
      setMessage(null)
      setPushSteps([])
      try {
        if (action === "commit") {
          const result = await window.api.workspace.commitWorktree(threadId, formattedCommitMessage)
          if (!result.success) throw new Error(result.error || "提交失败")
          setMessage("提交成功")
          setCardNumber("")
          setCommitMessage("")
        } else if (action === "push") {
          const result = await window.api.workspace.pushWorktree(threadId, formattedCommitMessage)
          setPushSteps(result.steps || [])
          if (!result.success) throw new Error(result.error || "推送失败")
          setMessage(
            result.autoCommitted
              ? AUTO_PUSH_SUCCESS_MESSAGE
              : "推送成功（代码位于当前 worktree 目录）"
          )
          setCardNumber("")
          setCommitMessage("")
        } else {
          const result = await window.api.workspace.rejectWorktreeChanges(threadId)
          if (!result.success) throw new Error(result.error || "回滚失败")
          setMessage("已全部回退到上一版编辑内容")
        }
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "操作失败")
      } finally {
        setRunning(null)
      }
    },
    [threadId, cardNumber, commitMessage, refresh]
  )

  const handleRevertFile = useCallback(
    async (filePath: string) => {
      if (!threadId) return
      setRevertingFilePath(filePath)
      setError(null)
      setMessage(null)
      try {
        const result = await window.api.workspace.rejectWorktreeFile(threadId, filePath)
        if (!result.success) throw new Error(result.error || "文件回退失败")
        setMessage(`已回退文件：${filePath}`)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "文件回退失败")
      } finally {
        setRevertingFilePath(null)
      }
    },
    [threadId, refresh]
  )

  const hasPending = Boolean(state?.hasPendingDiff)

  useEffect(() => {
    const prev = prevHasPendingRef.current
    prevHasPendingRef.current = hasPending
    if (prev === null) return
    // Only clear previous push result cards when diff re-appears after being clean.
    if (!(prev === false && hasPending === true)) return
    if (message === AUTO_PUSH_SUCCESS_MESSAGE) {
      setMessage(null)
    }
    if (pushSteps.length > 0) {
      setPushSteps([])
    }
  }, [hasPending, message, pushSteps.length])

  return (
    <div className="rounded-xl border border-border/70 overflow-hidden bg-background flex flex-col min-h-0 h-full">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-3 py-2 border-b border-border/70 bg-background-elevated/70 shrink-0">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold truncate">Git 操作</div>
          <div className="text-[10px] text-muted-foreground truncate">
            task_id: {threadId || "-"}
          </div>
        </div>
        <button
          onClick={() => runAction("reject")}
          disabled={!hasPending || running !== null}
          className="inline-flex items-center gap-1 rounded-md border border-destructive/50 text-destructive px-2 py-1 text-[11px] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-destructive/10 transition-colors"
        >
          <RotateCcw className="size-3.5" />
          {running === "reject" ? "全部回退中..." : "全部回退"}
        </button>
      </div>

      <div className="overflow-y-auto overflow-x-hidden right-panel-scroll bg-background flex-1 min-h-0 p-3 space-y-3">
        {loading && <div className="text-xs text-muted-foreground">正在加载 Git diff...</div>}
        {!loading && (error || state?.error) && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
            <span>{error || state?.error}</span>
          </div>
        )}
        {!loading && state && !state.isWorktree && (
          <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
            当前任务未绑定 worktree。请先在工作区选择器创建并切换到 worktree。
          </div>
        )}
        {!loading && state?.isWorktree && (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{workspacePath || "未关联路径"}</span>
              <span>•</span>
              <span>
                {state.totals.fileCount} files, +{state.totals.additions} / -{state.totals.deletions}
              </span>
            </div>
            {state.files.length === 0 ? (
              <div className="rounded-md border border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
                当前没有待审批的 LLM 改动。
              </div>
            ) : (
              <>
                {state.files.map((file) => (
                  <div key={file.path} className="rounded-md border border-border/70 p-2 bg-background">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedFilePath((prev) => (prev === file.path ? null : file.path))
                      }
                      className="w-full flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        {expandedFilePath === file.path ? (
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="font-mono truncate text-left" title={file.path}>{file.path}</span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="text-muted-foreground">+{file.additions} / -{file.deletions}</span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (!revertingFilePath) void handleRevertFile(file.path)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              e.stopPropagation()
                              if (!revertingFilePath) void handleRevertFile(file.path)
                            }
                          }}
                          className={cn(
                            "inline-flex items-center rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background-interactive",
                            revertingFilePath && revertingFilePath !== file.path && "opacity-60",
                            revertingFilePath === file.path && "opacity-80"
                          )}
                        >
                          {revertingFilePath === file.path ? "回退中..." : "回退"}
                        </span>
                      </span>
                    </button>
                    {expandedFilePath === file.path && (
                      <div className="mt-2">
                        <DiffDisplay diff={file.diff} />
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>

      <div className="border-t border-border/70 p-3 bg-background-elevated/50 space-y-2 shrink-0">
        {message && (
          <div className="text-xs text-status-nominal">{message}</div>
        )}
        {pushSteps.length > 0 && (
          <div className="rounded-md border border-border/70 bg-background p-2 space-y-1">
            {pushSteps.map((step, idx) => (
              <div key={`${step.step}-${idx}`} className="flex items-start gap-2 text-xs">
                {step.status === "ok" ? (
                  <CheckCircle2 className="size-3.5 mt-0.5 shrink-0 text-status-nominal" />
                ) : step.status === "failed" ? (
                  <XCircle className="size-3.5 mt-0.5 shrink-0 text-destructive" />
                ) : (
                  <Clock className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <div className="font-medium text-foreground">
                    {step.step.toUpperCase()} · {step.status}
                  </div>
                  <div className="text-muted-foreground break-words">{step.detail}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <input
          value={cardNumber}
          onChange={(e) => setCardNumber(e.target.value)}
          placeholder="输入卡片编号 cardNumber（必填）"
          className="w-full h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-border"
        />
        <input
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="输入 commit message（必填）"
          className="w-full h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-border"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => runAction("commit")}
            disabled={!hasPending || running !== null || !cardNumber.trim() || !commitMessage.trim()}
            className="inline-flex items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-interactive"
          >
            {running === "commit" ? (
              <>
                <Loader2 className="size-3.5 mr-1 animate-spin" />
                提交中...
              </>
            ) : (
              <>
                <CheckCircle2 className="size-3.5 mr-1" />
                Commit
              </>
            )}
          </button>
          <button
            onClick={() => runAction("push")}
            disabled={running !== null || !cardNumber.trim() || !commitMessage.trim()}
            className="inline-flex items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-interactive"
          >
            {running === "push" ? (
              <>
                <Loader2 className="size-3.5 mr-1 animate-spin" />
                推送中...
              </>
            ) : (
              <>
                <Upload className="size-3.5 mr-1" />
                push推送
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
