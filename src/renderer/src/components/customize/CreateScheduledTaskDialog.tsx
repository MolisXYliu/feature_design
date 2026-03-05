import { useCallback, useEffect, useState } from "react"
import { FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import type { ScheduledTask, ScheduledTaskFrequency, ScheduledTaskUpsert } from "@/types"

const FREQUENCY_OPTIONS: { value: ScheduledTaskFrequency; label: string }[] = [
  { value: "manual", label: "手动" },
  { value: "hourly", label: "每小时" },
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "工作日" },
  { value: "weekly", label: "每周" }
]

const WEEKDAY_OPTIONS = [
  { value: 1, label: "星期一" },
  { value: 2, label: "星期二" },
  { value: 3, label: "星期三" },
  { value: 4, label: "星期四" },
  { value: 5, label: "星期五" },
  { value: 6, label: "星期六" },
  { value: 0, label: "星期日" }
]

const selectClass = "mt-1 w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function needsTimePicker(freq: ScheduledTaskFrequency): boolean {
  return freq === "daily" || freq === "weekdays" || freq === "weekly"
}

export function CreateScheduledTaskDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  editTask?: ScheduledTask | null
  existingNames?: string[]
}): React.JSX.Element {
  const { open, onOpenChange, onSuccess, editTask, existingNames = [] } = props
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [prompt, setPrompt] = useState("")
  const [modelId, setModelId] = useState<string>("")
  const [workDir, setWorkDir] = useState<string>("")
  const [frequency, setFrequency] = useState<ScheduledTaskFrequency>("manual")
  const [runAtTime, setRunAtTime] = useState("09:00")
  const [weekday, setWeekday] = useState(1)
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      window.api.models.getCustomConfigs().then((configs) => {
        const list = configs.map((c) => ({ id: `custom:${c.id}`, name: c.name }))
        setModels(list)
        if (list.length > 0) {
          if (!editTask) {
            setModelId(list[0].id)
          } else if (!editTask.modelId || !list.some((m) => m.id === editTask.modelId)) {
            setModelId(list[0].id)
          }
        }
      }).catch(console.error)
    }
  }, [open, editTask])

  useEffect(() => {
    if (open && editTask) {
      setName(editTask.name)
      setDescription(editTask.description)
      setPrompt(editTask.prompt)
      setModelId(editTask.modelId ?? "")
      setWorkDir(editTask.workDir ?? "")
      setFrequency(editTask.frequency)
      setRunAtTime(editTask.runAtTime ?? "09:00")
      setWeekday(editTask.weekday ?? 1)
    } else if (open && !editTask) {
      setName("")
      setDescription("")
      setPrompt("")
      setModelId("")
      setWorkDir("")
      setFrequency("manual")
      setRunAtTime("09:00")
      setWeekday(1)
    }
    setError(null)
  }, [open, editTask])

  const handleSelectFolder = useCallback(async () => {
    try {
      const path = await window.api.workspace.select()
      if (path) setWorkDir(path)
    } catch (e) {
      console.error(e)
    }
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || !prompt.trim() || !description.trim()) {
      setError("请填写所有必填字段")
      return
    }
    if (!modelId) {
      setError("请选择模型")
      return
    }
    if (!editTask && existingNames.some((n) => n === name.trim())) {
      setError("任务名称已存在，请使用其他名称")
      return
    }
    if (!workDir) {
      setError("请配置工作目录")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const config: ScheduledTaskUpsert = {
        name: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        modelId: modelId || null,
        workDir: workDir || null,
        frequency,
        runAtTime: needsTimePicker(frequency) ? runAtTime : null,
        weekday: frequency === "weekly" ? weekday : null
      }
      if (editTask) {
        await window.api.scheduledTasks.update({ ...config, id: editTask.id })
      } else {
        await window.api.scheduledTasks.create(config)
      }
      onSuccess()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }, [name, description, prompt, modelId, workDir, frequency, runAtTime, weekday, editTask, existingNames, onSuccess, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editTask ? "编辑定时任务" : "新建定时任务"}</DialogTitle>
          <DialogDescription>
            {editTask ? "修改定时任务配置" : "创建一个新的定时任务"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-xs font-medium">
              名称 <span className="text-red-500">*</span>
            </label>
            <Input
              placeholder="例如：每日代码审查"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!!editTask}
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-xs font-medium">
              描述 <span className="text-red-500">*</span>
            </label>
            <Input
              placeholder="简要描述这个任务的用途"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-xs font-medium">
              提示词 <span className="text-red-500">*</span>
            </label>
            <textarea
              placeholder="输入发送给 AI 的具体指令内容"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="mt-1 w-full min-h-[100px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
            />
          </div>

          <div>
            <label className="text-xs font-medium">
              模型 <span className="text-red-500">*</span>
            </label>
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className={selectClass}
            >
              {models.length === 0 && <option value="">请先在设置中配置模型</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium">工作目录</label>
            <div className="mt-1 flex items-center gap-2 min-w-0">
              <div className="min-w-0 flex-1 h-9 rounded-md border border-input bg-transparent px-3 text-sm flex items-center text-muted-foreground overflow-hidden" title={workDir || undefined}>
                {workDir ? (
                  <span className="truncate text-foreground">{workDir}</span>
                ) : (
                  <span>选择文件夹</span>
                )}
              </div>
              <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={handleSelectFolder}>
                <FolderOpen className="size-4 mr-1" />
                浏览
              </Button>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium">执行频率</label>
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as ScheduledTaskFrequency)}
              className={selectClass}
            >
              {FREQUENCY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {needsTimePicker(frequency) && (
            <div>
              <label className="text-xs font-medium">执行时间</label>
              <input
                type="time"
                value={runAtTime}
                onChange={(e) => setRunAtTime(e.target.value)}
                className="mt-1 h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          )}

          {frequency === "weekly" && (
            <div>
              <label className="text-xs font-medium">执行日期</label>
              <select
                value={weekday}
                onChange={(e) => setWeekday(Number(e.target.value))}
                className={selectClass}
              >
                {WEEKDAY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-500">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
