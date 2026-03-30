import { useState, useCallback, useEffect } from "react"
import {
  ChevronRight,
  ChevronDown,
  AlertCircle,
  RotateCcw,
  GitBranch
} from "lucide-react"
import { cn } from "@/lib/utils"
import { DiffDisplay } from "@/components/chat/ToolCallRenderer"
import { toast } from "sonner"
import { GitSubmitDialog } from "./GitSubmitDialog"

export function GitPanelView({
  threadId,
  workspacePath
}: {
  threadId: string
  workspacePath: string | null
}): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<"commit" | "push" | "reject" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitAction, setSubmitAction] = useState<"commit" | "push" | null>(null)
  const [cardNumber, setCardNumber] = useState("")
  const [commitMessage, setCommitMessage] = useState("")
  const [expandedFilePaths, setExpandedFilePaths] = useState<Set<string>>(new Set())
  const [revertingFilePath, setRevertingFilePath] = useState<string | null>(null)
  const [state, setState] = useState<{
    success: boolean
    isWorktree: boolean
    taskId: string
    files: Array<{ path: string; diff: string; additions: number; deletions: number }>
    totals: { additions: number; deletions: number; fileCount: number }
    hasPendingDiff: boolean
    worktreeBranch?: string | null
    suggestedCommitMessage?: string
    error?: string
  } | null>(null)

  const showToast = useCallback((text: string, variant: "success" | "error" = "success"): void => {
    if (variant === "success") {
      toast.success(text)
      return
    }
    toast.error(text)
  }, [])

  const refresh = useCallback(async () => {
    if (!threadId) return
    setLoading(true)
    try {
      const next = await window.api.workspace.getGitPanelState(threadId)
      setState(next)
    } catch (e) {
      const err = e instanceof Error ? e.message : "加载失败"
      setError(err)
      showToast(err, "error")
    } finally {
      setLoading(false)
    }
  }, [threadId, showToast])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const files = state?.files ?? []
    setExpandedFilePaths((prev) => {
      if (files.length === 0) return new Set()
      const next = new Set([...prev].filter((path) => files.some((f) => f.path === path)))
      if (next.size === 0) {
        next.add(files[0].path)
      }
      return next
    })
  }, [state?.files])

  const toggleFileExpanded = useCallback((filePath: string): void => {
    setExpandedFilePaths((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!threadId) return
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = window.api.workspace.onFilesChanged((data) => {
      if (data.threadId !== threadId) return
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refresh()
      }, 120)
    })
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      cleanup()
    }
  }, [threadId, refresh])

  const runReject = useCallback(async () => {
    if (!threadId) return
    setRunning("reject")
    setError(null)
    try {
      const result = await window.api.workspace.rejectWorktreeChanges(threadId)
      if (!result.success) throw new Error(result.error || "回滚失败")
      showToast("已全部回退到上一版编辑内容", "success")
      await refresh()
    } catch (e) {
      const err = e instanceof Error ? e.message : "操作失败"
      setError(err)
      showToast(err, "error")
    } finally {
      setRunning(null)
    }
  }, [threadId, refresh, showToast])

  const runSubmit = useCallback(
    async (action: "commit" | "push") => {
      if (!threadId) return
      if (!cardNumber.trim()) {
        showToast("cardNumber 不能为空", "error")
        return
      }

      const customMessage = commitMessage.trim()
      const fallbackMessage =
        (state?.suggestedCommitMessage || "").trim() || `chore(task:${threadId.slice(0, 8)}): update llm changes`
      const coreMessage = customMessage || fallbackMessage
      const finalMessage = `${cardNumber.trim()} #comment fix:${coreMessage} #CMBDevClaw`

      setRunning(action)
      setError(null)
      try {
        if (action === "commit") {
          const result = await window.api.workspace.commitWorktree(threadId, finalMessage)
          if (!result.success) throw new Error(result.error || "提交失败")
          showToast("提交成功", "success")
        } else {
          const result = await window.api.workspace.pushWorktree(threadId, finalMessage)
          if (!result.success) throw new Error(result.error || "推送失败")
          showToast("推送成功", "success")
        }
        setCardNumber("")
        setCommitMessage("")
        setSubmitAction(null)
        await refresh()
      } catch (e) {
        const err = e instanceof Error ? e.message : "操作失败"
        setError(err)
        showToast(err, "error")
      } finally {
        setRunning(null)
      }
    },
    [threadId, cardNumber, commitMessage, state?.suggestedCommitMessage, refresh, showToast]
  )

  const handleRevertFile = useCallback(
    async (filePath: string) => {
      if (!threadId) return
      setRevertingFilePath(filePath)
      setError(null)
      try {
        const result = await window.api.workspace.rejectWorktreeFile(threadId, filePath)
        if (!result.success) throw new Error(result.error || "文件回退失败")
        showToast(`已回退文件：${filePath}`, "success")
        await refresh()
      } catch (e) {
        const err = e instanceof Error ? e.message : "文件回退失败"
        setError(err)
        showToast(err, "error")
      } finally {
        setRevertingFilePath(null)
      }
    },
    [threadId, refresh, showToast]
  )

  const hasPending = Boolean(state?.hasPendingDiff)

  return (
    <div className="rounded-xl border border-border/70 overflow-hidden bg-background flex flex-col min-h-0 h-full">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-3 py-2 border-b border-border/70 bg-background-elevated/70 shrink-0">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold truncate">Git 操作</div>
          <div className="text-[10px] text-muted-foreground truncate">task_id: {threadId || "-"}</div>
        </div>
        {hasPending && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSubmitAction("commit")}
              disabled={running !== null}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-interactive transition-colors"
            >
              <GitBranch className="size-3.5" />
              Git提交
            </button>
            <button
              onClick={() => {
                void runReject()
              }}
              disabled={running !== null}
              className="inline-flex items-center gap-1 rounded-md border border-destructive/50 text-destructive px-2 py-1 text-[11px] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-destructive/10 transition-colors"
            >
              <RotateCcw className="size-3.5" />
              {running === "reject" ? "全部回退中..." : "全部回退"}
            </button>
          </div>
        )}
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
                      onClick={() => toggleFileExpanded(file.path)}
                      className="w-full flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        {expandedFilePaths.has(file.path) ? (
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="font-mono truncate text-left" title={file.path}>{file.path}</span>
                        <span className="shrink-0 flex items-center gap-1.5 text-[11px] font-semibold">
                          <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                          <span className="text-muted-foreground">/</span>
                          <span className="text-rose-600 dark:text-rose-400">-{file.deletions}</span>
                        </span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
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
                            "inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background-interactive",
                            revertingFilePath && revertingFilePath !== file.path && "opacity-60",
                            revertingFilePath === file.path && "opacity-80"
                          )}
                        >
                          <RotateCcw className={cn("size-3", revertingFilePath === file.path && "animate-spin")} />
                          {revertingFilePath === file.path ? "回退中..." : "回退"}
                        </span>
                      </span>
                    </button>
                    {expandedFilePaths.has(file.path) && (
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

      <GitSubmitDialog
        open={submitAction !== null}
        action={submitAction}
        running={running === "commit" || running === "push" ? running : null}
        branch={state?.worktreeBranch || "-"}
        fileCount={state?.totals.fileCount ?? 0}
        additions={state?.totals.additions ?? 0}
        deletions={state?.totals.deletions ?? 0}
        cardNumber={cardNumber}
        commitMessage={commitMessage}
        onOpenChange={(open) => {
          if (!open) setSubmitAction(null)
        }}
        onCardNumberChange={setCardNumber}
        onCommitMessageChange={setCommitMessage}
        onSubmit={(action) => {
          void runSubmit(action)
        }}
      />

    </div>
  )
}
