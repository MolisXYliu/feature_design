import { useCallback, useEffect, useState, useRef } from "react"
import { Cpu, FolderOpen, Plus, Trash2, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { ChatXConfig, ChatXRobotConfig } from "@/types"

const selectClass =
  "w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function emptyRobot(): ChatXRobotConfig {
  return {
    chatId: "",
    httpUrl: "",
    fromId: "",
    clientId: "",
    clientSecret: "",
    channel: "",
    toUserList: [],
    modelId: null,
    workDir: null
  }
}

// ── Robot Edit Dialog ────────────────────────────────────────────────────────

function RobotEditDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (robot: ChatXRobotConfig) => void
  editRobot: ChatXRobotConfig | null
  models: Array<{ id: string; name: string }>
  existingChatIds: string[]
}): React.JSX.Element {
  const { open, onOpenChange, onSave, editRobot, models, existingChatIds } = props
  const isEditing = !!editRobot
  const [form, setForm] = useState<ChatXRobotConfig>(emptyRobot())
  const [toUserListStr, setToUserListStr] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      const r = editRobot || emptyRobot()
      setForm(r)
      setToUserListStr(r.toUserList.join(", "))
      setError(null)
    }
  }, [open, editRobot])

  const update = (field: keyof ChatXRobotConfig, value: unknown): void => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const handleSelectWorkDir = async (): Promise<void> => {
    const result = await window.api.workspace.select()
    if (result) update("workDir", result)
  }

  const handleSubmit = (): void => {
    if (!form.chatId.trim()) { setError("会话 ID 不能为空"); return }
    if (!isEditing && existingChatIds.includes(form.chatId.trim())) {
      setError("会话 ID 已存在，不能重复"); return
    }
    if (!form.httpUrl.trim()) { setError("HTTP 地址不能为空"); return }
    try { new URL(form.httpUrl.trim()) } catch { setError("HTTP 地址格式无效"); return }
    if (!form.fromId.trim()) { setError("fromId 不能为空"); return }
    if (!form.clientId.trim()) { setError("clientId 不能为空"); return }
    if (!form.clientSecret.trim()) { setError("clientSecret 不能为空"); return }
    if (!form.channel.trim()) { setError("channel 不能为空"); return }
    if (!form.workDir) { setError("请选择工作目录"); return }

    const users = toUserListStr.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    if (users.length === 0) { setError("toUserList 不能为空"); return }

    setError(null)
    onSave({ ...form, toUserList: users })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editRobot ? "编辑机器人" : "添加机器人"}</DialogTitle>
          <DialogDescription>配置机器人的连接参数。所有字段均为必填。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">会话 ID</label>
            <Input
              value={form.chatId}
              onChange={(e) => update("chatId", e.target.value)}
              placeholder="机器人会话ID"
              className={cn("h-9", isEditing && "opacity-60 cursor-not-allowed")}
              readOnly={isEditing}
            />
            {isEditing && <p className="text-[10px] text-muted-foreground">会话 ID 创建后不可修改</p>}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">HTTP 地址</label>
            <Input value={form.httpUrl} onChange={(e) => update("httpUrl", e.target.value)} placeholder="https://..." className="h-9" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">fromId</label>
              <Input value={form.fromId} onChange={(e) => update("fromId", e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">clientId</label>
              <Input value={form.clientId} onChange={(e) => update("clientId", e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">clientSecret</label>
              <Input value={form.clientSecret} onChange={(e) => update("clientSecret", e.target.value)} type="password" className="h-9" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">channel</label>
              <Input value={form.channel} onChange={(e) => update("channel", e.target.value)} className="h-9" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">toUserList（逗号分隔）</label>
            <Input value={toUserListStr} onChange={(e) => setToUserListStr(e.target.value)} placeholder="user1, user2" className="h-9" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">模型</label>
            <select
              className={selectClass}
              value={form.modelId || ""}
              onChange={(e) => update("modelId", e.target.value || null)}
            >
              <option value="">默认模型</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">工作目录</label>
            <div className="flex gap-2">
              <Input value={form.workDir || ""} readOnly placeholder="请选择工作目录" className="flex-1 h-9" />
              <Button variant="outline" size="sm" onClick={handleSelectWorkDir}>
                <FolderOpen className="size-4 mr-1" />
                选择
              </Button>
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSubmit}>{editRobot ? "保存" : "添加"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Robot Detail View ────────────────────────────────────────────────────────

function RobotDetail(props: {
  robot: ChatXRobotConfig | null
  models: Array<{ id: string; name: string }>
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { robot, models, onEdit, onDelete } = props

  if (!robot) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        选择左侧机器人查看详情
      </div>
    )
  }

  const modelName = models.find((m) => m.id === robot.modelId)?.name || "默认模型"

  const fields: Array<{ label: string; value: string }> = [
    { label: "会话 ID", value: robot.chatId },
    { label: "HTTP 地址", value: robot.httpUrl },
    { label: "fromId", value: robot.fromId },
    { label: "clientId", value: robot.clientId },
    { label: "clientSecret", value: "••••••••" },
    { label: "channel", value: robot.channel },
    { label: "toUserList", value: robot.toUserList.join(", ") },
    { label: "模型", value: modelName },
    { label: "工作目录", value: robot.workDir || "未设置" }
  ]

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="size-5 text-blue-400" />
            <h3 className="text-base font-semibold">{robot.chatId || "未命名机器人"}</h3>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <Pencil className="size-4 mr-1" />
              编辑
            </Button>
            <Button variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 className="size-4 mr-1 text-destructive" />
              删除
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-border divide-y divide-border">
          {fields.map(({ label, value }) => (
            <div key={label} className="flex px-4 py-2.5 text-sm">
              <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
              <span className="flex-1 truncate">{value || "-"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main Panel ───────────────────────────────────────────────────────────────

export function ChatXPanel(): React.JSX.Element {
  const [config, setConfig] = useState<ChatXConfig | null>(null)
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const mountedRef = useRef(true)
  const globalSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (globalSaveTimerRef.current) clearTimeout(globalSaveTimerRef.current)
    }
  }, [])

  const loadAll = useCallback(async () => {
    try {
      const [cfg, modelConfigs] = await Promise.all([
        window.api.chatx.getConfig(),
        window.api.models.getCustomConfigs()
      ])
      if (!mountedRef.current) return
      setConfig(cfg)
      setModels(modelConfigs.map((c) => ({ id: `custom:${c.id}`, name: c.name })))
    } catch (e) {
      console.error("[ChatXPanel] load error:", e)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const saveConfig = useCallback(async (updates: Partial<ChatXConfig>) => {
    try {
      await window.api.chatx.saveConfig(updates)
    } catch (e) {
      console.error("[ChatXPanel] saveConfig error:", e)
    }
  }, [])

  const handleToggleEnabled = useCallback(async (enabled: boolean) => {
    if (!enabled && config?.enabled) {
      if (!window.confirm("禁用后将断开 WebSocket 连接并中止所有运行中的机器人对话，确定禁用吗？")) {
        return
      }
    }
    // Flush pending debounced save to avoid stale wsUrl/userIp
    if (globalSaveTimerRef.current && config) {
      clearTimeout(globalSaveTimerRef.current)
      globalSaveTimerRef.current = null
      await saveConfig({ wsUrl: config.wsUrl, userIp: config.userIp })
    }
    if (enabled && config) {
      if (!config.wsUrl.trim()) {
        alert("请先填写 WebSocket 地址")
        return
      }
      try {
        const url = new URL(config.wsUrl.trim())
        if (url.protocol !== "ws:" && url.protocol !== "wss:") {
          alert("WebSocket 地址必须以 ws:// 或 wss:// 开头")
          return
        }
      } catch {
        alert("WebSocket 地址格式无效")
        return
      }
      if (config.robots.length === 0) {
        alert("请先添加至少一个机器人")
        return
      }
      // Check all robots have required fields
      for (let i = 0; i < config.robots.length; i++) {
        const r = config.robots[i]
        if (!r.chatId || !r.httpUrl || !r.fromId || !r.clientId || !r.clientSecret || !r.channel || !r.workDir || r.toUserList.length === 0) {
          alert(`机器人 ${i + 1}（${r.chatId || "未命名"}）配置不完整，请先补全所有字段`)
          return
        }
      }
    }
    setConfig((prev) => prev ? { ...prev, enabled } : prev)
    await saveConfig({ enabled })
    try { await window.api.chatx.restart() } catch { /* ignore */ }
  }, [saveConfig, config])

  const updateGlobal = useCallback((field: "wsUrl" | "userIp", value: string) => {
    setConfig((prev) => {
      if (!prev) return prev
      const next = { ...prev, [field]: value }
      if (globalSaveTimerRef.current) clearTimeout(globalSaveTimerRef.current)
      globalSaveTimerRef.current = setTimeout(() => saveConfig({ wsUrl: next.wsUrl, userIp: next.userIp }), 500)
      return next
    })
  }, [saveConfig])

  const handleAddRobot = useCallback(() => {
    setEditIndex(null)
    setDialogOpen(true)
  }, [])

  const handleEditRobot = useCallback(() => {
    if (selectedIndex !== null) {
      setEditIndex(selectedIndex)
      setDialogOpen(true)
    }
  }, [selectedIndex])

  const handleSaveRobot = useCallback((robot: ChatXRobotConfig) => {
    if (!config) return
    const robots = [...config.robots]
    if (editIndex !== null) {
      robots[editIndex] = robot
    } else {
      robots.push(robot)
      setSelectedIndex(robots.length - 1)
    }
    setConfig((prev) => prev ? { ...prev, robots } : prev)
    saveConfig({ robots })
  }, [editIndex, saveConfig, config])

  const handleDeleteRobot = useCallback(() => {
    if (selectedIndex === null || !config) return
    const robot = config.robots[selectedIndex]
    if (!robot) return

    const msg = config.enabled
      ? `确定删除机器人「${robot.chatId || "未命名"}」吗？\n\n该机器人当前处于启用状态，删除后将无法接收对应会话的消息。`
      : `确定删除机器人「${robot.chatId || "未命名"}」吗？`

    if (!window.confirm(msg)) return

    const robots = config.robots.filter((_, i) => i !== selectedIndex)
    setSelectedIndex(robots.length > 0 ? Math.min(selectedIndex, robots.length - 1) : null)
    setConfig((prev) => prev ? { ...prev, robots } : prev)
    saveConfig({ robots })
  }, [selectedIndex, saveConfig, config])

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        加载中...
      </div>
    )
  }

  const selectedRobot = selectedIndex !== null ? config.robots[selectedIndex] ?? null : null

  return (
    <>
      {/* Left: list + global settings */}
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold">机器人管理</h2>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <span className="text-xs text-muted-foreground">
                  {config.enabled ? "已启用" : "已禁用"}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={config.enabled}
                  className={cn(
                    "relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                    config.enabled ? "bg-primary" : "bg-muted-foreground/30"
                  )}
                  onClick={() => handleToggleEnabled(!config.enabled)}
                >
                  <span
                    className={cn(
                      "pointer-events-none inline-block size-3 rounded-full bg-white shadow-sm transition-transform",
                      config.enabled ? "translate-x-3" : "translate-x-0"
                    )}
                  />
                </button>
              </label>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={handleAddRobot}>
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <label className="text-xs text-muted-foreground">WebSocket 地址</label>
              <Input
                value={config.wsUrl}
                onChange={(e) => updateGlobal("wsUrl", e.target.value)}
                placeholder="wss://..."
                className="h-7 text-xs mt-0.5"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">用户 IP</label>
              <Input
                value={config.userIp}
                onChange={(e) => updateGlobal("userIp", e.target.value)}
                placeholder="192.168.1.100"
                className="h-7 text-xs mt-0.5"
              />
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {config.robots.length === 0 ? (
              <p className="text-xs text-muted-foreground px-1 py-2">
                暂无机器人，点击 + 添加
              </p>
            ) : (
              config.robots.map((robot, i) => (
                <button
                  key={robot.chatId || i}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/70 text-left transition-colors",
                    selectedIndex === i ? "bg-muted/70" : "hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedIndex(i)}
                >
                  <Cpu className="size-3.5 shrink-0 text-blue-400" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm truncate block">{robot.chatId || `机器人 ${i + 1}`}</span>
                    <span className="text-[10px] text-muted-foreground truncate block">{robot.channel || "未配置渠道"}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right: detail */}
      <RobotDetail
        robot={selectedRobot}
        models={models}
        onEdit={handleEditRobot}
        onDelete={handleDeleteRobot}
      />

      {/* Dialog */}
      <RobotEditDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSave={handleSaveRobot}
        editRobot={editIndex !== null ? config.robots[editIndex] ?? null : null}
        models={models}
        existingChatIds={config.robots.map((r) => r.chatId)}
      />
    </>
  )
}
