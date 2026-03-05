import { useCallback, useEffect, useState, useRef } from "react"
import { Clock, Info, Play, Square, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { ScheduledTask } from "@/types"
import { CreateScheduledTaskDialog } from "./CreateScheduledTaskDialog"

const FREQUENCY_LABELS: Record<string, string> = {
  manual: "手动",
  hourly: "每小时",
  daily: "每天",
  weekdays: "工作日",
  weekly: "每周"
}

const WEEKDAY_LABELS: Record<number, string> = {
  0: "星期日", 1: "星期一", 2: "星期二", 3: "星期三",
  4: "星期四", 5: "星期五", 6: "星期六"
}

function formatSchedule(task: { frequency: string; runAtTime?: string | null; weekday?: number | null }): string {
  const freq = FREQUENCY_LABELS[task.frequency] ?? task.frequency
  if (task.frequency === "manual" || task.frequency === "hourly") return freq
  const time = task.runAtTime ?? "09:00"
  if (task.frequency === "weekly" && task.weekday != null) {
    return `${freq} · ${WEEKDAY_LABELS[task.weekday]} ${time}`
  }
  return `${freq} · ${time}`
}

function formatDate(iso: string | null): string {
  if (!iso) return "-"
  const d = new Date(iso)
  return d.toLocaleString()
}

function resolveModelName(
  modelId: string | null,
  modelMap: Map<string, string>
): string {
  if (!modelId) return "-"
  return modelMap.get(modelId) ?? modelId
}

export function ScheduledPanel(): React.JSX.Element {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [selectedTask, setSelectedTask] = useState<ScheduledTask | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editTask, setEditTask] = useState<ScheduledTask | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [modelMap, setModelMap] = useState<Map<string, string>>(new Map())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    window.api.models.getCustomConfigs().then((configs) => {
      const map = new Map<string, string>()
      for (const c of configs) {
        map.set(`custom:${c.id}`, c.name)
      }
      if (mountedRef.current) setModelMap(map)
    }).catch(console.error)
  }, [])

  const loadTasks = useCallback(async () => {
    try {
      const updated = await window.api.scheduledTasks.list()
      if (!mountedRef.current) return
      setTasks(updated)
      setSelectedTask((prev) => {
        if (!prev) return null
        return updated.find((t) => t.id === prev.id) ?? null
      })
      // Sync running state from backend
      const running = new Set<string>()
      await Promise.all(
        updated.map(async (t) => {
          if (await window.api.scheduledTasks.isRunning(t.id)) {
            running.add(t.id)
          }
        })
      )
      if (mountedRef.current) setRunningIds(running)
    } catch (e) {
      console.error(e)
    }
  }, [])

  useEffect(() => {
    loadTasks()
  }, [loadTasks])

  useEffect(() => {
    return window.api.scheduledTasks.onChanged(() => {
      loadTasks()
    })
  }, [loadTasks])

  const handleDelete = useCallback(async (task: ScheduledTask) => {
    if (!confirm(`确定要删除定时任务「${task.name}」吗？此操作不可撤销。`)) return
    try {
      await window.api.scheduledTasks.delete(task.id)
      setSelectedTask((prev) => (prev?.id === task.id ? null : prev))
      await loadTasks()
    } catch (e) {
      console.error(e)
    }
  }, [loadTasks])

  const handleToggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    try {
      await window.api.scheduledTasks.setEnabled(id, enabled)
      await loadTasks()
    } catch (e) {
      console.error(e)
    }
  }, [loadTasks])

  const handleRunNow = useCallback(async (id: string) => {
    setRunningIds((prev) => new Set(prev).add(id))
    try {
      await window.api.scheduledTasks.runNow(id)
    } catch (e) {
      console.error(e)
      if (mountedRef.current) {
        setRunningIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
  }, [])

  const handleCancel = useCallback(async (id: string) => {
    try {
      await window.api.scheduledTasks.cancel(id)
    } catch (e) {
      console.error(e)
    }
  }, [])

  const isRunning = (id: string): boolean => runningIds.has(id)

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">定时任务</h2>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 shrink-0"
              onClick={() => {
                setEditTask(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-muted/50 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            <span>定时任务仅在电脑唤醒状态下运行</span>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-2">
            {tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Clock className="size-8 opacity-40 mb-2" />
                <p className="text-xs">暂无定时任务</p>
              </div>
            ) : (
              tasks.map((task) => (
                <button
                  key={task.id}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/70 text-left transition-colors",
                    selectedTask?.id === task.id ? "bg-muted/70" : "hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedTask(task)}
                >
                  {isRunning(task.id) ? (
                    <Loader2 className="size-3.5 shrink-0 text-primary animate-spin" />
                  ) : (
                    <Clock className={cn("size-3.5 shrink-0", task.enabled ? "text-primary" : "text-muted-foreground")} />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className={cn("text-sm truncate block", !task.enabled && "text-muted-foreground")}>
                      {task.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {isRunning(task.id)
                        ? "运行中..."
                        : <>
                            {FREQUENCY_LABELS[task.frequency] ?? task.frequency}
                            {task.lastRunStatus === "ok" && " · 上次: 成功"}
                            {task.lastRunStatus === "error" && " · 上次: 失败"}
                          </>
                      }
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {selectedTask ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold">{selectedTask.name}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{selectedTask.description}</p>
            </div>
            <div className="flex items-center gap-1">
              {isRunning(selectedTask.id) ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleCancel(selectedTask.id)}
                >
                  <Square className="size-3 mr-1" />
                  停止
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleRunNow(selectedTask.id)}
                >
                  <Play className="size-3 mr-1" />
                  立即运行
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => {
                  setEditTask(selectedTask)
                  setDialogOpen(true)
                }}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                onClick={() => handleDelete(selectedTask)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">提示词</label>
                <p className="mt-1 text-sm whitespace-pre-wrap bg-muted/30 rounded-md p-2">{selectedTask.prompt}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">模型</label>
                  <p className="mt-1 text-sm">{resolveModelName(selectedTask.modelId, modelMap)}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">执行频率</label>
                  <p className="mt-1 text-sm">{formatSchedule(selectedTask)}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">工作目录</label>
                  <p className="mt-1 text-sm truncate" title={selectedTask.workDir ?? undefined}>{selectedTask.workDir ?? "-"}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">启用状态</label>
                  <div className="mt-1">
                    <button
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full border",
                        selectedTask.enabled
                          ? "bg-green-500/10 border-green-500/30 text-green-500"
                          : "bg-muted border-border text-muted-foreground"
                      )}
                      onClick={() => handleToggleEnabled(selectedTask.id, !selectedTask.enabled)}
                    >
                      {selectedTask.enabled ? "已启用" : "已禁用"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">上次运行</label>
                  <p className="mt-1 text-sm">{formatDate(selectedTask.lastRunAt)}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">上次状态</label>
                  <p className={cn(
                    "mt-1 text-sm",
                    selectedTask.lastRunStatus === "ok" && "text-green-500",
                    selectedTask.lastRunStatus === "error" && "text-red-500"
                  )}>
                    {isRunning(selectedTask.id) ? "运行中..." : (selectedTask.lastRunStatus ?? "-")}
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">下次运行</label>
                  <p className="mt-1 text-sm">{formatDate(selectedTask.nextRunAt)}</p>
                </div>
                {selectedTask.lastRunError && (
                  <div className="col-span-2">
                    <label className="text-xs font-medium text-muted-foreground">错误信息</label>
                    <p className="mt-1 text-xs text-red-500 bg-red-500/5 rounded-md p-2">{selectedTask.lastRunError}</p>
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          <div className="text-center space-y-2">
            <Clock className="size-8 mx-auto opacity-40" />
            <p className="font-medium">定时任务</p>
            <p className="text-xs">选择一个任务查看详情，或点击 + 创建新任务</p>
          </div>
        </div>
      )}

      <CreateScheduledTaskDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditTask(null)
        }}
        onSuccess={loadTasks}
        editTask={editTask}
        existingNames={tasks.map((t) => t.name)}
      />
    </div>
  )
}
