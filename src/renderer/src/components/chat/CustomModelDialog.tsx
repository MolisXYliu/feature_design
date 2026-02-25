import { useState, useEffect } from "react"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface CustomModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface CustomConfig {
  baseUrl: string
  model: string
  apiKey: string
  maxTokensInput: string
}

interface TokenLimits {
  defaultMaxTokens: number
  minMaxTokens: number
  maxMaxTokens: number
}

const FALLBACK_LIMITS: TokenLimits = {
  defaultMaxTokens: 128_000,
  minMaxTokens: 32_000,
  maxMaxTokens: 128_000
}

function parseMaxTokens(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/^\d+$/.test(trimmed)) return null

  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return null
  return parsed
}

function getMaxTokensError(value: string, limits: TokenLimits): string | null {
  const parsed = parseMaxTokens(value)
  if (parsed === null) return "请输入上下文窗口大小"
  if (parsed < limits.minMaxTokens || parsed > limits.maxMaxTokens) {
    return `上下文窗口大小必须在 ${limits.minMaxTokens.toLocaleString()} 到 ${limits.maxMaxTokens.toLocaleString()} 之间`
  }
  return null
}

export function CustomModelDialog({
  open,
  onOpenChange
}: CustomModelDialogProps): React.JSX.Element {
  const [config, setConfig] = useState<CustomConfig>({
    baseUrl: "",
    model: "",
    apiKey: "",
    maxTokensInput: String(FALLBACK_LIMITS.defaultMaxTokens)
  })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [hasExisting, setHasExisting] = useState(false)
  const [hasExistingKey, setHasExistingKey] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [tokenLimits, setTokenLimits] = useState<TokenLimits>(FALLBACK_LIMITS)

  useEffect(() => {
    let cancelled = false

    if (open) {
      setShowKey(false)
      setFormError(null)

      void Promise.all([window.api.models.getTokenLimits(), window.api.models.getCustomConfig()]).then(
        ([limits, existing]) => {
          if (cancelled) return
          setTokenLimits(limits)

          if (existing) {
            setConfig({
              baseUrl: existing.baseUrl,
              model: existing.model,
              apiKey: "",
              maxTokensInput: String(existing.maxTokens ?? limits.defaultMaxTokens)
            })
            setHasExisting(true)
            setHasExistingKey(existing.hasApiKey)
          } else {
            setConfig({
              baseUrl: "",
              model: "",
              apiKey: "",
              maxTokensInput: String(limits.defaultMaxTokens)
            })
            setHasExisting(false)
            setHasExistingKey(false)
          }
        }
      ).catch((error) => {
        console.error("[CustomModelDialog] Failed to load model settings:", error)
      })
    }

    return () => {
      cancelled = true
    }
  }, [open])

  const maxTokensError = getMaxTokensError(config.maxTokensInput, tokenLimits)
  const canToggleKeyVisibility = config.apiKey.trim().length > 0

  const canSave =
    config.baseUrl.trim() &&
    config.model.trim() &&
    (hasExistingKey || config.apiKey.trim()) &&
    !maxTokensError

  async function handleSave(): Promise<void> {
    if (!canSave) {
      if (maxTokensError) setFormError(maxTokensError)
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const parsedMaxTokens = parseMaxTokens(config.maxTokensInput)
      if (parsedMaxTokens === null) {
        setFormError("请输入有效的上下文窗口大小")
        return
      }

      await window.api.models.setCustomConfig({
        baseUrl: config.baseUrl.trim(),
        model: config.model.trim(),
        apiKey: config.apiKey.trim() || undefined,
        maxTokens: parsedMaxTokens
      })
      onOpenChange(false)
    } catch (e) {
      console.error("[CustomModelDialog] Failed to save:", e)
      setFormError(e instanceof Error ? e.message : "保存失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(): Promise<void> {
    setDeleting(true)
    try {
      await window.api.models.deleteCustomConfig()
      onOpenChange(false)
    } catch (e) {
      console.error("[CustomModelDialog] Failed to delete:", e)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{hasExisting ? "编辑自定义模型" : "添加自定义模型"}</DialogTitle>
          <DialogDescription>配置兼容 OpenAI 接口格式的模型服务。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">接口地址（Base URL）</label>
            <Input
              value={config.baseUrl}
              onChange={(e) => setConfig((c) => ({ ...c, baseUrl: e.target.value }))}
              placeholder="https://api.example.com/v1"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">模型名称（Model）</label>
            <Input
              value={config.model}
              onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
              placeholder="gpt-4o, deepseek-chat, ..."
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              最大 Token（上下文窗口）
            </label>
            <Input
              type="number"
              value={config.maxTokensInput}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  maxTokensInput: e.target.value
                }))
              }
              placeholder={String(tokenLimits.defaultMaxTokens)}
              min={tokenLimits.minMaxTokens}
              max={tokenLimits.maxMaxTokens}
            />
            {maxTokensError && <p className="text-xs text-destructive">{maxTokensError}</p>}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">API 密钥</label>
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={config.apiKey}
                onChange={(e) => setConfig((c) => ({ ...c, apiKey: e.target.value }))}
                placeholder={hasExisting ? "••••••••••••••••" : "sk-..."}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => {
                  if (canToggleKeyVisibility) setShowKey(!showKey)
                }}
                disabled={!canToggleKeyVisibility}
                title={canToggleKeyVisibility ? "显示或隐藏密钥" : "请输入密钥后再切换显示"}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>
        </div>

        {formError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {formError}
          </div>
        )}

        <div className="flex justify-between">
          {hasExisting ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting || saving}
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              删除
            </Button>
          ) : (
            <div />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="button" onClick={handleSave} disabled={!canSave || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : "保存"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
