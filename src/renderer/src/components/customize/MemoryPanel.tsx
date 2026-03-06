import { useCallback, useEffect, useRef, useState } from "react"
import { Brain, FileText, Info, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

interface MemoryFile {
  name: string
  size: number
  modifiedAt: string
}

interface MemoryStats {
  fileCount: number
  totalSize: number
  indexSize: number
  enabled: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

export function MemoryPanel(): React.JSX.Element {
  const [files, setFiles] = useState<MemoryFile[]>([])
  const [selectedFile, setSelectedFile] = useState<MemoryFile | null>(null)
  const [fileContent, setFileContent] = useState("")
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [enabled, setEnabled] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const loadData = useCallback(async () => {
    try {
      const [fileList, memStats] = await Promise.all([
        window.api.memory.listFiles(),
        window.api.memory.getStats()
      ])
      if (!mountedRef.current) return
      setFiles(fileList)
      setStats(memStats)
      setEnabled(memStats.enabled)
      setSelectedFile((prev) => {
        if (!prev) return null
        return fileList.find((f) => f.name === prev.name) ?? null
      })
    } catch (e) {
      console.error(e)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => {
    return window.api.memory.onChanged(() => { loadData() })
  }, [loadData])

  useEffect(() => {
    if (!selectedFile) {
      setFileContent("")
      return
    }
    window.api.memory.readFile(selectedFile.name).then((content) => {
      if (mountedRef.current) setFileContent(content)
    }).catch(console.error)
  }, [selectedFile])

  const handleToggleEnabled = useCallback(async () => {
    try {
      const next = !enabled
      await window.api.memory.setEnabled(next)
      if (mountedRef.current) setEnabled(next)
    } catch (e) {
      console.error(e)
    }
  }, [enabled])

  const handleDelete = useCallback(async (file: MemoryFile) => {
    if (file.name === "MEMORY.md") return
    if (!confirm(`确定要删除记忆文件「${file.name}」吗？此操作不可撤销。`)) return
    try {
      await window.api.memory.deleteFile(file.name)
      if (selectedFile?.name === file.name) setSelectedFile(null)
      await loadData()
    } catch (e) {
      console.error(e)
    }
  }, [selectedFile, loadData])

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">Memory</h2>
            <button
              className={cn(
                "text-xs px-2 py-0.5 rounded-full border transition-colors",
                enabled
                  ? "bg-green-500/10 border-green-500/30 text-green-500"
                  : "bg-muted border-border text-muted-foreground"
              )}
              onClick={handleToggleEnabled}
            >
              {enabled ? "已启用" : "已禁用"}
            </button>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-muted/50 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            <span>记忆系统会自动总结对话并在后续会话中回忆</span>
          </div>
          {stats && (
            <div className="flex items-center gap-3 px-2 text-[10px] text-muted-foreground">
              <span>{stats.fileCount} 个文件</span>
              <span>{formatSize(stats.totalSize)}</span>
              <span>索引 {formatSize(stats.indexSize)}</span>
            </div>
          )}
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {files.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Brain className="size-8 opacity-40 mb-2" />
                <p className="text-xs">暂无记忆文件</p>
              </div>
            ) : (
              files.map((file) => (
                <button
                  key={file.name}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/70 text-left transition-colors",
                    selectedFile?.name === file.name ? "bg-muted/70" : "hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedFile(file)}
                >
                  <FileText className={cn(
                    "size-3.5 shrink-0",
                    file.name === "MEMORY.md" ? "text-primary" : "text-muted-foreground"
                  )} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm truncate block">{file.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatSize(file.size)} · {formatDate(file.modifiedAt)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {selectedFile ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold">{selectedFile.name}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatSize(selectedFile.size)} · 修改于 {formatDate(selectedFile.modifiedAt)}
              </p>
            </div>
            {selectedFile.name !== "MEMORY.md" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => handleDelete(selectedFile)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
          <ScrollArea className="flex-1">
            <pre className="p-4 text-sm whitespace-pre-wrap font-mono leading-relaxed text-foreground/90">{fileContent || "(空文件)"}</pre>
          </ScrollArea>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          <div className="text-center space-y-2">
            <Brain className="size-8 mx-auto opacity-40" />
            <p className="text-xs">选择一个记忆文件查看内容</p>
          </div>
        </div>
      )}
    </div>
  )
}
