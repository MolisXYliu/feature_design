import { useState, useCallback, useEffect, useRef } from "react"
import { Plus, MessageSquare, Trash2, Pencil, Loader2, AlertCircle, Briefcase, HeartPulse } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAppStore } from "@/lib/store"
import { useThreadStream, useCurrentThread, useThreadContext } from "@/lib/thread-context"
import { cn, formatRelativeTime, truncate } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import type { Thread } from "@/types"

// Thread status indicator that shows loading, interrupted, or default state
function ThreadStatusIcon({ threadId }: { threadId: string }): React.JSX.Element {
  const { isLoading } = useThreadStream(threadId)
  const { pendingApproval, scheduledTaskLoading } = useCurrentThread(threadId)

  if (isLoading || scheduledTaskLoading) {
    return <Loader2 className="size-4 shrink-0 text-status-info animate-spin" />
  }
  
  if (pendingApproval) {
    return <AlertCircle className="size-4 shrink-0 text-status-warning" />
  }
  
  return <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
}

// Individual thread list item component
function useIsThreadRunning(threadId: string): boolean {
  const { isLoading } = useThreadStream(threadId)
  const { scheduledTaskLoading } = useCurrentThread(threadId)
  return isLoading || scheduledTaskLoading
}

function ThreadListItem({
  thread,
  isSelected,
  isEditing,
  isUnread,
  editingTitle,
  onSelect,
  onDelete,
  onRunFinished,
  onStartEditing,
  onSaveTitle,
  onCancelEditing,
  onEditingTitleChange
}: {
  thread: Thread
  isSelected: boolean
  isEditing: boolean
  isUnread: boolean
  editingTitle: string
  onSelect: () => void
  onDelete: () => void
  onRunFinished: () => void
  onStartEditing: () => void
  onSaveTitle: () => void
  onCancelEditing: () => void
  onEditingTitleChange: (value: string) => void
}): React.JSX.Element {
  const isRunning = useIsThreadRunning(thread.thread_id)
  const wasRunningRef = useRef(false)
  const onRunFinishedRef = useRef(onRunFinished)
  onRunFinishedRef.current = onRunFinished

  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      onRunFinishedRef.current()
    }
    wasRunningRef.current = isRunning
  }, [isRunning])
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group flex items-center gap-2 rounded-sm px-3 py-2 cursor-pointer transition-colors overflow-hidden",
            isSelected
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent/50"
          )}
          onClick={() => {
            if (!isEditing) {
              onSelect()
            }
          }}
        >
          <ThreadStatusIcon threadId={thread.thread_id} />
          <div className="flex-1 min-w-0 overflow-hidden">
            {isEditing ? (
              <input
                type="text"
                value={editingTitle}
                onChange={(e) => onEditingTitleChange(e.target.value)}
                onBlur={onSaveTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveTitle()
                  if (e.key === "Escape") onCancelEditing()
                }}
                className="w-full bg-background border border-border rounded px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <div
                  className="text-sm truncate block flex items-center gap-1"
                  title={thread.title || thread.thread_id}
                >
                  {thread.title?.startsWith("[Heartbeat]") ? (
                    <>
                      <HeartPulse className="size-3 shrink-0 text-red-400" />
                      <span className="truncate">{thread.title.slice(12)}</span>
                    </>
                  ) : thread.title?.startsWith("[定时]") ? (
                    <>
                      <span className="shrink-0 text-[10px] px-1 py-px rounded bg-primary/15 text-primary font-medium">定时</span>
                      <span className="truncate">{thread.title.slice(5)}</span>
                    </>
                  ) : (
                    <span className="truncate">{thread.title || truncate(thread.thread_id, 20)}</span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {formatRelativeTime(thread.updated_at)}
                </div>
              </>
            )}
          </div>
          {isUnread && !isRunning && (
            <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
          )}
          <span className="shrink-0" title={isRunning ? "任务运行中，无法删除" : undefined}>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn("opacity-0 group-hover:opacity-100", isRunning && "cursor-not-allowed !opacity-30")}
              disabled={isRunning}
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              <Trash2 className="size-3" />
            </Button>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onStartEditing}>
          <Pencil className="size-4 mr-2" />
          重命名
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete} disabled={isRunning}>
          <Trash2 className="size-4 mr-2" />
          {isRunning ? "运行中，无法删除" : "删除"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ThreadSidebar(): React.JSX.Element {
  const {
    threads,
    currentThreadId,
    createThread,
    selectThread,
    deleteThread,
    updateThread,
    showCustomizeView,
    setShowCustomizeView
  } = useAppStore()

  const { cleanupThread } = useThreadContext()

  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState("")
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem("threads:unreadIds") || "[]")
      return new Set(arr)
    } catch {
      return new Set()
    }
  })

  const persistUnread = useCallback((ids: Set<string>) => {
    localStorage.setItem("threads:unreadIds", JSON.stringify([...ids]))
  }, [])

  const currentThreadIdRef = useRef(currentThreadId)
  currentThreadIdRef.current = currentThreadId
  const showCustomizeViewRef = useRef(showCustomizeView)
  showCustomizeViewRef.current = showCustomizeView

  const handleRunFinished = useCallback((threadId: string) => {
    if (threadId === currentThreadIdRef.current && !showCustomizeViewRef.current) return
    setUnreadIds((prev) => {
      if (prev.has(threadId)) return prev
      const next = new Set(prev)
      next.add(threadId)
      persistUnread(next)
      return next
    })
  }, [persistUnread])

  const markRead = useCallback((threadId: string) => {
    setUnreadIds((prev) => {
      if (!prev.has(threadId)) return prev
      const next = new Set(prev)
      next.delete(threadId)
      persistUnread(next)
      return next
    })
  }, [persistUnread])

  const startEditing = (threadId: string, currentTitle: string): void => {
    setEditingThreadId(threadId)
    setEditingTitle(currentTitle || "")
  }

  const saveTitle = async (): Promise<void> => {
    if (editingThreadId && editingTitle.trim()) {
      await updateThread(editingThreadId, { title: editingTitle.trim() })
    }
    setEditingThreadId(null)
    setEditingTitle("")
  }

  const cancelEditing = (): void => {
    setEditingThreadId(null)
    setEditingTitle("")
  }

  const handleNewThread = async (): Promise<void> => {
    await createThread({ title: `Thread ${new Date().toLocaleDateString()}` })
  }

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-sidebar overflow-hidden">
      {/* New Thread Button - with dynamic safe area padding when zoomed out */}
      <div className="p-2 space-y-1.5" style={{ paddingTop: "calc(8px + var(--sidebar-safe-padding, 0px))" }}>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-sm font-semibold"
          onClick={handleNewThread}
        >
          <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
            <Plus className="size-3" />
          </div>
          <span className="text-muted-foreground">新任务</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full justify-start gap-2 text-sm font-semibold",
            showCustomizeView && "bg-muted"
          )}
          onClick={() => setShowCustomizeView(!showCustomizeView)}
        >
          <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
            <Briefcase className="size-3" />
          </div>
          <span className="text-muted-foreground">自定义</span>
        </Button>
      </div>

      {/* Thread List */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-1 overflow-hidden">
          {threads.map((thread) => (
            <ThreadListItem
              key={thread.thread_id}
              thread={thread}
              isSelected={currentThreadId === thread.thread_id}
              isEditing={editingThreadId === thread.thread_id}
              isUnread={unreadIds.has(thread.thread_id)}
              editingTitle={editingTitle}
              onSelect={() => {
                selectThread(thread.thread_id)
                markRead(thread.thread_id)
              }}
              onRunFinished={() => handleRunFinished(thread.thread_id)}
              onDelete={() => {
                cleanupThread(thread.thread_id)
                deleteThread(thread.thread_id)
                markRead(thread.thread_id)
              }}
              onStartEditing={() => startEditing(thread.thread_id, thread.title || "")}
              onSaveTitle={saveTitle}
              onCancelEditing={cancelEditing}
              onEditingTitleChange={setEditingTitle}
            />
          ))}

          {threads.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              暂无任务
            </div>
          )}
        </div>
      </ScrollArea>

    </aside>
  )
}
