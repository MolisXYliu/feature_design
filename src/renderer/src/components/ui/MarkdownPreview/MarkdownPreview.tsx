import React, { useState, useCallback } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import remarkMath from "remark-math"
import rehypeHighlight from "rehype-highlight"
import rehypeRaw from "rehype-raw"
import rehypeKatex from "rehype-katex"
import { Copy, Check, FolderOpen, Eye, ChevronDown, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"

// Import highlight.js CSS for code syntax highlighting
import "highlight.js/styles/github.css"
// Import KaTeX CSS for math rendering
import "katex/dist/katex.min.css"
// Import our custom markdown styles
import "./MarkdownPreview.css"

interface MarkdownPreviewProps {
  content: string
  path?: string
  className?: string
  showHeader?: boolean
  defaultExpanded?: boolean // 新增：默认展开状态
}

export function MarkdownPreview({
  content,
  path,
  className,
  showHeader = true,
  defaultExpanded = true // 新增：默认展开
}: MarkdownPreviewProps) {
  const [copySuccess, setCopySuccess] = useState(false)
  const [isExpanded, setIsExpanded] = useState(defaultExpanded) // 新增：展开状态

  // 新增：切换展开/收起
  const toggleExpanded = useCallback(() => {
    setIsExpanded(!isExpanded)
  }, [isExpanded])

  // Copy content to clipboard
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopySuccess(true)
      setTimeout(() => setCopySuccess(false), 2000)
    } catch (err) {
      console.error("Failed to copy:", err)
    }
  }, [content])

  // Open folder containing the file - Windows兼容性
  const handleOpenFolder = useCallback(async () => {
    if (!path) {
      console.warn("No file path available to open folder")
      return
    }

    try {
      // 处理Windows和Unix路径分隔符
      const normalizedPath = path.replace(/\\/g, "/")
      const folderPath = normalizedPath.split("/").slice(0, -1).join("/") || "."

      // 检测操作系统并使用相应的IPC调用
      const platform = await window.electron.ipcRenderer.invoke("get-platform")

      if (platform === "win32") {
        // Windows: 转换为Windows路径格式
        const windowsPath = folderPath.replace(/\//g, "\\")
        await window.electron.ipcRenderer.invoke("open-folder", windowsPath)
      } else {
        // macOS/Linux: 使用Unix路径���式
        await window.electron.ipcRenderer.invoke("open-folder", folderPath)
      }
    } catch (error) {
      console.error("Failed to open folder:", error)
      // 降级��案：如果IPC调用失败，尝试使用shell
      try {
        const folderPath = path.split("/").slice(0, -1).join("/") || "."
        await window.electron.ipcRenderer.invoke("shell-show-item-in-folder", folderPath)
      } catch (fallbackError) {
        console.error("Fallback method also failed:", fallbackError)
      }
    }
  }, [path])

  // Custom components for enhanced rendering - 优化字体大小
  const components = {
    // Enhanced code blocks with syntax highlighting
    code({
      inline,
      className,
      children,
      ...props
    }: {
      inline?: boolean
      className?: string
      children?: React.ReactNode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any
    }) {
      const match = /language-(\w+)/.exec(className || "")
      const language = match ? match[1] : ""

      if (!inline) {
        return (
          <div className="relative group">
            <div className="flex items-center justify-between bg-slate-100 dark:bg-slate-800 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400 rounded-t-md border-b">
              <span className="font-mono text-xs">{language || "text"}</span>
              <button
                onClick={() => navigator.clipboard.writeText(String(children))}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded"
                title="Copy code"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            <pre className="bg-slate-50 dark:bg-slate-900 p-3 overflow-x-auto rounded-b-md border border-slate-200 dark:border-slate-700">
              <code className={className} {...props}>
                {children}
              </code>
            </pre>
          </div>
        )
      }

      return (
        <code
          className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-xs font-mono text-slate-800 dark:text-slate-200"
          {...props}
        >
          {children}
        </code>
      )
    },

    // Enhanced tables with better styling
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <div className="overflow-x-auto my-4">
          <table
            className="w-full border-collapse border border-slate-300 dark:border-slate-600 rounded-md text-sm"
            {...props}
          >
            {children}
          </table>
        </div>
      )
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    thead({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <thead className="bg-slate-50 dark:bg-slate-800" {...props}>
          {children}
        </thead>
      )
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    th({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <th
          className="border border-slate-300 dark:border-slate-600 px-3 py-2 text-left font-semibold text-slate-900 dark:text-slate-100 text-sm"
          {...props}
        >
          {children}
        </th>
      )
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    td({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <td
          className="border border-slate-300 dark:border-slate-600 px-3 py-2 text-slate-700 dark:text-slate-300 text-sm"
          {...props}
        >
          {children}
        </td>
      )
    },

    // Enhanced blockquotes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blockquote({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <blockquote
          className="border-l-3 border-blue-500 bg-blue-50 dark:bg-blue-950/30 pl-4 pr-3 py-3 my-4 italic text-slate-700 dark:text-slate-300 text-sm"
          {...props}
        >
          {children}
        </blockquote>
      )
    },

    // Enhanced headings with better spacing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h1({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <h1
          className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-6 mb-4 pb-2 border-b border-slate-200 dark:border-slate-700"
          {...props}
        >
          {children}
        </h1>
      )
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h2({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <h2
          className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-5 mb-3"
          {...props}
        >
          {children}
        </h2>
      )
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h3({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <h3
          className="text-base font-semibold text-slate-900 dark:text-slate-100 mt-4 mb-2"
          {...props}
        >
          {children}
        </h3>
      )
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h4({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <h4
          className="text-sm font-semibold text-slate-900 dark:text-slate-100 mt-3 mb-2"
          {...props}
        >
          {children}
        </h4>
      )
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h5({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <h5
          className="text-sm font-semibold text-slate-900 dark:text-slate-100 mt-3 mb-1"
          {...props}
        >
          {children}
        </h5>
      )
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h6({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <h6
          className="text-xs font-semibold text-slate-900 dark:text-slate-100 mt-3 mb-1 uppercase tracking-wide"
          {...props}
        >
          {children}
        </h6>
      )
    },

    // Enhanced paragraphs with better spacing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <p className="text-slate-700 dark:text-slate-300 leading-relaxed mb-3 text-sm" {...props}>
          {children}
        </p>
      )
    },

    // Enhanced lists
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ul({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <ul
          className="list-disc list-inside space-y-1 mb-3 text-slate-700 dark:text-slate-300 pl-3 text-sm"
          {...props}
        >
          {children}
        </ul>
      )
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ol({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <ol
          className="list-decimal list-inside space-y-1 mb-3 text-slate-700 dark:text-slate-300 pl-3 text-sm"
          {...props}
        >
          {children}
        </ol>
      )
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    li({ children, ...props }: { children?: React.ReactNode; [key: string]: any }) {
      return (
        <li className="leading-relaxed" {...props}>
          {children}
        </li>
      )
    },

    // Enhanced links
    a({
      href,
      children,
      ...props
    }: {
      href?: string
      children?: React.ReactNode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any
    }) {
      return (
        <a
          href={href}
          className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline decoration-blue-600/30 hover:decoration-blue-800/50 transition-colors"
          target="_blank"
          rel="noopener noreferrer"
          {...props}
        >
          {children}
        </a>
      )
    },

    // Enhanced horizontal rules
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hr({ ...props }: { [key: string]: any }) {
      return (
        <hr
          className="my-6 border-0 h-px bg-gradient-to-r from-transparent via-slate-300 dark:via-slate-600 to-transparent"
          {...props}
        />
      )
    },

    // Enhanced images
    img({
      src,
      alt,
      ...props
    }: {
      src?: string
      alt?: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any
    }) {
      return (
        <img
          src={src}
          alt={alt}
          className="max-w-full h-auto rounded-md shadow-sm my-3"
          {...props}
        />
      )
    }
  }

  const markdownContent = (
    <div
      className={cn(
        "prose prose-slate dark:prose-invert max-w-none",
        "prose-headings:scroll-mt-16",
        "prose-pre:bg-transparent prose-pre:p-0",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[rehypeHighlight, rehypeRaw, [rehypeKatex, { strict: false }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )

  return (
    <div
      className={cn(
        "markdown-preview",
        "w-full h-auto",
        "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100",
        className
      )}
    >
      {/* Header */}
      {showHeader && (
        <div className="flex items-center justify-between gap-2 p-3 bg-slate-50/90 dark:bg-slate-800/90 border-b border-slate-200 dark:border-slate-700 rounded-t-md">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={toggleExpanded}
              className="p-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors shrink-0"
              title={isExpanded ? "收起预览" : "展开预览"}
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
            <Eye className="h-4 w-4 text-slate-500 shrink-0" />
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Markdown文件预览
            </span>
            {path && (
              <span className="text-xs text-slate-500 truncate font-mono">
                {path.split(/[/\\]/).pop()} {/* Windows兼容性：支持反斜杠 */}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleCopy}
              className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors"
              title="复制Markdown内容"
            >
              {copySuccess ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
            {path && (
              <button
                onClick={handleOpenFolder}
                className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors"
                title="打开文件夹"
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Content - 添加展开/收起动画 */}
      <div
        className={cn(
          "transition-all duration-300 ease-in-out overflow-hidden",
          isExpanded ? "opacity-100" : "opacity-0 h-0"
        )}
      >
        {isExpanded && (
          <div className="p-4">{markdownContent}</div>
        )}
      </div>

      {/* 收起状态下的预览行 */}
      {!isExpanded && (
        <div className="px-4 py-2 text-sm text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/50">
          <div className="truncate">
            {content.split('\n')[0] || "Markdown 内容已收起..."}
          </div>
        </div>
      )}
    </div>
  )
}

export default MarkdownPreview
