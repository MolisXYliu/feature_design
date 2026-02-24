import { useState, useEffect } from "react"
import { Eye, EyeOff, Loader2, Trash2 } from "lucide-react"
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
}

export function CustomModelDialog({
  open,
  onOpenChange
}: CustomModelDialogProps): React.JSX.Element {
  const [config, setConfig] = useState<CustomConfig>({ baseUrl: "", model: "", apiKey: "" })
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [hasExisting, setHasExisting] = useState(false)
  const [hasExistingKey, setHasExistingKey] = useState(false)

  useEffect(() => {
    if (open) {
      setShowKey(false)
      window.api.models.getCustomConfig().then((existing) => {
        if (existing) {
          setConfig({ baseUrl: existing.baseUrl, model: existing.model, apiKey: "" })
          setHasExisting(true)
          setHasExistingKey(existing.hasApiKey)
        } else {
          setConfig({ baseUrl: "", model: "", apiKey: "" })
          setHasExisting(false)
          setHasExistingKey(false)
        }
      })
    }
  }, [open])

  const canSave =
    config.baseUrl.trim() && config.model.trim() && (hasExistingKey || config.apiKey.trim())

  async function handleSave(): Promise<void> {
    if (!canSave) return
    setSaving(true)
    try {
      await window.api.models.setCustomConfig({
        baseUrl: config.baseUrl.trim(),
        model: config.model.trim(),
        apiKey: config.apiKey.trim() || undefined
      })
      onOpenChange(false)
    } catch (e) {
      console.error("[CustomModelDialog] Failed to save:", e)
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
          <DialogTitle>{hasExisting ? "Edit Custom Model" : "Add Custom Model"}</DialogTitle>
          <DialogDescription>
            Configure an OpenAI-compatible API endpoint.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Base URL</label>
            <Input
              value={config.baseUrl}
              onChange={(e) => setConfig((c) => ({ ...c, baseUrl: e.target.value }))}
              placeholder="https://api.example.com/v1"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Model</label>
            <Input
              value={config.model}
              onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
              placeholder="gpt-4o, deepseek-chat, ..."
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">API Key</label>
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
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {hasExisting && (
              <p className="text-xs text-muted-foreground">
                Leave empty to keep the existing key.
              </p>
            )}
          </div>
        </div>

        <div className="flex justify-between">
          {hasExisting ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting || saving}
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : (
                <Trash2 className="size-4 mr-2" />
              )}
              Remove
            </Button>
          ) : (
            <div />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={!canSave || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
