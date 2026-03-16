import { useCallback, useEffect, useRef, useState } from "react"
import { Shield, ShieldOff, ShieldCheck, Zap, Info } from "lucide-react"
import { cn } from "@/lib/utils"

type SandboxMode = "none" | "unelevated" | "readonly"

const isWindows = navigator.userAgent.toLowerCase().includes("windows")

interface ModeOption {
  value: SandboxMode
  label: string
  description: string
  icon: React.ReactNode
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: "none",
    label: "关闭",
    description: "不启用沙箱，命令直接在当前用户权限下执行。",
    icon: <ShieldOff className="size-4" />
  },
  {
    value: "unelevated",
    label: "Unelevated 沙箱",
    description: "使用 Codex 受限令牌沙箱隔离命令执行：工作目录外文件写保护、主流网络工具软阻断（npm/pip/git/curl）。无需管理员权限，零配置。",
    icon: <Shield className="size-4" />
  },
  {
    value: "readonly",
    label: "只读沙箱",
    description: "命令可读取所有文件，普通权限下禁止写入；以管理员身份运行时允许写入工作目录。适合安全审查、代码分析等场景。",
    icon: <ShieldCheck className="size-4" />
  }
]

export function SandboxPanel(): React.JSX.Element {
  const [mode, setMode] = useState<SandboxMode>("none")
  const [yolo, setYolo] = useState(false)
  const [loading, setLoading] = useState(true)
  const [yoloPending, setYoloPending] = useState(false)
  const [modePending, setModePending] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const [currentMode, currentYolo] = await Promise.all([
        window.api.sandbox.getMode(),
        window.api.sandbox.getYoloMode()
      ])
      if (mountedRef.current) {
        setMode(currentMode)
        setYolo(currentYolo)
        setLoading(false)
      }
    } catch (e) {
      console.error("[SandboxPanel] Failed to load settings:", e)
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  useEffect(() => {
    return window.api.sandbox.onChanged(() => {
      loadSettings()
    })
  }, [loadSettings])

  const handleSelectMode = useCallback(async (newMode: SandboxMode) => {
    if (newMode === mode || modePending) return
    setModePending(true)
    try {
      await window.api.sandbox.setMode(newMode)
    } catch (e) {
      console.error("[SandboxPanel] Failed to set mode:", e)
      loadSettings()
    } finally {
      if (mountedRef.current) setModePending(false)
    }
  }, [mode, modePending, loadSettings])

  const handleToggleYolo = useCallback(async () => {
    if (yoloPending) return
    setYoloPending(true)
    try {
      await window.api.sandbox.setYoloMode(!yolo)
    } catch (e) {
      console.error("[SandboxPanel] Failed to set yolo mode:", e)
      loadSettings()
    } finally {
      if (mountedRef.current) setYoloPending(false)
    }
  }, [yolo, yoloPending, loadSettings])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm p-8">
        加载中...
      </div>
    )
  }

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="w-full flex flex-col p-6 gap-8">

        {/* Yolo 模式 */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Zap className="size-5" />
            <h2 className="text-lg font-bold">YOLO 模式</h2>
          </div>

          <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-600 dark:text-amber-400">
            <Info className="size-4 mt-0.5 shrink-0" />
            <p>开启后，Agent 执行命令时不再弹出审批确认，所有操作自动放行。适合熟悉任务内容、希望全自动运行的场景。切换后将在下一次对话中生效。</p>
          </div>

          <button
            onClick={handleToggleYolo}
            disabled={yoloPending}
            className={cn(
              "flex items-center justify-between max-w-lg rounded-lg border-2 p-4 text-left transition-colors",
              yoloPending && "opacity-60 cursor-not-allowed",
              yolo
                ? "border-amber-500 bg-amber-500/5"
                : "border-border hover:border-amber-500/40 hover:bg-muted/40"
            )}
          >
            <div className="flex items-center gap-3">
              <Zap className={cn("size-4 shrink-0", yolo ? "text-amber-500" : "text-muted-foreground")} />
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">YOLO 模式</span>
                <p className="text-xs text-muted-foreground">跳过所有命令执行审批，Agent 全自动运行</p>
              </div>
            </div>
            <div className={cn(
              "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors",
              yolo ? "bg-amber-500" : "bg-muted-foreground/30"
            )}>
              <span className={cn(
                "inline-block size-4 rounded-full bg-white shadow transition-transform mt-0.5",
                yolo ? "translate-x-4" : "translate-x-0.5"
              )} />
            </div>
          </button>
        </div>

        {/* Windows 沙箱 */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Shield className="size-5" />
            <h2 className={cn("text-lg font-bold", !isWindows && "text-muted-foreground")}>Windows 沙箱</h2>
            {!isWindows && (
              <span className="text-xs text-muted-foreground">（仅 Windows 可用）</span>
            )}
          </div>

          {isWindows ? (
            <div className="flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-blue-600 dark:text-blue-400">
              <Info className="size-4 mt-0.5 shrink-0" />
              <p>切换沙箱模式后，将在下一次对话中生效。</p>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-muted bg-muted/30 p-3 text-sm text-muted-foreground">
              <Info className="size-4 mt-0.5 shrink-0" />
              <p>Windows 沙箱仅在 Windows 平台上可用，当前平台不支持此功能。</p>
            </div>
          )}

          <div className={cn("flex flex-col gap-3 max-w-lg", !isWindows && "opacity-40")}>
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleSelectMode(opt.value)}
                disabled={!isWindows || modePending}
                className={cn(
                  "flex items-start gap-3 rounded-lg border-2 p-4 text-left transition-colors",
                  modePending && "opacity-60 cursor-not-allowed",
                  mode === opt.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40 hover:bg-muted/40"
                )}
              >
                <div className={cn(
                  "mt-0.5 shrink-0",
                  mode === opt.value ? "text-primary" : "text-muted-foreground"
                )}>
                  {opt.icon}
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{opt.label}</span>
                    {mode === opt.value && (
                      <span className="text-xs rounded-full bg-primary/10 text-primary px-2 py-0.5">
                        当前
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {opt.description}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}
