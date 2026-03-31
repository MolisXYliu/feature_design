import { useState, useEffect, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

type UpdateStage = "idle" | "available" | "downloading" | "downloaded" | "error"

interface UpdateInfo {
  version: string
  updateType: string
  releaseNotes: string
  size: number
  mandatory: boolean
}

interface DownloadProgress {
  percent: number
  transferred: number
  total: number
  speed: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function UpdateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const [stage, setStage] = useState<UpdateStage>("idle")
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [errorMsg, setErrorMsg] = useState("")
  const [checking, setChecking] = useState(false)

  // Listen for main process push events
  useEffect(() => {
    const api = window.api.update

    // On mount, pull current status in case update was detected before renderer loaded
    api.getStatus().then((s) => {
      if (s.status === "available" && s.update) {
        setUpdateInfo(s.update)
        setStage("available")
        onOpenChange(true)
      } else if (s.status === "downloaded" && s.update) {
        setUpdateInfo(s.update)
        setStage("downloaded")
        onOpenChange(true)
      }
    }).catch(() => { /* ignore */ })

    const removeAvailable = api.onAvailable((info) => {
      setUpdateInfo(info)
      setStage("available")
      onOpenChange(true)
    })

    const removeProgress = api.onProgress((p) => {
      setProgress(p)
    })

    const removeDownloaded = api.onDownloaded(() => {
      setStage("downloaded")
    })

    const removeError = api.onError((err) => {
      setErrorMsg(err.message)
      setStage("error")
    })

    return () => {
      removeAvailable()
      removeProgress()
      removeDownloaded()
      removeError()
    }
  }, [onOpenChange])

  const handleCheck = useCallback(async () => {
    setChecking(true)
    setErrorMsg("")
    try {
      const result = await window.api.update.check()
      if (result.hasUpdate) {
        setUpdateInfo({
          version: result.version,
          updateType: result.updateType,
          releaseNotes: result.releaseNotes,
          size: result.size,
          mandatory: result.mandatory
        })
        setStage("available")
      } else {
        setUpdateInfo(null)
        setStage("idle")
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "检查更新失败")
      setStage("error")
    } finally {
      setChecking(false)
    }
  }, [])

  const handleDownload = useCallback(async () => {
    setStage("downloading")
    setProgress(null)
    try {
      await window.api.update.download()
    } catch {
      // Error handled via onError event
    }
  }, [])

  const handleInstall = useCallback(async () => {
    try {
      await window.api.update.install()
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "安装失败")
      setStage("error")
    }
  }, [])

  const handleDismiss = useCallback(() => {
    window.api.update.dismiss()
    setStage("idle")
    setUpdateInfo(null)
    setProgress(null)
    onOpenChange(false)
  }, [onOpenChange])

  const handleRetry = useCallback(() => {
    setErrorMsg("")
    if (updateInfo) {
      setStage("available")
    } else {
      setStage("idle")
      handleCheck()
    }
  }, [updateInfo, handleCheck])

  // Auto-check when dialog opens from manual trigger
  useEffect(() => {
    if (open && stage === "idle" && !updateInfo) {
      handleCheck()
    }
  }, [open, stage, updateInfo, handleCheck])

  return (
    <Dialog open={open} onOpenChange={(v) => {
      if (!v && updateInfo?.mandatory && stage !== "downloaded") return
      if (!v) handleDismiss()
      else onOpenChange(v)
    }}>
      <DialogContent className="sm:max-w-md">
        {/* idle / checking */}
        {stage === "idle" && (
          <>
            <DialogHeader>
              <DialogTitle>检查更新</DialogTitle>
              <DialogDescription>
                {checking ? "正在检查更新..." : "当前已是最新版本"}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
              <Button onClick={handleCheck} disabled={checking}>
                {checking ? "检查中..." : "重新检查"}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* update available */}
        {stage === "available" && updateInfo && (
          <>
            <DialogHeader>
              <DialogTitle>发现新版本 v{updateInfo.version}</DialogTitle>
              <DialogDescription>
                {updateInfo.updateType === "asar"
                  ? "轻量更新（仅替换业务代码，无需重新安装）"
                  : "完整更新（需要重新安装）"}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                <div className="font-medium text-foreground mb-1">更新内容：</div>
                <div className="whitespace-pre-line bg-muted/50 rounded-md p-3 max-h-40 overflow-y-auto">
                  {updateInfo.releaseNotes}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                下载大小：约 {formatSize(updateInfo.size)}
              </div>
            </div>

            <DialogFooter>
              {!updateInfo.mandatory && (
                <Button variant="outline" onClick={handleDismiss}>
                  稍后提醒
                </Button>
              )}
              <Button onClick={handleDownload}>立即更新</Button>
            </DialogFooter>
          </>
        )}

        {/* downloading */}
        {stage === "downloading" && updateInfo && (
          <>
            <DialogHeader>
              <DialogTitle>正在下载 v{updateInfo.version}</DialogTitle>
            </DialogHeader>

            <div className="space-y-3">
              {/* progress bar */}
              <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-primary h-full rounded-full transition-all duration-300"
                  style={{ width: `${progress?.percent ?? 0}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {progress
                    ? `${formatSize(progress.transferred)} / ${formatSize(progress.total)}`
                    : "准备下载..."}
                </span>
                <span>
                  {progress ? `${progress.speed}  ${progress.percent}%` : ""}
                </span>
              </div>
            </div>
          </>
        )}

        {/* downloaded, ready to install */}
        {stage === "downloaded" && updateInfo && (
          <>
            <DialogHeader>
              <DialogTitle>v{updateInfo.version} 下载完成</DialogTitle>
              <DialogDescription>
                更新已就绪，需要重启应用以完成安装。请先保存当前工作。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              {!updateInfo.mandatory && (
                <Button variant="outline" onClick={handleDismiss}>
                  稍后重启
                </Button>
              )}
              <Button onClick={handleInstall}>立即重启</Button>
            </DialogFooter>
          </>
        )}

        {/* error */}
        {stage === "error" && (
          <>
            <DialogHeader>
              <DialogTitle>更新失败</DialogTitle>
              <DialogDescription>{errorMsg || "未知错误"}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setStage("idle"); onOpenChange(false) }}>
                关闭
              </Button>
              <Button onClick={handleRetry}>重试</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
