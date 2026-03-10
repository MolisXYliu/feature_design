import { useEffect, useState } from "react"
import { Download, Search, ShoppingBag, Sparkles, Plug, Puzzle, Trash2, CheckCircle, Upload, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { AddMcpConnectorDialog } from "./AddMcpConnectorDialog"

// Import the UploadSkillDialog component
function UploadSkillDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}): React.JSX.Element {
  const { open, onOpenChange, onSuccess } = props
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFile = async (file: File) => {
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."))
    if (ext !== ".md" && ext !== ".zip") {
      setError("仅支持 .md 或 .zip 文件")
      return
    }

    setError(null)
    setUploading(true)
    try {
      // For Market, we simulate uploading to marketplace instead of local skills
      console.log(`Uploading skill file: ${file.name} to marketplace`)

      // Mock upload delay
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // In real implementation, this would upload to marketplace server
      // instead of window.api.skills.upload

      onSuccess()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setUploading(false)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }

  const onDragLeave = () => setDragOver(false)

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ""
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>上传技能到市场</DialogTitle>
          <DialogDescription>
            .md 文件需包含 YAML frontmatter 中的 name 字段；.zip 文件需包含 SKILL.md
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
          onClick={() => document.getElementById("upload-skill-market-input")?.click()}
        >
          <input
            id="upload-skill-market-input"
            type="file"
            accept=".md,.zip"
            className="hidden"
            onChange={onInputChange}
            disabled={uploading}
          />
          {uploading ? (
            <p className="text-sm text-muted-foreground">上传到市场中...</p>
          ) : (
            <>
              <Upload className="size-10 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">拖拽文件到此处，或点击选择</p>
            </>
          )}
        </div>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

type MarketItemType = "skills" | "mcps" | "plugins"

interface MarketItem {
  id: string
  name: string
  description: string
  version: string
  author: string
  type: MarketItemType
  downloadCount: number
  tags: string[]
  createdAt: string
  updatedAt: string
}

interface MarketApiResponse {
  success: boolean
  data?: MarketItem[]
  error?: string
}

interface DeleteResponse {
  success: boolean
  error?: string
}

interface DownloadResponse {
  success: boolean
  error?: string
}

// Mock API functions
const mockMarketApi = {
  async getSkills(): Promise<MarketApiResponse> {
    await new Promise((resolve) => setTimeout(resolve, 500))

    return {
      success: true,
      data: [
        {
          id: "skill-1",
          name: "Code Reviewer",
          description:
            "AI-powered code review assistant that helps identify bugs and suggests improvements",
          version: "1.2.0",
          author: "DevTeam",
          type: "skills" as MarketItemType,
          downloadCount: 1250,
          tags: ["code", "review", "ai"],
          createdAt: "2024-01-15",
          updatedAt: "2024-03-01"
        },
        {
          id: "skill-2",
          name: "Document Generator",
          description: "Automatically generates technical documentation from code comments",
          version: "2.1.3",
          author: "DocMaster",
          type: "skills" as MarketItemType,
          downloadCount: 890,
          tags: ["documentation", "generator", "markdown"],
          createdAt: "2024-02-10",
          updatedAt: "2024-03-05"
        }
      ]
    }
  },

  async getMcps(): Promise<MarketApiResponse> {
    await new Promise((resolve) => setTimeout(resolve, 500))

    return {
      success: true,
      data: [
        {
          id: "mcp-1",
          name: "GitHub Connector",
          description: "Connect to GitHub API for repository management and issue tracking",
          version: "3.0.1",
          author: "GitTools",
          type: "mcps" as MarketItemType,
          downloadCount: 2340,
          tags: ["github", "api", "repository"],
          createdAt: "2024-01-05",
          updatedAt: "2024-03-08"
        },
        {
          id: "mcp-2",
          name: "Slack Integration",
          description: "Send messages and notifications to Slack channels",
          version: "1.5.2",
          author: "SlackTeam",
          type: "mcps" as MarketItemType,
          downloadCount: 1780,
          tags: ["slack", "notification", "integration"],
          createdAt: "2024-02-20",
          updatedAt: "2024-03-03"
        }
      ]
    }
  },

  async getPlugins(): Promise<MarketApiResponse> {
    await new Promise((resolve) => setTimeout(resolve, 500))

    return {
      success: true,
      data: [
        {
          id: "plugin-1",
          name: "Theme Manager",
          description: "Manage and switch between different UI themes",
          version: "1.0.5",
          author: "UITeam",
          type: "plugins" as MarketItemType,
          downloadCount: 567,
          tags: ["theme", "ui", "customization"],
          createdAt: "2024-02-01",
          updatedAt: "2024-03-07"
        },
        {
          id: "plugin-2",
          name: "Backup Tool",
          description: "Automatic backup and restore functionality",
          version: "2.3.1",
          author: "BackupCorp",
          type: "plugins" as MarketItemType,
          downloadCount: 1123,
          tags: ["backup", "restore", "data"],
          createdAt: "2024-01-25",
          updatedAt: "2024-03-02"
        }
      ]
    }
  },

  async deleteItem(_id: string, _type: MarketItemType): Promise<DeleteResponse> {
    await new Promise((resolve) => setTimeout(resolve, 300))

    return {
      success: true
    }
  },

  async downloadItem(id: string, type: MarketItemType): Promise<DownloadResponse> {
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // For skills, we need to create mock skill data that can be uploaded
    if (type === "skills") {
      // Create a mock skill markdown file content
      const skillName = id === "skill-1" ? "Code Reviewer" : "Document Generator"
      const skillContent = `---
name: "${skillName}"
description: "Downloaded from Market"
---

# ${skillName}

This skill was downloaded from the Market.

## Usage

This is a sample skill downloaded from the marketplace.
`

      try {
        // Convert the skill content to a file buffer
        const buffer = new TextEncoder().encode(skillContent).buffer
        const fileName = `${skillName.toLowerCase().replace(/\s+/g, "-")}.md`

        // Use the existing skills upload API
        if (typeof window.api?.skills?.upload === "function") {
          const uploadResult = await window.api.skills.upload(buffer, fileName)
          return {
            success: uploadResult.success,
            error: uploadResult.error
          }
        } else {
          return {
            success: false,
            error: "Skills upload API not available"
          }
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Upload failed"
        }
      }
    }

    // For MCPs and Plugins, just return success for now
    return {
      success: true
    }
  },

  async uploadItem(file: File, type: MarketItemType): Promise<DownloadResponse> {
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Different upload logic for different types
    if (type === "skills") {
      // For skills, we only accept zip files and upload them to the marketplace
      const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."))
      if (ext !== ".zip") {
        return {
          success: false,
          error: "Skills只支持zip文件上传"
        }
      }

      try {
        // Mock uploading zip file to marketplace
        console.log(`Uploading skill zip file: ${file.name} to marketplace`)

        // In real implementation, this would:
        // 1. Validate the zip file contains SKILL.md
        // 2. Extract metadata from the skill
        // 3. Upload to marketplace server
        // 4. Return success/failure

        return {
          success: true
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Upload failed"
        }
      }
    }

    // For MCPs, this method is not used anymore - we use the form instead
    if (type === "mcps") {
      return {
        success: false,
        error: "MCP连接器请使用表单添加"
      }
    }

    if (type === "plugins") {
      return {
        success: false,
        error: "Plugin上传功能尚未实现"
      }
    }

    return {
      success: false,
      error: "未知的上传类型"
    }
  },

  // New method for MCP connector submission to marketplace
  async submitMcpConnector(connector: any): Promise<DownloadResponse> {
    await new Promise((resolve) => setTimeout(resolve, 1000))

    try {
      // Mock submitting MCP connector to marketplace
      console.log(`Submitting MCP connector: ${connector.name} to marketplace`)

      // In real implementation, this would:
      // 1. Validate the MCP configuration
      // 2. Test connectivity (optional)
      // 3. Submit to marketplace server
      // 4. Return success/failure

      return {
        success: true
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Submit failed"
      }
    }
  }
}

function MarketItemCard({
  item,
  onDelete,
  onDownload
}: {
  item: MarketItem
  onDelete: (item: MarketItem) => void
  onDownload: (item: MarketItem) => void
}): React.JSX.Element {
  const [isDownloading, setIsDownloading] = useState(false)

  const handleDownload = async () => {
    setIsDownloading(true)
    try {
      await onDownload(item)
    } finally {
      setIsDownloading(false)
    }
  }

  const getIcon = () => {
    switch (item.type) {
      case "skills":
        return <Sparkles className="size-4" />
      case "mcps":
        return <Plug className="size-4" />
      case "plugins":
        return <Puzzle className="size-4" />
      default:
        return <ShoppingBag className="size-4" />
    }
  }

  return (
    <div className="border rounded-lg p-4 space-y-3 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          {getIcon()}
          <h3 className="font-medium text-sm">{item.name}</h3>
          <Badge variant="secondary" className="text-xs">
            {item.version}
          </Badge>
        </div>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handleDownload}
            disabled={isDownloading}
          >
            <Download className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={() => onDelete(item)}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {item.tags.slice(0, 2).map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs px-1.5 py-0">
              {tag}
            </Badge>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">{item.downloadCount} downloads</div>
      </div>

      <div className="text-xs text-muted-foreground">
        By {item.author} • Updated {new Date(item.updatedAt).toLocaleDateString()}
      </div>
    </div>
  )
}

export function MarketPanel(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<MarketItemType>("skills")
  const [searchQuery, setSearchQuery] = useState("")
  const [skillsData, setSkillsData] = useState<MarketItem[]>([])
  const [mcpsData, setMcpsData] = useState<MarketItem[]>([])
  const [pluginsData, setPluginsData] = useState<MarketItem[]>([])
  const [loading, setLoading] = useState(false)
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; item: MarketItem | null }>({
    open: false,
    item: null
  })
  const [downloadSuccess, setDownloadSuccess] = useState<{ open: boolean; itemName: string }>({
    open: false,
    itemName: ""
  })
  const [skillUploadDialog, setSkillUploadDialog] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState<{ open: boolean; type: MarketItemType }>({
    open: false,
    type: "skills"
  })
  const [mcpConnectorDialog, setMcpConnectorDialog] = useState(false)

  // Load data for current tab
  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      try {
        switch (activeTab) {
          case "skills":
            if (skillsData.length === 0) {
              const response = await mockMarketApi.getSkills()
              if (response.success && response.data) {
                setSkillsData(response.data)
              }
            }
            break
          case "mcps":
            if (mcpsData.length === 0) {
              const response = await mockMarketApi.getMcps()
              if (response.success && response.data) {
                setMcpsData(response.data)
              }
            }
            break
          case "plugins":
            if (pluginsData.length === 0) {
              const response = await mockMarketApi.getPlugins()
              if (response.success && response.data) {
                setPluginsData(response.data)
              }
            }
            break
        }
      } catch (error) {
        console.error("Failed to load market data:", error)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [activeTab, skillsData.length, mcpsData.length, pluginsData.length])

  const getCurrentData = () => {
    switch (activeTab) {
      case "skills":
        return skillsData
      case "mcps":
        return mcpsData
      case "plugins":
        return pluginsData
      default:
        return []
    }
  }

  const filteredData = getCurrentData().filter(
    (item) =>
      item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.tags.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()))
  )

  const handleDelete = (item: MarketItem) => {
    setDeleteDialog({ open: true, item })
  }

  const confirmDelete = async () => {
    if (!deleteDialog.item) return

    try {
      const response = await mockMarketApi.deleteItem(deleteDialog.item.id, deleteDialog.item.type)
      if (response.success) {
        // Remove item from local state
        switch (deleteDialog.item.type) {
          case "skills":
            setSkillsData((prev) => prev.filter((item) => item.id !== deleteDialog.item!.id))
            break
          case "mcps":
            setMcpsData((prev) => prev.filter((item) => item.id !== deleteDialog.item!.id))
            break
          case "plugins":
            setPluginsData((prev) => prev.filter((item) => item.id !== deleteDialog.item!.id))
            break
        }
      }
    } catch (error) {
      console.error("Failed to delete item:", error)
    } finally {
      setDeleteDialog({ open: false, item: null })
    }
  }

  const handleDownload = async (item: MarketItem) => {
    try {
      const response = await mockMarketApi.downloadItem(item.id, item.type)
      if (response.success) {
        console.log(`Downloaded ${item.name}`)

        // Show success message
        setDownloadSuccess({ open: true, itemName: item.name })

        // For skills, the item is now available in the Skills panel
        if (item.type === "skills") {
          // Optional: You could trigger a refresh of the Skills panel here
          // by emitting an event or using a global state management solution
        }
      } else {
        console.error("Download failed:", response.error)
        // You could show an error dialog here
      }
    } catch (error) {
      console.error("Failed to download item:", error)
    }
  }

  const handleUploadSuccess = () => {
    setUploadSuccess({ open: true, type: activeTab })
    // Optionally reload the current tab data
    switch (activeTab) {
      case "skills":
        setSkillsData([])
        break
      case "mcps":
        setMcpsData([])
        break
      case "plugins":
        setPluginsData([])
        break
    }
  }

  const handleUploadClick = () => {
    if (activeTab === "skills") {
      // For Skills, open the skill upload dialog
      setSkillUploadDialog(true)
    } else if (activeTab === "mcps") {
      // For MCPs, open the connector dialog
      setMcpConnectorDialog(true)
    } else {
      // For plugins, show not available message
      // Could show a disabled state or notification
      console.log("Plugin upload not available")
    }
  }

  const handleMcpConnectorSuccess = async () => {
    // This is called when MCP connector is successfully added via the form
    // We simulate submitting it to the marketplace
    try {
      const response = await mockMarketApi.submitMcpConnector({ name: "New MCP Connector" })
      if (response.success) {
        setUploadSuccess({ open: true, type: "mcps" })
        // Optionally reload MCPs data
        setMcpsData([])
      }
    } catch (error) {
      console.error("Failed to submit MCP connector to marketplace:", error)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ShoppingBag className="size-5" />
            <h2 className="font-semibold">Market</h2>
          </div>
          <Button
            size="sm"
            onClick={handleUploadClick}
            className="flex items-center gap-2"
            disabled={activeTab === "plugins"}
          >
            <Plus className="size-4" />
            {activeTab === "skills" ? "上传技能" : activeTab === "mcps" ? "添加连接器" : "上传"}
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search marketplace..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as MarketItemType)}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <div className="px-4 pt-3">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="skills" className="text-xs">
              <Sparkles className="size-3 mr-1" />
              Skills
            </TabsTrigger>
            <TabsTrigger value="mcps" className="text-xs">
              <Plug className="size-3 mr-1" />
              MCPs
            </TabsTrigger>
            <TabsTrigger value="plugins" className="text-xs">
              <Puzzle className="size-3 mr-1" />
              Plugins
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="flex-1 overflow-hidden">
          <TabsContent value={activeTab} className="mt-0 h-full">
            <ScrollArea className="h-full">
              <div className="p-4 space-y-3">
                {loading ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">Loading...</div>
                ) : filteredData.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    {searchQuery ? "No items found matching your search" : "No items available"}
                  </div>
                ) : (
                  filteredData.map((item) => (
                    <MarketItemCard
                      key={item.id}
                      item={item}
                      onDelete={handleDelete}
                      onDownload={handleDownload}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </div>
      </Tabs>

      <Dialog
        open={deleteDialog.open}
        onOpenChange={(open) => setDeleteDialog({ open, item: null })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{deleteDialog.item?.name}&quot;? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialog({ open: false, item: null })}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={downloadSuccess.open}
        onOpenChange={(open) => setDownloadSuccess({ open, itemName: "" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="size-5 text-green-500" />
              Download Successful
            </DialogTitle>
            <DialogDescription>
              &quot;{downloadSuccess.itemName}&quot; has been successfully downloaded and added to your {activeTab === "skills" ? "Skills" : activeTab === "mcps" ? "MCPs" : "Plugins"}.
              {activeTab === "skills" && " You can find it in the Skills panel."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDownloadSuccess({ open: false, itemName: "" })}>
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Use UploadSkillDialog for Skills */}
      <UploadSkillDialog
        open={skillUploadDialog}
        onOpenChange={setSkillUploadDialog}
        onSuccess={handleUploadSuccess}
      />

      {/* Use AddMcpConnectorDialog for MCPs */}
      <AddMcpConnectorDialog
        open={mcpConnectorDialog}
        onOpenChange={setMcpConnectorDialog}
        onSuccess={handleMcpConnectorSuccess}
      />

      <Dialog
        open={uploadSuccess.open}
        onOpenChange={(open) => setUploadSuccess({ open, type: "skills" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="size-5 text-green-500" />
              上传成功
            </DialogTitle>
            <DialogDescription>
              您的{uploadSuccess.type === "skills" ? "技能" : uploadSuccess.type === "mcps" ? "MCP连接器" : "插件"}已成功上传到Market！
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setUploadSuccess({ open: false, type: "skills" })}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
