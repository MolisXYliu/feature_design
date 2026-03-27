import { useEffect, useState, useMemo, useRef } from "react"
import { Loader2, AlertCircle, FileCode } from "lucide-react"
import { useCurrentThread } from "@/lib/thread-context"
import { getFileType, isBinaryFile } from "@/lib/file-types"
import { CodeViewer } from "./CodeViewer"
import { ImageViewer } from "./ImageViewer"
import { MediaViewer } from "./MediaViewer"
import { PDFViewer } from "./PDFViewer"
import { BinaryFileViewer } from "./BinaryFileViewer"
import MarkdownPreview from "@/components/ui/MarkdownPreview/MarkdownPreview"
import { HtmlPreview } from "@/components/chat/previews/HtmlPreview"

interface FileViewerProps {
  filePath: string
  threadId: string
  externalFullPath?: string
  htmlFillHeight?: boolean
  reloadToken?: number
}

export function FileViewer({
  filePath,
  threadId,
  externalFullPath,
  htmlFillHeight = false,
  reloadToken
}: FileViewerProps): React.JSX.Element | null {
  const { fileContents, setFileContents } = useCurrentThread(threadId)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [binaryContent, setBinaryContent] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState<number | undefined>()
  const cacheKey = externalFullPath || filePath
  const displayPath = externalFullPath || filePath

  // Get file type info
  const fileName = displayPath.split("/").pop() || displayPath
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() ?? "" : ""
  const markdownLike = ext === "md" || ext === "markdown" || ext === "mdx"
  const htmlLike = ext === "html" || ext === "htm"
  const fileTypeInfo = useMemo(() => getFileType(fileName), [fileName])
  const isBinary = useMemo(() => isBinaryFile(fileName), [fileName])
  const lastLoadedReloadTokenRef = useRef<number | undefined>(undefined)

  // Get cached content or load it
  const content = fileContents[cacheKey]

  // Reset state when filePath changes
  useEffect(() => {
    setError(null)
    setBinaryContent(null)
    setFileSize(undefined)
  }, [cacheKey, reloadToken])

  // Load file content (text or binary depending on file type)
  useEffect(() => {
    async function loadFile(): Promise<void> {
      const shouldForceReload =
        reloadToken !== undefined && lastLoadedReloadTokenRef.current !== reloadToken

      // Skip if already loaded
      if (!shouldForceReload && (content !== undefined || binaryContent !== null)) {
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        if (isBinary) {
          // Read as binary file (base64)
          const result = externalFullPath
            ? await window.api.workspace.readExternalBinaryFile(externalFullPath)
            : await window.api.workspace.readBinaryFile(threadId, filePath)
          if (result.success && result.content !== undefined) {
            setBinaryContent(result.content)
            setFileSize(result.size)
            lastLoadedReloadTokenRef.current = reloadToken
          } else {
            setError(result.error || "Failed to read file")
          }
        } else {
          // Read as text file
          const result = externalFullPath
            ? await window.api.workspace.readExternalFile(externalFullPath)
            : await window.api.workspace.readFile(threadId, filePath)
          if (result.success && result.content !== undefined) {
            setFileContents(cacheKey, result.content)
            setFileSize(result.size)
            lastLoadedReloadTokenRef.current = reloadToken
          } else {
            setError(result.error || "Failed to read file")
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to read file")
      } finally {
        setIsLoading(false)
      }
    }

    loadFile()
  }, [
    threadId,
    filePath,
    content,
    binaryContent,
    setFileContents,
    isBinary,
    externalFullPath,
    cacheKey,
    reloadToken
  ])

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin mr-2" />
        <span>Loading file...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground gap-3 p-8">
        <AlertCircle className="size-10 text-status-critical" />
        <div className="text-center">
          <div className="font-medium text-foreground mb-1">Failed to load file</div>
          <div className="text-sm">{error}</div>
        </div>
      </div>
    )
  }

  if (content === undefined && binaryContent === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <FileCode className="size-6 mr-2" />
        <span>No content</span>
      </div>
    )
  }

  // Route to appropriate viewer based on file type
  if (fileTypeInfo.type === "image" && binaryContent) {
    return (
      <ImageViewer
        filePath={displayPath}
        base64Content={binaryContent}
        mimeType={fileTypeInfo.mimeType || "image/png"}
      />
    )
  }

  if (fileTypeInfo.type === "video" && binaryContent) {
    return (
      <MediaViewer
        filePath={displayPath}
        base64Content={binaryContent}
        mimeType={fileTypeInfo.mimeType || "video/mp4"}
        mediaType="video"
      />
    )
  }

  if (fileTypeInfo.type === "audio" && binaryContent) {
    return (
      <MediaViewer
        filePath={displayPath}
        base64Content={binaryContent}
        mimeType={fileTypeInfo.mimeType || "audio/mpeg"}
        mediaType="audio"
      />
    )
  }

  if (fileTypeInfo.type === "pdf" && binaryContent) {
    return <PDFViewer filePath={displayPath} base64Content={binaryContent} />
  }

  if (fileTypeInfo.type === "binary") {
    return <BinaryFileViewer filePath={displayPath} size={fileSize} />
  }

  if (markdownLike && content !== undefined) {
    return (
      <div className="h-full min-h-0 overflow-y-auto right-panel-scroll">
        <MarkdownPreview
          content={content}
          path={displayPath}
          showHeader={false}
          whiteBackground
          className="markdown-preview"
        />
      </div>
    )
  }

  if (htmlLike && content !== undefined) {
    return <HtmlPreview content={content} path={displayPath} fillHeight={htmlFillHeight} />
  }

  // Default to code/text viewer
  if (content !== undefined) {
    return <CodeViewer filePath={displayPath} content={content} />
  }

  return null
}
