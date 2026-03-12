import { useCallback, useEffect, useRef, useState } from "react"
import { Shield, ShieldOff, Info } from "lucide-react"
import { cn } from "@/lib/utils"

type SandboxMode = "none" | "unelevated"

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
  }
]

export function SandboxPanel(): React.JSX.Element {
  const [mode, setMode] = useState<SandboxMode>("none")
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadMode = useCallback(async () => {
    try {
      const current = await window.api.sandbox.getMode()
      if (mountedRef.current) {
        setMode(current)
        setLoading(false)
      }
    } catch (e) {
      console.error("[SandboxPanel] Failed to load mode:", e)
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadMode()
  }, [loadMode])

  useEffect(() => {
    return window.api.sandbox.onChanged(() => {
      loadMode()
    })
  }, [loadMode])

  const handleSelect = useCallback(async (newMode: SandboxMode) => {
    if (newMode === mode) return
    try {
      await window.api.sandbox.setMode(newMode)
      // 不在此处 setMode——主进程写入后会广播 sandbox:changed，
      // onChanged → loadMode() 会同步真实值，也能正确处理主进程拒绝的情况
    } catch (e) {
      console.error("[SandboxPanel] Failed to set mode:", e)
      // 写入失败时重新加载，确保 UI 显示实际生效的值
      loadMode()
    }
  }, [mode, loadMode])

  if (!isWindows) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm p-8">
        Windows 沙箱仅在 Windows 平台上可用。
      </div>
    )
  }

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="w-full flex flex-col p-6 gap-6">
        <div className="flex items-center gap-2">
          <Shield className="size-5" />
          <h2 className="text-lg font-bold">Windows 沙箱</h2>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-blue-600 dark:text-blue-400">
          <Info className="size-4 mt-0.5 shrink-0" />
          <p>
            沙箱模式在下一次 Agent 调用时生效。Unelevated 模式需要 <code className="font-mono text-xs bg-muted px-1 rounded">resources/bin/win32/codex.exe</code> 存在，不存在时自动降级为无沙箱。
          </p>
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : (
          <div className="flex flex-col gap-3 max-w-lg">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleSelect(opt.value)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border-2 p-4 text-left transition-colors",
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
        )}
      </div>
    </div>
  )
}
