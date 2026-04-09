import { useCallback, useEffect, useState, useRef } from "react"
import { Play, Loader2, Square, Code2, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { LspConfig } from "@/types"

const HEAP_OPTIONS = [
  { value: 512, label: "512 MB" },
  { value: 1024, label: "1024 MB" },
  { value: 2048, label: "2048 MB" },
  { value: 4096, label: "4096 MB" }
]

const selectClass =
  "w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

interface LspPanelProps {
  threadId: string | null
}

export function LspPanel({ threadId }: LspPanelProps): React.JSX.Element {
  const [config, setConfig] = useState<LspConfig | null>(null)
  const [running, setRunning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const loadAll = useCallback(async () => {
    try {
      const cfg = await window.api.lsp.getConfig()
      if (!mountedRef.current) return
      setConfig(cfg)

      if (!threadId) {
        setProjectRoot(null)
        setRunning(false)
        return
      }

      const workspace = await window.api.workspace.get(threadId)
      if (!mountedRef.current) return
      setProjectRoot(workspace)

      if (!workspace) {
        setRunning(false)
        return
      }

      const isRunning = await window.api.lsp.isRunning(workspace)
      if (mountedRef.current) setRunning(isRunning)
    } catch (e) {
      console.error("[LspPanel] load error:", e)
    }
  }, [threadId])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    return window.api.lsp.onChanged(() => { loadAll() })
  }, [loadAll])

  const saveConfig = useCallback(async (updates: Partial<LspConfig>) => {
    try {
      await window.api.lsp.saveConfig(updates)
    } catch (e) {
      console.error("[LspPanel] saveConfig error:", e)
    }
  }, [])

  const handleToggleEnabled = useCallback(async (enabled: boolean) => {
    setConfig((prev) => prev ? { ...prev, enabled } : prev)
    await saveConfig({ enabled })
  }, [saveConfig])

  const handleHeapChange = useCallback(async (value: string) => {
    const maxHeapMb = Number(value)
    setConfig((prev) => prev ? { ...prev, maxHeapMb } : prev)
    await saveConfig({ maxHeapMb })
  }, [saveConfig])

  const handleStart = useCallback(async () => {
    if (!projectRoot) {
      alert("请先为当前会话选择工作目录")
      return
    }
    try {
      setStarting(true)
      await window.api.lsp.start(projectRoot)
      if (mountedRef.current) {
        setRunning(true)
        setStarting(false)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (mountedRef.current) {
        setStarting(false)
        alert(`启动失败: ${msg}`)
      }
    }
  }, [projectRoot])

  const handleStop = useCallback(async () => {
    if (!projectRoot) return
    try {
      await window.api.lsp.stop(projectRoot)
      if (mountedRef.current) setRunning(false)
    } catch (e) {
      console.error("[LspPanel] stop error:", e)
    }
  }, [projectRoot])

  const handleReset = useCallback(async () => {
    try {
      const defaults = await window.api.lsp.resetConfig()
      setConfig(defaults)
    } catch (e) {
      console.error("[LspPanel] reset error:", e)
    }
  }, [])

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        加载中...
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Code2 className="size-5 text-orange-400" />
            <h2 className="text-lg font-semibold">Java LSP</h2>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">Beta</span>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              title="重置为默认配置"
            >
              <RotateCcw className="size-4 mr-1" />
              重置
            </Button>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-sm text-muted-foreground">
                {config.enabled ? "已启用" : "已禁用"}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={config.enabled}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                  config.enabled ? "bg-primary" : "bg-muted-foreground/30"
                )}
                onClick={() => handleToggleEnabled(!config.enabled)}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                    config.enabled ? "translate-x-4" : "translate-x-0"
                  )}
                />
              </button>
            </label>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          启用后，AI Agent 可使用 Java LSP 进行精确的代码跳转、查找引用、类型信息查询等操作。
          需要在 resources/jre 和 resources/jdtls 中放置 JRE 21 和 JDTLS。
        </p>

        {/* Settings */}
        <div className="space-y-4">
          {/* Max Heap */}
          <div>
            <label className="text-sm font-medium">JVM 最大堆内存</label>
            <select
              className={cn(selectClass, "mt-1")}
              value={config.maxHeapMb}
              onChange={(e) => handleHeapChange(e.target.value)}
            >
              {HEAP_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Status & Controls */}
        <div className="rounded-md border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">运行状态</span>
            <div className="flex items-center gap-2">
              {running ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStop}
                >
                  <Square className="size-4 mr-1" />
                  停止
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={starting || !config.enabled || !projectRoot}
                  onClick={handleStart}
                >
                  {starting ? (
                    <Loader2 className="size-4 mr-1 animate-spin" />
                  ) : (
                    <Play className="size-4 mr-1" />
                  )}
                  {starting ? "启动中..." : "启动"}
                </Button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-muted-foreground">状态</div>
            <div className={cn(
              running ? "text-green-500" : "text-muted-foreground"
            )}>
              {running ? "运行中" : starting ? "启动中..." : "已停止"}
            </div>
            <div className="text-muted-foreground">当前会话工作目录</div>
            <div className="text-xs truncate">
              {projectRoot || (threadId ? "当前会话未关联文件夹" : "未选择会话")}
            </div>
            {config.lastError && (
              <>
                <div className="text-muted-foreground">错误信息</div>
                <div className="text-destructive text-xs">{config.lastError}</div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
