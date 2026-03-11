import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  FolderOpen,
  Plug,
  Plus,
  Power,
  Puzzle,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { PluginMetadata, PluginManifest } from "@/types"

interface PluginDetail {
  skills: string[]
  mcpServers: string[]
  manifest: PluginManifest | null
}

function ConfirmDeleteDialog(props: {
  open: boolean
  pluginName: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { open, pluginName, onConfirm, onCancel } = props
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>确认卸载</DialogTitle>
          <DialogDescription>
            确定要卸载插件「{pluginName}」吗？此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            卸载
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ErrorDialog(props: {
  open: boolean
  message: string
  onClose: () => void
}): React.JSX.Element {
  const { open, message, onClose } = props
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>操作失败</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UploadPluginDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}): React.JSX.Element {
  const { open, onOpenChange, onSuccess } = props
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleZipFile = useCallback(
    async (file: File) => {
      const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."))
      if (ext !== ".zip") {
        setError("仅支持 .zip 文件")
        return
      }
      setError(null)
      setUploading(true)
      try {
        const buffer = await file.arrayBuffer()
        const res = await window.api.plugins.install(buffer, file.name)
        if (res.success) {
          onSuccess()
          onOpenChange(false)
        } else {
          setError(res.error || "安装失败")
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error")
      } finally {
        setUploading(false)
      }
    },
    [onOpenChange, onSuccess]
  )

  const handleSelectDir = useCallback(async () => {
    setError(null)
    setUploading(true)
    try {
      const res = await window.api.plugins.installFromDir()
      if (res.success) {
        onSuccess()
        onOpenChange(false)
      } else if (res.error !== "已取消") {
        setError(res.error || "安装失败")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setUploading(false)
    }
  }, [onOpenChange, onSuccess])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) handleZipFile(file)
    },
    [handleZipFile]
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const onDragLeave = useCallback(() => setDragOver(false), [])

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleZipFile(file)
      e.target.value = ""
    },
    [handleZipFile]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>安装 Plugin</DialogTitle>
          <DialogDescription>
            上传 .zip 文件或选择本地 Plugin 文件夹。Plugin 需包含 skills/ 目录或 .mcp.json 配置。
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            "mt-4 border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer",
            dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-muted-foreground/50",
            uploading && "pointer-events-none opacity-60"
          )}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => document.getElementById("upload-plugin-input")?.click()}
        >
          <input
            id="upload-plugin-input"
            type="file"
            accept=".zip"
            className="hidden"
            onChange={onInputChange}
            disabled={uploading}
          />
          {uploading ? (
            <p className="text-sm text-muted-foreground">安装中...</p>
          ) : (
            <>
              <Upload className="size-10 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">拖拽 .zip 文件到此处，或点击选择</p>
            </>
          )}
        </div>
        <div className="mt-2 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={handleSelectDir}
            disabled={uploading}
          >
            <FolderOpen className="size-4" />
            选择文件夹
          </Button>
        </div>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

export function PluginsPanel(): React.JSX.Element {
  const [plugins, setPlugins] = useState<PluginMetadata[]>([])
  const [selectedPlugin, setSelectedPlugin] = useState<PluginMetadata | null>(null)
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<PluginMetadata | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => clearTimeout(debounceTimer.current)
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(value), 200)
  }, [])

  const refreshPlugins = useCallback(() => {
    window.api.plugins.list().then(setPlugins).catch(console.error)
  }, [])

  // After install/update, refresh the selected plugin's detail if it was affected
  const handleInstallSuccess = useCallback(() => {
    window.api.plugins.list().then((list) => {
      setPlugins(list)
      if (selectedPlugin) {
        const updated = list.find((p) => p.id === selectedPlugin.id || p.name === selectedPlugin.name)
        if (updated) {
          setSelectedPlugin(updated)
          window.api.plugins.getDetail(updated.id).then(setDetail).catch(() => {
            setDetail({ skills: [], mcpServers: [], manifest: null })
          })
        }
      }
    }).catch(console.error)
  }, [selectedPlugin])

  useEffect(() => {
    refreshPlugins()
  }, [refreshPlugins])

  const loadDetail = useCallback(async (plugin: PluginMetadata) => {
    setSelectedPlugin(plugin)
    setDetail(null)
    try {
      const d = await window.api.plugins.getDetail(plugin.id)
      setDetail(d)
    } catch {
      setDetail({ skills: [], mcpServers: [], manifest: null })
    }
  }, [])

  const handleSelectPlugin = useCallback(
    (plugin: PluginMetadata) => {
      if (selectedPlugin?.id === plugin.id) return
      loadDetail(plugin)
    },
    [selectedPlugin, loadDetail]
  )

  const handleToggleEnabled = useCallback(
    async (plugin: PluginMetadata) => {
      const newEnabled = !plugin.enabled
      await window.api.plugins.setEnabled(plugin.id, newEnabled)
      refreshPlugins()
      if (selectedPlugin?.id === plugin.id) {
        setSelectedPlugin((prev) => (prev ? { ...prev, enabled: newEnabled } : prev))
      }
    },
    [selectedPlugin, refreshPlugins]
  )

  const handleDeleteRequest = useCallback((plugin: PluginMetadata) => {
    setDeleteTarget(plugin)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    const plugin = deleteTarget
    setDeleteTarget(null)
    const res = await window.api.plugins.delete(plugin.id)
    if (res.success) {
      if (selectedPlugin?.id === plugin.id) {
        setSelectedPlugin(null)
        setDetail(null)
      }
      refreshPlugins()
    } else {
      setErrorMsg(res.error || "卸载失败")
    }
  }, [deleteTarget, selectedPlugin, refreshPlugins])

  const filteredPlugins = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return plugins
    return plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q)
    )
  }, [plugins, debouncedQuery])

  return (
    <>
      {/* Left panel - plugin list */}
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">Plugins</h2>
            <div className="flex items-center gap-1">
              <div className="relative flex-1 min-w-[120px] max-w-[160px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="搜索"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="h-7 pl-7 pr-6 text-xs"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded"
                    onClick={() => { setSearchQuery(""); setDebouncedQuery("") }}
                    aria-label="清除"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => setUploadDialogOpen(true)}>
                <Plus className="size-4" />
              </Button>
            </div>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {filteredPlugins.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground text-xs">
                {plugins.length === 0 ? (
                  <div className="space-y-2">
                    <Puzzle className="size-8 mx-auto opacity-40" />
                    <p>暂无安装的插件</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={() => setUploadDialogOpen(true)}
                    >
                      <Plus className="size-3.5" />
                      安装 Plugin
                    </Button>
                  </div>
                ) : (
                  <p>没有匹配的插件</p>
                )}
              </div>
            ) : (
              filteredPlugins.map((plugin) => (
                <button
                  key={plugin.id}
                  className={cn(
                    "w-full text-left rounded-md border border-border/70 p-2.5 transition-colors",
                    selectedPlugin?.id === plugin.id ? "bg-muted/70 border-border" : "hover:bg-muted/50"
                  )}
                  onClick={() => handleSelectPlugin(plugin)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Puzzle className={cn("size-4 shrink-0", plugin.enabled ? "text-primary" : "text-muted-foreground/40")} />
                      <span className={cn("text-sm font-medium truncate", !plugin.enabled && "text-muted-foreground")}>
                        {plugin.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {plugin.version && (
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                          v{plugin.version}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {plugin.description && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{plugin.description}</p>
                  )}
                  <div className="flex items-center gap-3 mt-1.5">
                    {plugin.skillCount > 0 && (
                      <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Sparkles className="size-3" />
                        {plugin.skillCount} skills
                      </span>
                    )}
                    {plugin.mcpServerCount > 0 && (
                      <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Plug className="size-3" />
                        {plugin.mcpServerCount} MCPs
                      </span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right panel - plugin detail */}
      <PluginDetailPanel
        plugin={selectedPlugin}
        detail={detail}
        onToggleEnabled={handleToggleEnabled}
        onDelete={handleDeleteRequest}
      />

      <UploadPluginDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        onSuccess={handleInstallSuccess}
      />

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        pluginName={deleteTarget?.name ?? ""}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />

      <ErrorDialog
        open={errorMsg !== null}
        message={errorMsg ?? ""}
        onClose={() => setErrorMsg(null)}
      />
    </>
  )
}

function PluginDetailPanel(props: {
  plugin: PluginMetadata | null
  detail: PluginDetail | null
  onToggleEnabled: (plugin: PluginMetadata) => void
  onDelete: (plugin: PluginMetadata) => void
}): React.JSX.Element {
  const { plugin, detail, onToggleEnabled, onDelete } = props

  if (!plugin) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        <div className="text-center space-y-2">
          <Puzzle className="size-8 mx-auto opacity-40" />
          <p>选择一个插件查看详情</p>
        </div>
      </div>
    )
  }

  const manifest = detail?.manifest
  const author = manifest?.author
    ? typeof manifest.author === "string"
      ? manifest.author
      : manifest.author.name || ""
    : plugin.author

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold truncate">{plugin.name}</h2>
            {plugin.version && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0">
                v{plugin.version}
              </Badge>
            )}
          </div>
          {author && <p className="text-xs text-muted-foreground mt-0.5">{author}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => onDelete(plugin)}
          >
            <Trash2 className="size-3" />
            卸载
          </Button>
          <Button
            variant={plugin.enabled ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => onToggleEnabled(plugin)}
          >
            <Power className="size-3" />
            {plugin.enabled ? "已启用" : "已禁用"}
          </Button>
        </div>
      </div>

      {/* Description */}
      {plugin.description && (
        <div className="px-4 py-3 border-b border-border">
          <p className="text-sm text-muted-foreground leading-relaxed">{plugin.description}</p>
        </div>
      )}

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Manifest info */}
          {manifest && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">插件信息</h3>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {manifest.version && (
                  <div>
                    <span className="text-muted-foreground">版本: </span>
                    <span>{manifest.version}</span>
                  </div>
                )}
                {manifest.license && (
                  <div>
                    <span className="text-muted-foreground">许可证: </span>
                    <span>{manifest.license}</span>
                  </div>
                )}
                {manifest.keywords && manifest.keywords.length > 0 && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">关键词: </span>
                    <span>{manifest.keywords.join(", ")}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Components summary */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">组件摘要</h3>
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <Sparkles className="size-3.5 text-amber-500" />
                <span>{plugin.skillCount} 个 Skills</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Plug className="size-3.5 text-blue-500" />
                <span>{plugin.mcpServerCount} 个 MCP Servers</span>
              </div>
            </div>
          </div>

          {/* Skills list */}
          {detail && detail.skills.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Skills</h3>
              <div className="space-y-1">
                {detail.skills.map((skill) => (
                  <div
                    key={skill}
                    className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-2 text-xs"
                  >
                    <Sparkles className="size-3 text-amber-500 shrink-0" />
                    <span className="truncate">{skill === "." ? "(根目录 Skill)" : skill}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* MCP Servers list */}
          {detail && detail.mcpServers.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">MCP Servers</h3>
              <div className="space-y-1">
                {detail.mcpServers.map((server) => (
                  <div
                    key={server}
                    className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-2 text-xs"
                  >
                    <Plug className="size-3 text-blue-500 shrink-0" />
                    <span className="truncate">{server}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Loading state */}
          {!detail && (
            <p className="text-xs text-muted-foreground">加载中...</p>
          )}

          {/* Plugin path */}
          <div className="pt-2 border-t border-border">
            <p className="text-[10px] text-muted-foreground/60 break-all">
              {plugin.path.replace(/\\/g, "/")}
            </p>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
