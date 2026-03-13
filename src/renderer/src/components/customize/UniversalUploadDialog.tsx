import { useState } from "react"
import { Upload, Copy, Check, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface UniversalUploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  resourceType: "skill" | "mcp" | "plugin"
  onUpload: (
    file: File,
    name: string,
    description: string,
    category: string
  ) => Promise<{ success: boolean; error?: string }>
}

export function UniversalUploadDialog({
  open,
  onOpenChange,
  onSuccess,
  resourceType,
  onUpload
}: UniversalUploadDialogProps): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState<"研发场景" | "通用场景">("研发场景")

  const getAcceptedTypes = () => {
    switch (resourceType) {
      case "skill":
        return ".md,.zip"
      case "mcp":
        return ".json"
      case "plugin":
        return ".zip"
      default:
        return "*"
    }
  }

  const getFileTypeDescription = () => {
    switch (resourceType) {
      case "skill":
        return ".md 文件需包含 YAML frontmatter 中的 name 字段；.zip 文件需包含 SKILL.md。SKILL.md必须在根目录"
      case "mcp":
        return "上传 .json 文件，包含 MCP 连接器配置，必须是utf-8"
      case "plugin":
        return "上传 .zip 文件，包含插件代码和配置文件"
      default:
        return "请选择正确的文件类型"
    }
  }

  const validateFile = (selectedFile: File): string | null => {
    const ext = selectedFile.name.toLowerCase().slice(selectedFile.name.lastIndexOf("."))

    switch (resourceType) {
      case "skill":
        if (ext !== ".md" && ext !== ".zip") {
          return "仅支持 .md 或 .zip 文件"
        }
        break
      case "mcp":
        if (ext !== ".json") {
          return "仅支持 .json 文件"
        }
        break
      case "plugin":
        if (ext !== ".zip") {
          return "仅支持 .zip 文件"
        }
        break
      default:
        return "不支持的资源类型"
    }
    return null
  }

  const handleFile = (selectedFile: File) => {
    const validationError = validateFile(selectedFile)
    if (validationError) {
      setError(validationError)
      return
    }

    setFile(selectedFile)
    setError(null)

    // Auto-fill name from filename if not already set
    if (!name) {
      const baseName = selectedFile.name.replace(/\.(md|zip|json)$/i, "")
      setName(baseName)
    }
  }

  const handleUpload = async () => {
    if (!file || !name.trim()) {
      setError("请选择文件并填写名称")
      return
    }

    setError(null)
    setUploading(true)

    try {
      const result = await onUpload(file, name.trim(), description.trim(), category)

      if (result.success) {
        onSuccess()
        onOpenChange(false)
        // Reset form
        setFile(null)
        setName("")
        setDescription("")
      } else {
        setError(result.error || "Upload failed")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setUploading(false)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const droppedFile = e.dataTransfer.files[0]
    if (droppedFile) handleFile(droppedFile)
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }

  const onDragLeave = () => setDragOver(false)

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) handleFile(selectedFile)
    e.target.value = ""
  }

  const handleDialogClose = (open: boolean) => {
    if (!uploading) {
      onOpenChange(open)
      if (!open) {
        // Reset form when closing
        setFile(null)
        setName("")
        setDescription("")
        setError(null)
        setShowJsonTemplate(false)
      }
    }
  }

  const getTitle = () => {
    switch (resourceType) {
      case "skill":
        return "上传技能到市场"
      case "mcp":
        return "上传MCP连接器到市场"
      case "plugin":
        return "上传插件到市场"
      default:
        return "上传到市场"
    }
  }

  const [jsonTemplateCopied, setJsonTemplateCopied] = useState(false)
  const [showJsonTemplate, setShowJsonTemplate] = useState(false)

  const handleCopyJsonTemplate = () => {
    const template = `{
  "mcpServers": {
    "pubmed": {
      "type": "sse",
      "name": "测试MCP服务",
      "url": "http://test.com",
      "enabled": false,
      "advanced": {
        "headers": {
          "Token": "xxx"
        },
        "transport": "sse",
        "reconnect": {
          "enabled": true,
          "maxAttempts": 3,
          "delayMs": 1000
        }
      }
    }
  }
}`
    navigator.clipboard
      .writeText(template)
      .then(() => {
        setJsonTemplateCopied(true)
        setTimeout(() => setJsonTemplateCopied(false), 2000)
      })
      .catch(() => {
        setError("复制模板失败，请手动复制")
      })
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{getTitle()}</DialogTitle>
          <DialogDescription>
            {getFileTypeDescription()}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* File Upload Area */}
          <div
            className={cn(
              "border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer",
              dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-muted-foreground/50",
              uploading && "pointer-events-none opacity-60"
            )}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => document.getElementById("upload-file-input")?.click()}
          >
            <input
              id="upload-file-input"
              type="file"
              accept={getAcceptedTypes()}
              className="hidden"
              onChange={onInputChange}
              disabled={uploading}
            />
            {file ? (
              <div>
                <Upload className="size-8 mx-auto text-green-600 mb-2" />
                <p className="text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">点击重新选择文件</p>
              </div>
            ) : (
              <>
                <Upload className="size-10 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">拖拽文件到此处，或点击选择</p>
                <p className="text-xs text-muted-foreground mt-1">支持: {getAcceptedTypes()}</p>
              </>
            )}
          </div>

          {/* Name Input */}
          <div className="space-y-2">
            <label htmlFor="name" className="block text-sm font-medium">
              名称 *
            </label>
            <Input
              id="name"
              placeholder="输入资源名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={uploading}
            />
          </div>

          {/* Description Input */}
          <div className="space-y-2">
            <label htmlFor="description" className="block text-sm font-medium">
              描述
            </label>
            <textarea
              id="description"
              placeholder="输入资源描述（可选）"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={uploading}
              rows={3}
              className="w-full p-2 text-sm border rounded-md focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-50"
            />
          </div>

          {/* Category Select */}
          <div className="space-y-2">
            <label htmlFor="category" className="block text-sm font-medium">
              选择场景 *
            </label>
            <select
              id="category"
              value={category}
              onChange={(e) => setCategory(e.target.value as "研发场景" | "通用场景")}
              disabled={uploading}
              className="w-full p-2 text-sm border rounded-md focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-50"
            >
              <option value="研发场景">研发场景</option>
              <option value="通用场景">通用场景</option>
            </select>
          </div>

          {/* JSON Template for MCP */}
          {resourceType === "mcp" && (
            <div className="p-4 bg-muted rounded-md">
              <p className="text-sm text-muted-foreground mb-3">
                需要帮助？可以复制 JSON 模板，按需修改后上传。
              </p>
              <div className="flex items-center gap-2 mb-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyJsonTemplate}
                  disabled={uploading}
                >
                  {jsonTemplateCopied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                  {jsonTemplateCopied ? "模板已复制" : "复制 JSON 模板"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowJsonTemplate(!showJsonTemplate)}
                  disabled={uploading}
                >
                  {showJsonTemplate ? <ChevronDown className="mr-2 h-4 w-4" /> : <ChevronRight className="mr-2 h-4 w-4" />}
                  {showJsonTemplate ? "隐藏模板" : "查看模板"}
                </Button>
              </div>
              {showJsonTemplate && (
                <div className="mt-3 h-[150px] overflow-auto">
                  <pre className="bg-background p-3 rounded border text-xs overflow-x-auto">
                    <code>{`{
  "mcpServers": {
    "pubmed": {
      "type": "sse",
      "name": "测试MCP服务",
      "url": "http://test.com",
      "enabled": false,
      "advanced": {
        "headers": {
          "Token": "xxx"
        },
        "transport": "sse",
        "reconnect": {
          "enabled": true,
          "maxAttempts": 3,
          "delayMs": 1000
        }
      }
    }
  }
}`}</code>
                  </pre>
                </div>
              )}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleDialogClose(false)}
            disabled={uploading}
          >
            取消
          </Button>
          <Button
            onClick={handleUpload}
            disabled={uploading || !file || !name.trim()}
          >
            {uploading ? "上传中..." : "上传"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
