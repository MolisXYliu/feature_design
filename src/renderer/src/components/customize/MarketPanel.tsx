import { useEffect, useState } from "react"
import {
  Download,
  Search,
  ShoppingBag,
  Sparkles,
  Plug,
  Puzzle,
  Trash2,
  CheckCircle,
  Upload,
  Plus
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { UniversalUploadDialog } from "./UniversalUploadDialog"

type MarketItemType = "skill" | "mcp" | "plugin"

interface MarketItem {
  name: string
  description: string
  filename: string
  created_at: string
  // Only keep essential UI fields for compatibility
  id?: string
  type?: MarketItemType
  // Add field to track if user can delete this item
  canDelete?: boolean
}

interface MarketListResponse {
  type: string
  items: MarketItem[]
}

interface MarketUploadResponse {
  type: string
  name: string
  message: string
  s3_path: string
}

interface MarketDeleteResponse {
  message: string
}

interface MarketApiResponse {
  success: boolean
  data?: MarketItem[]
  error?: string
}

interface DownloadResponse {
  success: boolean
  error?: string
}

// Updated API endpoints to match exact specification
const API_BASE_URL = "/marketplace" // Replace with actual API URL
const ENDPOINTS = {
  list: (resourceType: string) => `${API_BASE_URL}/list/${resourceType}`,
  upload: `${API_BASE_URL}/upload`,
  download: (resourceType: string, name: string) => `${API_BASE_URL}/download/${resourceType}/${name}`,
  delete: (resourceType: string, name: string) => `${API_BASE_URL}/${resourceType}/${name}`
}


// MCP Connector interface
interface McpConnector {
  name: string
  description?: string
  version?: string
}

// Updated API functions with the new endpoints
const marketApi = {
  async getSkills(): Promise<MarketApiResponse> {
    try {
      console.log("Fetching skills from API...")
      const response = await fetch(ENDPOINTS.list("skill"), {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
          // Remove placeholder auth token for now
        }
      })

      if (!response.ok) {
        console.error(`API request failed: ${response.status} ${response.statusText}`)
        const errorText = await response.text()
        console.error('Response body:', errorText)
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const contentType = response.headers.get("content-type")
      if (!contentType || !contentType.includes("application/json")) {
        const responseText = await response.text()
        console.error('Expected JSON but received:', responseText.substring(0, 200))
        throw new Error('Response is not JSON')
      }

      const data: MarketListResponse = await response.json()
      return {
        success: true,
        data: data.items || []
      }
    } catch (error) {
      console.warn("API call failed, using mock data:", error)
      return mockMarketApi.getSkills()
    }
  },

  async getMcps(): Promise<MarketApiResponse> {
    try {
      console.log("Fetching MCPs from API...")
      const response = await fetch(ENDPOINTS.list("mcp"), {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
          // Remove placeholder auth token for now
        }
      })

      if (!response.ok) {
        console.error(`API request failed: ${response.status} ${response.statusText}`)
        const errorText = await response.text()
        console.error('Response body:', errorText)
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const contentType = response.headers.get("content-type")
      if (!contentType || !contentType.includes("application/json")) {
        const responseText = await response.text()
        console.error('Expected JSON but received:', responseText.substring(0, 200))
        throw new Error('Response is not JSON')
      }

      const data: MarketListResponse = await response.json()
      return {
        success: true,
        data: data.items || []
      }
    } catch (error) {
      console.warn("API call failed, using mock data:", error)
      return mockMarketApi.getMcps()
    }
  },

  async getPlugins(): Promise<MarketApiResponse> {
    try {
      console.log("Fetching plugins from API...")
      const response = await fetch(ENDPOINTS.list("plugin"), {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
          // Remove placeholder auth token for now
        }
      })

      if (!response.ok) {
        console.error(`API request failed: ${response.status} ${response.statusText}`)
        const errorText = await response.text()
        console.error('Response body:', errorText)
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const contentType = response.headers.get("content-type")
      if (!contentType || !contentType.includes("application/json")) {
        const responseText = await response.text()
        console.error('Expected JSON but received:', responseText.substring(0, 200))
        throw new Error('Response is not JSON')
      }

      const data: MarketListResponse = await response.json()
      return {
        success: true,
        data: data.items || []
      }
    } catch (error) {
      console.warn("API call failed, using mock data:", error)
      return mockMarketApi.getPlugins()
    }
  },

  async deleteItem(name: string, type: MarketItemType): Promise<MarketDeleteResponse> {
    try {
      console.log(`Deleting ${type} item: ${name}`)
      const response = await fetch(ENDPOINTS.delete(type, name), {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer your-api-token"
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data: MarketDeleteResponse = await response.json()
      return data
    } catch (error) {
      console.warn("API delete failed, using mock response:", error)
      return mockMarketApi.deleteItem(name, type)
    }
  },

  async downloadItem(name: string, type: MarketItemType): Promise<DownloadResponse> {
    try {
      console.log(`Downloading ${type} item: ${name}`)
      const response = await fetch(ENDPOINTS.download(type, name), {
        method: "GET",
        headers: {
          Authorization: "Bearer your-api-token"
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      // For the actual download API, we get a file blob
      const blob = await response.blob()
      const contentDisposition = response.headers.get("Content-Disposition")
      const filename = contentDisposition?.match(/filename="([^"]+)"/)?.[1] || `${name}.zip`

      // For skills, we need to handle the downloaded file
      if (type === "skill") {
        try {
          const arrayBuffer = await blob.arrayBuffer()
          if (typeof window.api?.skills?.upload === "function") {
            const uploadResult = await window.api.skills.upload(arrayBuffer, filename)
            return {
              success: uploadResult.success,
              error: uploadResult.error
            }
          }
        } catch (uploadError) {
          console.error("Failed to upload downloaded skill:", uploadError)
          return {
            success: false,
            error: "Failed to save downloaded skill"
          }
        }
      }

      // For MCPs and Plugins, handle file download
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)

      return { success: true }
    } catch (error) {
      console.warn("API download failed, using mock response:", error)
      return mockMarketApi.downloadItem(name, type)
    }
  },

  async uploadFile(file: File, resourceType: string, name: string, description: string): Promise<{ success: boolean; data?: MarketUploadResponse; error?: string }> {
    try {
      console.log(`Uploading ${resourceType} file: ${file.name}`)

      const formData = new FormData()
      formData.append("resource_type", resourceType)
      formData.append("name", name)
      formData.append("description", description)
      formData.append("file", file)

      const response = await fetch(ENDPOINTS.upload, {
        method: "POST",
        headers: {
          Authorization: "Bearer your-api-token"
        },
        body: formData
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data: MarketUploadResponse = await response.json()
      return {
        success: true,
        data
      }
    } catch (error) {
      console.warn("API upload failed:", error)
      return {
        success: false,
        error: error instanceof Error ? error.message : "Upload failed"
      }
    }
  },

  async submitMcpConnector(connector: any): Promise<DownloadResponse> {
    try {
      console.log(`Submitting MCP connector: ${connector.name}`)

      // Convert connector config to JSON file
      const jsonContent = JSON.stringify(connector, null, 2)
      const blob = new Blob([jsonContent], { type: "application/json" })
      const file = new File([blob], `${connector.name}.json`, { type: "application/json" })

      const result = await this.uploadFile(file, "mcp", connector.name, connector.description || "")
      return {
        success: result.success,
        error: result.error
      }
    } catch (error) {
      console.warn("API submit failed, using mock response:", error)
      return mockMarketApi.submitMcpConnector(connector)
    }
  }
}

// Mock API functions - updated to match new interface
const mockMarketApi = {
  async getSkills(): Promise<MarketApiResponse> {
    await new Promise((resolve) => setTimeout(resolve, 500))

    return {
      success: true,
      data: [
        {
          name: "Code Reviewer",
          description: "AI-powered code review assistant that helps identify bugs and suggests improvements",
          filename: "code-reviewer.zip",
          created_at: "2024-01-15 10:30:00",
          id: "skill-1",
          type: "skill" as MarketItemType
        },
        {
          name: "Document Generator",
          description: "Automatically generates technical documentation from code comments",
          filename: "doc-generator.zip",
          created_at: "2024-02-10 14:20:00",
          id: "skill-2",
          type: "skill" as MarketItemType
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
          name: "GitHub Connector",
          description: "Connect to GitHub API for repository management and issue tracking",
          filename: "github-connector.json",
          created_at: "2024-01-05 09:15:00",
          id: "mcp-1",
          type: "mcp" as MarketItemType
        },
        {
          name: "Slack Integration",
          description: "Send messages and notifications to Slack channels",
          filename: "slack-integration.json",
          created_at: "2024-02-20 16:45:00",
          id: "mcp-2",
          type: "mcp" as MarketItemType
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
          name: "Theme Manager",
          description: "Manage and switch between different UI themes",
          filename: "theme-manager.zip",
          created_at: "2024-02-01 11:20:00",
          id: "plugin-1",
          type: "plugin" as MarketItemType
        },
        {
          name: "Syntax Highlighter",
          description: "Enhanced syntax highlighting for multiple programming languages",
          filename: "syntax-highlighter.zip",
          created_at: "2024-02-15 13:10:00",
          id: "plugin-2",
          type: "plugin" as MarketItemType
        }
      ]
    }
  },

  async deleteItem(name: string, type: MarketItemType): Promise<MarketDeleteResponse> {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return { message: `Successfully deleted ${name}` }
  },

  async downloadItem(name: string, type: MarketItemType): Promise<DownloadResponse> {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    return { success: true }
  },

  async submitMcpConnector(connector: any): Promise<DownloadResponse> {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return { success: true }
  }
}

// Local storage helper functions for tracking user uploads
const UPLOADED_ITEMS_KEY = "marketplace_uploaded_items"

interface UploadedItemRecord {
  name: string
  type: MarketItemType
  uploadedAt: string
}

const localStorageHelper = {
  // Get all items uploaded by current user
  getUploadedItems(): UploadedItemRecord[] {
    try {
      const stored = localStorage.getItem(UPLOADED_ITEMS_KEY)
      return stored ? JSON.parse(stored) : []
    } catch {
      return []
    }
  },

  // Add item to uploaded items list
  addUploadedItem(name: string, type: MarketItemType): void {
    try {
      const items = this.getUploadedItems()
      const newItem: UploadedItemRecord = {
        name,
        type,
        uploadedAt: new Date().toISOString()
      }
      // Remove existing item with same name and type if exists
      const filteredItems = items.filter(item => !(item.name === name && item.type === type))
      filteredItems.push(newItem)
      localStorage.setItem(UPLOADED_ITEMS_KEY, JSON.stringify(filteredItems))
    } catch (error) {
      console.error("Failed to save uploaded item to localStorage:", error)
    }
  },

  // Remove item from uploaded items list
  removeUploadedItem(name: string, type: MarketItemType): void {
    try {
      const items = this.getUploadedItems()
      const filteredItems = items.filter(item => !(item.name === name && item.type === type))
      localStorage.setItem(UPLOADED_ITEMS_KEY, JSON.stringify(filteredItems))
    } catch (error) {
      console.error("Failed to remove uploaded item from localStorage:", error)
    }
  },

  // Check if user can delete this item (user uploaded it)
  canDeleteItem(name: string, type: MarketItemType): boolean {
    const items = this.getUploadedItems()
    return items.some(item => item.name === name && item.type === type)
  }
}

interface MarketItemCardProps {
  item: MarketItem
  onDelete: (item: MarketItem) => void
  onDownload: (item: MarketItem) => void
  isDownloading?: boolean
}

function MarketItemCard({ item, onDelete, onDownload, isDownloading = false }: MarketItemCardProps) {
  const handleDownload = () => {
    onDownload(item)
  }

  return (
    <div className="p-4 rounded-lg border border-border hover:border-accent-foreground/20 transition-colors">
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-medium text-sm line-clamp-1 flex-1">{item.name}</h3>
        <div className="flex items-center gap-1 ml-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handleDownload}
            disabled={isDownloading}
          >
            {isDownloading ? (
              <div className="size-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <Download className="size-3" />
            )}
          </Button>
          {item.canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(item)}
            >
              <Trash2 className="size-3" />
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>

      <div className="text-xs text-muted-foreground">
        {item.filename} • Created {new Date(item.created_at).toLocaleDateString()}
      </div>
    </div>
  )
}

export function MarketPanel(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<MarketItemType>("skill")
  const [searchQuery, setSearchQuery] = useState("")
  const [skillsData, setSkillsData] = useState<MarketItem[]>([])
  const [mcpsData, setMcpsData] = useState<MarketItem[]>([])
  const [pluginsData, setPluginsData] = useState<MarketItem[]>([])
  const [loading, setLoading] = useState(false)
  const [downloadingItems, setDownloadingItems] = useState<Set<string>>(new Set())
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; item: MarketItem | null }>({
    open: false,
    item: null
  })
  const [downloadSuccess, setDownloadSuccess] = useState<{ open: boolean; itemName: string }>({
    open: false,
    itemName: ""
  })
  const [uploadDialog, setUploadDialog] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState<{ open: boolean; type: MarketItemType }>({
    open: false,
    type: "skill"
  })

  // Load data for current tab
  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      try {
        let response: MarketApiResponse
        switch (activeTab) {
          case "skill":
            if (skillsData.length === 0) {
              response = await marketApi.getSkills()
              if (response.success && response.data) {
                // Add canDelete flag to each item
                const dataWithDeleteFlag = response.data.map(item => ({
                  ...item,
                  canDelete: localStorageHelper.canDeleteItem(item.name, "skill")
                }))
                setSkillsData(dataWithDeleteFlag)
              }
            }
            break
          case "mcp":
            if (mcpsData.length === 0) {
              response = await marketApi.getMcps()
              if (response.success && response.data) {
                // Add canDelete flag to each item
                const dataWithDeleteFlag = response.data.map(item => ({
                  ...item,
                  canDelete: localStorageHelper.canDeleteItem(item.name, "mcp")
                }))
                setMcpsData(dataWithDeleteFlag)
              }
            }
            break
          case "plugin":
            if (pluginsData.length === 0) {
              response = await marketApi.getPlugins()
              if (response.success && response.data) {
                // Add canDelete flag to each item
                const dataWithDeleteFlag = response.data.map(item => ({
                  ...item,
                  canDelete: localStorageHelper.canDeleteItem(item.name, "plugin")
                }))
                setPluginsData(dataWithDeleteFlag)
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
      case "skill":
        return skillsData
      case "mcp":
        return mcpsData
      case "plugin":
        return pluginsData
      default:
        return []
    }
  }

  const filteredData = getCurrentData().filter(
    (item) =>
      item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleDelete = (item: MarketItem) => {
    setDeleteDialog({ open: true, item })
  }

  const confirmDelete = async () => {
    if (!deleteDialog.item) return

    try {
      const itemName = deleteDialog.item.name || deleteDialog.item.id
      const itemType = deleteDialog.item.type!
      const response = await marketApi.deleteItem(itemName, itemType)
      if (response.message) {
        // Remove item from localStorage tracking
        localStorageHelper.removeUploadedItem(itemName, itemType)

        // Remove item from local state
        const itemId = deleteDialog.item.id || deleteDialog.item.name
        switch (itemType) {
          case "skill":
            setSkillsData((prev) => prev.filter((item) => (item.id || item.name) !== itemId))
            break
          case "mcp":
            setMcpsData((prev) => prev.filter((item) => (item.id || item.name) !== itemId))
            break
          case "plugin":
            setPluginsData((prev) => prev.filter((item) => (item.id || item.name) !== itemId))
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
    const itemKey = item.id || item.name

    // Add to downloading set
    setDownloadingItems(prev => new Set(prev).add(itemKey))

    try {
      const itemName = item.name || item.id
      // Use current activeTab as the type
      const response = await marketApi.downloadItem(itemName, activeTab)
      if (response.success) {
        console.log(`Downloaded ${item.name}`)

        // Show success message
        setDownloadSuccess({ open: true, itemName: item.name })

        // For skills, the item is now available in the Skills panel
        if (activeTab === "skill") {
          // Optional: You could trigger a refresh of the Skills panel here
          // by emitting an event or using a global state management solution
        }
      } else {
        console.error("Download failed:", response.error)
        // You could show an error dialog here
      }
    } catch (error) {
      console.error("Failed to download item:", error)
    } finally {
      // Remove from downloading set
      setDownloadingItems(prev => {
        const newSet = new Set(prev)
        newSet.delete(itemKey)
        return newSet
      })
    }
  }

  const handleUploadSuccess = () => {
    setUploadSuccess({ open: true, type: activeTab })
    // Reload the current tab data
    switch (activeTab) {
      case "skill":
        setSkillsData([])
        break
      case "mcp":
        setMcpsData([])
        break
      case "plugin":
        setPluginsData([])
        break
    }
  }

  const handleUploadClick = () => {
    // Open upload dialog for all types
    setUploadDialog(true)
  }

  const handleUniversalUpload = async (file: File, name: string, description: string) => {
    const result = await marketApi.uploadFile(file, activeTab, name, description)

    // If upload is successful, record it in localStorage
    if (result.success) {
      localStorageHelper.addUploadedItem(name, activeTab)
    }

    return result
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ShoppingBag className="size-5" />
            <h2 className="font-semibold">公共市场</h2>
          </div>
          <Button
            size="sm"
            onClick={handleUploadClick}
            className="flex items-center gap-2"
          >
            <Plus className="size-4" />
            {activeTab === "skill" ? "上传技能" : activeTab === "mcp" ? "上传连接器" : "上传插件"}
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="搜索公共市场里的工具"
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
            <TabsTrigger value="skill" className="text-xs">
              <Sparkles className="size-3 mr-1" />
              Skills
            </TabsTrigger>
            <TabsTrigger value="mcp" className="text-xs">
              <Plug className="size-3 mr-1" />
              MCPs
            </TabsTrigger>
            <TabsTrigger value="plugin" className="text-xs">
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
                      isDownloading={downloadingItems.has(item.id || item.name)}
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
              &quot;{downloadSuccess.itemName}&quot; has been successfully downloaded and added to your {activeTab === "skill" ? "Skills" : activeTab === "mcp" ? "MCPs" : "Plugins"}.
              {activeTab === "skill" && " You can find it in the Skills panel."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDownloadSuccess({ open: false, itemName: "" })}>
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Use UniversalUploadDialog for all types */}
      <UniversalUploadDialog
        open={uploadDialog}
        onOpenChange={setUploadDialog}
        onSuccess={handleUploadSuccess}
        resourceType={activeTab}
        onUpload={handleUniversalUpload}
      />

      <Dialog
        open={uploadSuccess.open}
        onOpenChange={(open) => setUploadSuccess({ open, type: "skill" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="size-5 text-green-500" />
              上传成功
            </DialogTitle>
            <DialogDescription>
              您的{uploadSuccess.type === "skill" ? "技能" : uploadSuccess.type === "mcp" ? "MCP连接器" : "插件"}已成功上传到Market！
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setUploadSuccess({ open: false, type: "skill" })}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
