import { useState, useEffect } from "react"
import { ChevronDown, Check, Key } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { useCurrentThread } from "@/lib/thread-context"
import { cn } from "@/lib/utils"
import { CustomModelDialog } from "./CustomModelDialog"

function CustomIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
    </svg>
  )
}

interface ModelSwitcherProps {
  threadId: string
}

export function ModelSwitcher({ threadId }: ModelSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [dialogModelId, setDialogModelId] = useState<string | undefined>(undefined)

  const { models, loadModels, loadProviders } = useAppStore()
  const { currentModel, setCurrentModel } = useCurrentThread(threadId)

  useEffect(() => {
    loadModels()
    loadProviders()
  }, [loadModels, loadProviders])

  const selectedModel = models.find((m) => m.id === currentModel)

  useEffect(() => {
    if (models.length === 0) return

    const hasValidSelection = currentModel && models.some((m) => m.id === currentModel)
    if (!hasValidSelection && currentModel?.startsWith("custom:")) {
      // Backward compatibility: map legacy `custom:<modelName>` to new `custom:<modelId>`.
      const legacyModelName = currentModel.slice("custom:".length)
      const migrated = models.find((m) => m.model === legacyModelName)
      if (migrated) {
        setCurrentModel(migrated.id)
        return
      }
    }

    if (!hasValidSelection) {
      const preferred = models.find((m) => m.available) || models[0]
      setCurrentModel(preferred.id)
    }
  }, [models, currentModel, setCurrentModel])

  function handleModelSelect(modelId: string): void {
    setCurrentModel(modelId)
    setOpen(false)
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {selectedModel ? (
              <>
                <CustomIcon className="size-3.5" />
                <span className="font-mono">{selectedModel.name}</span>
              </>
            ) : (
              <span>选择模型</span>
            )}
            <ChevronDown className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[280px] p-2 bg-background border-border"
          align="start"
          sideOffset={8}
        >
          {models.length > 0 ? (
            <div className="space-y-0.5">
              {models.map((model) => (
                <button
                  key={model.id}
                  onClick={() => {
                    if (model.available) handleModelSelect(model.id)
                  }}
                  disabled={!model.available}
                  title={model.available ? undefined : "请先在模型配置中填写 API 密钥"}
                  className={cn(
                    "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-sm text-xs transition-colors text-left font-mono disabled:cursor-not-allowed disabled:opacity-50",
                    currentModel === model.id
                      ? "bg-muted text-foreground"
                      : model.available
                        ? "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        : "text-muted-foreground"
                  )}
                >
                  <CustomIcon className="size-3.5 shrink-0" />
                  <span className="flex-1 truncate">
                    {model.name}
                    {!model.available ? "（未配置密钥）" : ""}
                  </span>
                  {currentModel === model.id && (
                    <Check className="size-3.5 shrink-0 text-foreground" />
                  )}
                </button>
              ))}

              <button
                onClick={() => {
                  setOpen(false)
                  setDialogModelId(currentModel || undefined)
                  setCustomDialogOpen(true)
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors mt-1 border-t border-border pt-2"
              >
                <Key className="size-3.5" />
                <span>编辑模型配置</span>
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
              <Key className="size-6 text-muted-foreground mb-2" />
              <p className="text-xs text-muted-foreground mb-3">
                尚未配置模型
              </p>
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false)
                  setDialogModelId(undefined)
                  setCustomDialogOpen(true)
                }}
              >
                去配置模型
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <CustomModelDialog
        open={customDialogOpen}
        selectedModelId={dialogModelId}
        onModelSaved={(modelId) => {
          setCurrentModel(modelId)
        }}
        onOpenChange={(isOpen) => {
          setCustomDialogOpen(isOpen)
          if (!isOpen) {
            setDialogModelId(undefined)
            loadProviders()
            loadModels()
          }
        }}
      />
    </>
  )
}
