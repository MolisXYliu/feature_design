import {
  FileText,
  FolderOpen,
  Search,
  Edit,
  Terminal,
  ListTodo,
  GitBranch,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  Clock,
  XCircle,
  File,
  Folder,
  Maximize2,
  X
} from "lucide-react"
import { memo, useState } from "react";
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { ToolCall, Todo } from "@/types"
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued"
import { GitFileOperationPrompt } from "./GitPush/GitFileOperationPrompt"
import MarkdownPreview from "../ui/MarkdownPreview/MarkdownPreview";
import { GitFileOperationPromptWithProps } from "@/components/chat/GitPush/GitFileOperationPromptWithProps"

interface ToolCallRendererProps {
  toolCall: ToolCall
  result?: string | unknown
  isError?: boolean
  needsApproval?: boolean
  showApprovalButtons?: boolean
  onApprovalDecision?: (decision: "approve" | "reject" | "edit") => void
  threadId: string // Add threadId prop
}

const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  read_file: FileText,
  write_file: Edit,
  edit_file: Edit,
  ls: FolderOpen,
  glob: FolderOpen,
  grep: Search,
  execute: Terminal,
  write_todos: ListTodo,
  task: GitBranch,
  git_push: GitBranch,
  git_workflow: GitBranch
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read File",
  write_file: "Write File",
  edit_file: "Edit File",
  ls: "List Directory",
  glob: "Find Files",
  grep: "Search Content",
  execute: "Execute Command",
  write_todos: "Update Tasks",
  task: "Subagent Task",
  git_workflow: "Git Workflow (Add, Commit, Push)"
}

// Tools whose results are shown in the UI panels and don't need verbose display
const PANEL_SYNCED_TOOLS = new Set(["write_todos"])

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()

  try {
    const serialized = JSON.stringify(
      value,
      (_key, currentValue: unknown) => {
        if (typeof currentValue === "bigint") {
          return `${currentValue.toString()}n`
        }
        if (currentValue instanceof Error) {
          return {
            name: currentValue.name,
            message: currentValue.message,
            stack: currentValue.stack
          }
        }
        if (typeof currentValue === "function") {
          return `[Function ${currentValue.name || "anonymous"}]`
        }
        if (typeof currentValue === "symbol") {
          return currentValue.toString()
        }
        if (currentValue && typeof currentValue === "object") {
          if (seen.has(currentValue)) {
            return "[Circular]"
          }
          seen.add(currentValue)
        }
        return currentValue
      },
      2
    )

    return typeof serialized === "string" ? serialized : String(serialized)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `[Unserializable value: ${message}]`
  }
}

// Helper to get a clean file name from path
function getFileName(path: string): string {
  return path.split("/").pop() || path
}

// Render todos nicely
function TodosDisplay({ todos }: { todos: Todo[] }): React.JSX.Element {
  const statusConfig: Record<string, { icon: typeof Circle; color: string }> = {
    pending: { icon: Circle, color: "text-muted-foreground" },
    in_progress: { icon: Clock, color: "text-status-info" },
    completed: { icon: CheckCircle2, color: "text-status-nominal" },
    cancelled: { icon: XCircle, color: "text-muted-foreground" }
  }

  const defaultConfig = { icon: Circle, color: "text-muted-foreground" }

  return (
    <div className="space-y-1">
      {todos.map((todo, i) => {
        const config = statusConfig[todo.status] || defaultConfig
        const Icon = config.icon
        const isDone = todo.status === "completed" || todo.status === "cancelled"
        return (
          <div
            key={todo.id || i}
            className={cn("flex items-start gap-2 text-xs", isDone && "opacity-50")}
          >
            <Icon className={cn("size-3.5 mt-0.5 shrink-0", config.color)} />
            <span className={cn(isDone && "line-through")}>{todo.content}</span>
          </div>
        )
      })}
    </div>
  )
}

// Render file list nicely
function FileListDisplay({
  files,
  isGlob
}: {
  files: string[] | Array<{ path: string; is_dir?: boolean }>
  isGlob?: boolean
}): React.JSX.Element {
  const items = files.slice(0, 15) // Limit display
  const hasMore = files.length > 15

  return (
    <div className="space-y-0.5">
      {items.map((file, i) => {
        const path = typeof file === "string" ? file : file.path
        const isDir = typeof file === "object" && file.is_dir
        return (
          <div key={i} className="flex items-center gap-2 text-xs font-mono">
            {isDir ? (
              <Folder className="size-3 text-status-warning shrink-0" />
            ) : (
              <File className="size-3 text-muted-foreground shrink-0" />
            )}
            <span className="truncate">{isGlob ? path : getFileName(path)}</span>
          </div>
        )
      })}
      {hasMore && (
        <div className="text-xs text-muted-foreground mt-1">... and {files.length - 15} more</div>
      )}
    </div>
  )
}

// Render grep results nicely
function GrepResultsDisplay({
  matches
}: {
  matches: Array<{ path: string; line?: number; text?: string }>
}): React.JSX.Element {
  const grouped = matches.reduce(
    (acc, match) => {
      if (!acc[match.path]) acc[match.path] = []
      acc[match.path].push(match)
      return acc
    },
    {} as Record<string, typeof matches>
  )

  const files = Object.keys(grouped).slice(0, 5)
  const hasMore = Object.keys(grouped).length > 5

  return (
    <div className="space-y-2">
      {files.map((path) => (
        <div key={path} className="text-xs">
          <div className="flex items-center gap-1.5 font-medium text-status-info mb-1">
            <FileText className="size-3" />
            {getFileName(path)}
          </div>
          <div className="space-y-0.5 pl-4 border-l border-border/50">
            {grouped[path].slice(0, 3).map((match, i) => (
              <div key={i} className="font-mono text-muted-foreground truncate">
                {match.line && <span className="text-status-warning mr-2">{match.line}:</span>}
                {match.text?.trim()}
              </div>
            ))}
            {grouped[path].length > 3 && (
              <div className="text-muted-foreground">+{grouped[path].length - 3} more matches</div>
            )}
          </div>
        </div>
      ))}
      {hasMore && (
        <div className="text-xs text-muted-foreground">
          ... matches in {Object.keys(grouped).length - 5} more files
        </div>
      )}
    </div>
  )
}

// Render file content preview
function FileContentPreview({ content }: { content: string; path?: string }): React.JSX.Element {
  const lines = content.split("\n")
  const preview = lines.slice(0, 10)
  const hasMore = lines.length > 10

  return (
    <div className="text-xs font-mono bg-background rounded-sm overflow-hidden w-full">
      <pre className="p-2 overflow-auto max-h-40 w-full">
        {preview.map((line, i) => (
          <div key={i} className="flex min-w-0">
            <span className="w-8 shrink-0 text-muted-foreground select-none pr-2 text-right">
              {i + 1}
            </span>
            <span className="flex-1 min-w-0 truncate">{line || " "}</span>
          </div>
        ))}
      </pre>
      {hasMore && (
        <div className="px-2 py-1 text-muted-foreground bg-background-elevated border-t border-border">
          ... {lines.length - 10} more lines
        </div>
      )}
    </div>
  )
}

// Render edit/write file summary
function FileEditSummary({ args }: { args: Record<string, unknown> }): React.JSX.Element | null {
  const path = (args.path || args.file_path) as string
  const content = args.content as string | undefined
  const oldStr = args.old_str as string | undefined
  const newStr = args.new_str as string | undefined

  if (oldStr !== undefined && newStr !== undefined) {
    // Edit operation
    return (
      <div className="text-xs space-y-2">
        <div className="flex items-center gap-1.5 text-status-critical">
          <span className="font-mono bg-status-critical/10 px-1.5 py-0.5 rounded">
            - {oldStr.split("\n").length} lines
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-status-nominal">
          <span className="font-mono bg-nominal/10 px-1.5 py-0.5 rounded">
            + {newStr.split("\n").length} lines
          </span>
        </div>
      </div>
    )
  }

  if (content) {
    const lines = content.split("\n").length
    return (
      <div className="text-xs text-muted-foreground">
        Writing {lines} lines to {getFileName(path)}
      </div>
    )
  }

  return null
}

// Command display
function CommandDisplay({
  command,
  output
}: {
  command: string
  output?: string
}): React.JSX.Element {
  return (
    <div className="text-xs space-y-2 w-full overflow-hidden">
      <div className="font-mono bg-background rounded-sm p-2 flex items-center gap-2 min-w-0">
        <span className="text-status-info shrink-0">$</span>
        <span className="truncate">{command}</span>
      </div>
      {output && (
        <pre className="font-mono bg-background rounded-sm p-2 overflow-auto max-h-32 text-muted-foreground w-full whitespace-pre-wrap break-all">
          {output.slice(0, 500)}
          {output.length > 500 && "..."}
        </pre>
      )}
    </div>
  )
}

// Subagent task display
function TaskDisplay({
  args,
  isExpanded
}: {
  args: Record<string, unknown>
  isExpanded?: boolean
}): React.JSX.Element {
  const name = args.name as string | undefined
  const description = args.description as string | undefined

  return (
    <div className="text-xs space-y-1">
      {name && (
        <div className="flex items-center gap-2">
          <GitBranch className="size-3 text-status-info" />
          <span className="font-medium truncate">{name}</span>
        </div>
      )}
      {description && (
        <p className={cn("text-muted-foreground pl-5", !isExpanded && "line-clamp-2")}>
          {description}
        </p>
      )}
    </div>
  )
}

// Render git diff nicely
export const DiffDisplay = memo( ({ diff, oldValue, newValue}:any) =>  {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [renderMode, setRenderMode] = useState<"preview" | "full">("preview")

  // Use provided diff or fallback to mock data
  const diffToUse = diff || ""

  // Parse git diff to extract old and new content
  const parseGitDiff = (diffText: string) => {
    const lines = diffText.split("\n")
    let oldContent = ""
    let newContent = ""
    let inHunk = false
    let totalLines = 0

    for (const line of lines) {
      if (line.startsWith("@@")) {
        inHunk = true
        continue
      }

      if (inHunk) {
        totalLines++
        if (line.startsWith("-")) {
          oldContent += line.substring(1) + "\n"
        } else if (line.startsWith("+")) {
          newContent += line.substring(1) + "\n"
        } else if (line.startsWith(" ")) {
          oldContent += line.substring(1) + "\n"
          newContent += line.substring(1) + "\n"
        }
      }
    }

    return {
      oldContent: oldContent.trim(),
      newContent: newContent.trim(),
      totalLines
    }
  }

  const { oldContent, newContent, totalLines } = parseGitDiff(diffToUse)

  // Performance optimization: only show preview for large diffs
  const isLargeDiff = totalLines > 100
  const maxPreviewLines = 20

  // Get preview content (first N lines)
  const getPreviewContent = (content: string, maxLines: number) => {
    const lines = content.split("\n")
    if (lines.length <= maxLines) return content
    return (
      lines.slice(0, maxLines).join("\n") +
      "\n...(显示前 " +
      maxLines +
      " 行，共 " +
      lines.length +
      " 行)"
    )
  }

  // Use preview content if not expanded and diff is large
  const shouldUsePreview = isLargeDiff && renderMode === "preview"
  const displayOldContent = shouldUsePreview
    ? getPreviewContent(oldContent, maxPreviewLines)
    : oldContent
  const displayNewContent = shouldUsePreview
    ? getPreviewContent(newContent, maxPreviewLines)
    : newContent

  const DiffViewer = (
    <ReactDiffViewer
      oldValue={oldValue || displayOldContent}
      newValue={newValue || displayNewContent}
      splitView={isFullscreen}
      hideLineNumbers={false}
      useDarkTheme={false}
      loadingElement={()=><div className={'text-center font-bold text-lg py-2'}>loading...</div>}
      disableWordDiff={shouldUsePreview} // Disable word diff for better performance with large content
      compareMethod={shouldUsePreview ? DiffMethod.LINES : DiffMethod.WORDS}
      styles={{
        diffContainer: {
          maxHeight: isFullscreen ? "100%" : "24rem",
          minHeight: isFullscreen ? "100%" : "100px",
          overflow: "auto",
          height: isFullscreen ? "100%" : "100px"
        },
        line: {
          lineHeight: "1.6",
          fontSize:'1rem'
        },
        contentText:{
          fontFamily:'Consolas'
        }
      }}
    />
  )

  return (
    <>
      {/* Header with controls */}
      <div className=" flex items-center justify-between gap-1 p-1.5 bg-background/90 border-b border-l border-border rounded-bl-sm">
        <div>变更查看 （默认显示前20行）</div>
       <div className={'flex space-x-2 '}>
         {isLargeDiff && (
           <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground mr-1">
                {totalLines} 行
              </span>
             <button
               onClick={() => setRenderMode(renderMode === "preview" ? "full" : "preview")}
               className="text-[10px] cursor-pointer px-2 py-1 bg-background hover:bg-muted border border-border rounded transition-colors"
               title={renderMode === "preview" ? "显示完整内容" : "显示预览"}
             >
               {renderMode === "preview" ?  "显示全部代码" : "显示少量代码"}
             </button>
           </div>
         )}
         <button
           onClick={() => setIsFullscreen(true)}
           className="text-[14px] cursor-pointer p-1.5 bg-background/80 hover:bg-muted border border-border rounded transition-colors"
           title="全屏查看diff"
         >
           <Maximize2 className="size-3" />
         </button>
       </div>
      </div>

      {/* Performance warning for large diffs */}
      {isLargeDiff && renderMode === "full" && (
        <div className=" p-2 bg-amber-50/90 dark:bg-amber-950/90 border-t border-amber-200 dark:border-amber-800">
          <div className="flex items-center gap-2 text-[10px] text-amber-700 dark:text-amber-300">
            <div className="size-2 bg-amber-500 rounded-full animate-pulse" />
            大文件可能影响性能，建议在全屏模式下查看
          </div>
        </div>
      )}

      <div className="relative text-xs font-mono bg-background rounded-sm overflow-scroll w-full max-h-96 min-h-40">



        {DiffViewer}
      </div>

      {/* Fullscreen Modal */}
      {isFullscreen && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm mt-10">
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-4">
                <h3 className="text-sm font-medium">Git Diff - 全屏视图</h3>
                <span className="text-xs text-muted-foreground">
                  {totalLines} 行更改
                </span>
              </div>
              <div className="flex items-center gap-2">
                {isLargeDiff && <button
                  onClick={() => setRenderMode(renderMode === "preview" ? "full" : "preview")}
                  className="cursor-pointer px-3 py-1.5 text-xs bg-background hover:bg-muted border border-border rounded transition-colors"
                >
                  {renderMode === "preview" ? "显示全部代码" : "显示少量代码"}
                </button>}
                <button
                  onClick={() => {
                    setIsFullscreen(false);
                    setRenderMode("preview");
                  }}
                  className="cursor-pointer p-1.5 hover:bg-muted border border-border rounded transition-colors"
                  title="退出全屏"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Full content */}
            <div className="flex-1 p-4 overflow-hidden">
              <div className="h-full text-sm font-mono bg-background rounded border border-border overflow-scroll">
                {DiffViewer}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
})

export function ToolCallRenderer({
  toolCall,
  result,
  isError,
  needsApproval,
  showApprovalButtons = true,
  onApprovalDecision,
  threadId
}: ToolCallRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [skippedGitPrompts, setSkippedGitPrompts] = useState<Set<string>>(new Set())

  // Defensive: ensure args is always an object
  const args = toolCall?.args || {}

  // Bail out if no toolCall
  if (!toolCall) {
    return null
  }

  const Icon = TOOL_ICONS[toolCall.name] || Terminal
  const label = TOOL_LABELS[toolCall.name] || toolCall.name
  const isPanelSynced = PANEL_SYNCED_TOOLS.has(toolCall.name)

  const handleApprove = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onApprovalDecision?.("approve")
  }

  const handleReject = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onApprovalDecision?.("reject")
  }

  // Format the main argument for display
  const getDisplayArg = (): string | null => {
    if (!args) return null
    if (args.path) return args.path as string
    if (args.file_path) return args.file_path as string
    if (args.command) return (args.command as string).slice(0, 50)
    if (args.pattern) return args.pattern as string
    if (args.query) return args.query as string
    if (args.glob) return args.glob as string
    if (args.branch) return args.branch as string
    if (args.remoteUrl) return args.remoteUrl as string
    if (args.commitMessage) return (args.commitMessage as string).slice(0, 50)
    return null
  }

  const displayArg = getDisplayArg()

  // Render formatted content based on tool type
  const renderFormattedContent = (): React.ReactNode => {
    if (!args) return null

    switch (toolCall.name) {
      case "write_todos": {
        const todos = args.todos as Todo[] | undefined
        if (todos && todos.length > 0) {
          return <TodosDisplay todos={todos} />
        }
        return null
      }

      case "task": {
        return <TaskDisplay args={args} isExpanded={isExpanded} />
      }

      case "edit_file":
      case "write_file": {
        return <FileEditSummary args={args} />
      }

      case "execute": {
        const command = args.command as string
        const output = typeof result === "string" ? result : undefined
        return <CommandDisplay command={command} output={isExpanded ? output : undefined} />
      }

      default:
        return null
    }
  }

  // Render result based on tool type
  const renderFormattedResult = (): React.ReactNode => {
    if (result === undefined) return null

    // Handle errors
    if (isError) {
      return (
        <div className="text-xs text-status-critical flex items-start gap-1.5">
          <XCircle className="size-3 mt-0.5 shrink-0" />
          <span className="break-words">
            {typeof result === "string" ? result : safeStringify(result)}
          </span>
        </div>
      )
    }

    switch (toolCall.name) {
      case "read_file": {
        const content = typeof result === "string" ? result : safeStringify(result)
        const lines = content.split("\n").length
        return (
          <div className="space-y-2">
            <div className="text-xs text-status-nominal flex items-center gap-1.5">
              <CheckCircle2 className="size-3" />
              <span>Read {lines} lines</span>
            </div>
            <FileContentPreview content={content} />
          </div>
        )
      }

      case "ls": {
        if (Array.isArray(result)) {
          const dirs = result.filter(
            (f: { is_dir?: boolean } | string) => typeof f === "object" && f.is_dir
          ).length
          const files = result.length - dirs
          return (
            <div className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>
                  {files} file{files !== 1 ? "s" : ""}
                  {dirs > 0 ? `, ${dirs} folder${dirs !== 1 ? "s" : ""}` : ""}
                </span>
              </div>
              <FileListDisplay files={result} />
            </div>
          )
        }
        return null
      }

      case "glob": {
        if (Array.isArray(result)) {
          return (
            <div className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>
                  Found {result.length} match{result.length !== 1 ? "es" : ""}
                </span>
              </div>
              <FileListDisplay files={result} isGlob />
            </div>
          )
        }
        return null
      }

      case "grep": {
        if (Array.isArray(result)) {
          const fileCount = new Set(result.map((m: { path: string }) => m.path)).size
          return (
            <div className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>
                  {result.length} match{result.length !== 1 ? "es" : ""} in {fileCount} file
                  {fileCount !== 1 ? "s" : ""}
                </span>
              </div>
              <GrepResultsDisplay matches={result} />
            </div>
          )
        }
        return null
      }

      case "execute": {
        // When expanded, output is shown in CommandDisplay - just show status
        // When collapsed, show the output preview
        const output = typeof result === "string" ? result : safeStringify(result)
        const command = args.command as string

        // Special handling for git diff commands
        // todo 暂时注释，看后续是否要放开
        // if (command && command.includes("git diff") && output.trim() && !output.includes('no output') ) {
        //   if (isExpanded) {
        //     return (
        //       <div className="text-xs text-status-nominal flex items-center gap-1.5">
        //         <CheckCircle2 className="size-3" />
        //         <span>Git diff completed</span>
        //       </div>
        //     )
        //   }
        //   // Collapsed view - show diff preview
        //   return (
        //     <div className="space-y-2">
        //       <div className="text-xs text-status-nominal flex items-center gap-1.5">
        //         <CheckCircle2 className="size-3" />
        //         <span>Git diff completed</span>
        //       </div>
        //       <DiffDisplay diff={output} />
        //     </div>
        //   )
        // }

        if (isExpanded) {
          return (
            <div className="text-xs text-status-nominal flex items-center gap-1.5">
              <CheckCircle2 className="size-3" />
              <span>Command completed</span>
            </div>
          )
        }
        // Collapsed view - show output preview
        if (output.trim()) {
          return (
            <pre className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>Command completed</span>
              </div>
              <pre className="text-xs font-mono bg-background rounded-sm p-2 overflow-auto max-h-32 text-muted-foreground whitespace-pre-wrap break-all">
                {output.slice(0, 500)}
                {output.length > 500 && "..."}
              </pre>
            </pre>
          )
        }
        return (
          <div className="text-xs text-status-nominal flex items-center gap-1.5">
            <CheckCircle2 className="size-3" />
            <span>Command completed (no output)</span>
          </div>
        )
      }

      case "write_todos":
        // Already shown in Tasks panel
        return null

      case "write_file":
      case "edit_file": {
        // Check if this is a markdown file being written or edited
        const path = (args.path || args.file_path) as string
        const content = args.content as string | undefined
        const newStr = args.new_str as string | undefined
        const isMarkdownFile = path && (path.endsWith(".md") || path.endsWith(".markdown"))

        // For edit_file, we want to show the new content (new_str)
        // For write_file, we want to show the content
        const markdownContent = toolCall.name === "edit_file" ? newStr : content

        if (isMarkdownFile && markdownContent && !isExpanded) {
          // Show markdown preview for collapsed view
          return (
            <div className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>
                  {toolCall.name === "edit_file" ? "Markdown file edited" : "Markdown file created"}
                </span>
              </div>
              <MarkdownPreview content={markdownContent} path={path} />
            </div>
          )
        }

        // Check if this operation might need Git commit (any file operation)
        // 编辑文件导致的git提交
        // todo 暂时放开，等后续批量git完善之后，再根据实际情况调整哪些操作需要展示git提交
        if (!isExpanded && path && !skippedGitPrompts.has(toolCall.id)) {
          return (
            <div className="space-y-2">
              <div className={'overflow-scroll'}>
                <DiffDisplay
                  oldValue={args.old_string || ""}
                  newValue={args.new_string  || ""}
                />
              </div>
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>File {toolCall.name === "edit_file" ? "edited" : "created"}: {getFileName(path)}</span>
              </div>
              <GitFileOperationPrompt
                filePath={path}
                operation={toolCall.name}
                operationId={toolCall.id}
                threadId={threadId}
                onSkip={() => setSkippedGitPrompts(prev => new Set(prev).add(toolCall.id))}
              />
            </div>
          )
        }

        // Show confirmation message for file operations
        if (typeof result === "string" && result.trim()) {
          return (
            <div className="text-xs text-status-nominal flex items-center gap-1.5">
              <CheckCircle2 className="size-3" />
              <span>{result}</span>
            </div>
          )
        }
        return (
          <div className="text-xs text-status-nominal flex items-center gap-1.5">
            <CheckCircle2 className="size-3" />
            <span>File saved</span>
          </div>
        )
      }

      case "task": {
        // Subagent task completion
        if (typeof result === "string" && result.trim()) {
          return (
            <div className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>Task completed</span>
              </div>
              <div className="text-xs text-muted-foreground pl-5 line-clamp-3">
                {result.slice(0, 500)}
                {result.length > 500 && "..."}
              </div>
            </div>
          )
        }
        return (
          <div className="text-xs text-status-nominal flex items-center gap-1.5">
            <CheckCircle2 className="size-3" />
            <span>Task completed</span>
          </div>
        )
      }

      case "git_workflow": {
        // Git workflow operation with GitFileOperationPrompt for display
        if (!result || typeof result !== 'string') {
          return (
            <div className="text-xs text-status-critical flex items-center gap-1.5">
              <XCircle className="size-3" />
              <span>Git workflow error: Invalid result</span>
            </div>
          )
        }

        let gitResult: any
        try {
          gitResult = JSON.parse(result as string)
        } catch (error) {
          console.error('Failed to parse git result:', error)
          return (
            <div className="text-xs text-status-critical flex items-center gap-1.5">
              <XCircle className="size-3" />
              <span>Git workflow error: Invalid JSON result</span>
            </div>
          )
        }

        const branch = gitResult.branch as string || ""
        const remoteUrl = gitResult.remoteUrl as string || ""
        const commitMessage = gitResult.commitMessage as string || ""
        const changedFiles = gitResult.changedFiles || []
        const workspacePath = gitResult.workspacePath || ""

        const error = gitResult.error || ""
        const message = gitResult.message || ""

        if (error && message?.includes('Not a git repository')){
          return <div className="text-sm text-status-critical space-y-3 my-4">
            <div>当前工作台地址为：{workspacePath}</div>
            <div>你需要：选择要git提交的仓库文件夹作为工作台地址</div>
          </div>
        }

        // console.log('Git workflow - changedFiles:', changedFiles.length, 'files')

        return (
          <div className="space-y-2">
            <GitFileOperationPromptWithProps
              workspacePath={workspacePath}
              remoteUrl={remoteUrl}
              branch={branch}
              commitmessage={commitMessage}
              changedFiles={changedFiles}
              operation="git_workflow"
              operationId={toolCall.id}
              onSkip={() => setSkippedGitPrompts(prev => new Set(prev).add(toolCall.id))}
            />
          </div>
        )
      }

      default: {
        // Generic success for unknown tools
        if (typeof result === "string" && result.trim()) {
          return (
            <div className="text-xs text-status-nominal flex items-center gap-1.5">
              <CheckCircle2 className="size-3" />
              <span className="truncate">
                {result.slice(0, 100)}
                {result.length > 100 ? "..." : ""}
              </span>
            </div>
          )
        }
        return (
          <div className="text-xs text-status-nominal flex items-center gap-1.5">
            <CheckCircle2 className="size-3" />
            <span>Completed</span>
          </div>
        )
      }
    }
  }

  const formattedContent = renderFormattedContent()
  const formattedResult = renderFormattedResult()
  const hasFormattedDisplay = formattedContent || formattedResult

  return (
    <div
      className={cn(
        "rounded-sm border overflow-hidden",
        needsApproval
          ? "border-amber-500/50 bg-amber-500/5"
          : "border-border bg-background-elevated"
      )}
    >
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 hover:bg-background-interactive transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground shrink-0" />
        )}

        <Icon
          className={cn("size-4 shrink-0", needsApproval ? "text-amber-500" : "text-status-info")}
        />

        <span className="text-xs font-medium shrink-0">{label}</span>

        {displayArg && (
          <span className="flex-1 truncate text-left text-xs text-muted-foreground font-mono">
            {displayArg}
          </span>
        )}

        {needsApproval && (
          <Badge variant="warning" className="ml-auto shrink-0">
            待审批
          </Badge>
        )}

        {!needsApproval && result === undefined && (
          <Badge variant="outline" className="ml-auto shrink-0 animate-pulse">
            RUNNING
          </Badge>
        )}

        {result !== undefined && !needsApproval && (
          <Badge variant={isError ? "critical" : "nominal"} className="ml-auto shrink-0">
            {isError ? "ERROR" : "OK"}
          </Badge>
        )}

        {isPanelSynced && !needsApproval && (
          <Badge variant="outline" className="shrink-0 text-[9px]">
            SYNCED
          </Badge>
        )}
      </button>

      {/* Approval UI */}
      {needsApproval ? (
        <div className="border-t border-amber-500/20 px-3 py-3 space-y-3">
          {/* Show formatted content (e.g., command preview) */}
          {formattedContent}

          {/* Arguments */}
          <div>
            <div className="text-section-header text-[10px] mb-1">参数</div>
            <pre className="text-xs font-mono bg-background p-2 rounded-sm overflow-auto max-h-24">
              {safeStringify(args)}
            </pre>
          </div>

          {/* Action buttons - hidden when batch approval bar is used */}
          {showApprovalButtons && (
            <div className="flex items-center justify-end gap-2">
              <button
                className="px-3 py-1.5 text-xs border border-border rounded-sm hover:bg-background-interactive transition-colors"
                onClick={handleReject}
              >
                拒绝
              </button>
              <button
                className="px-3 py-1.5 text-xs bg-status-nominal text-background rounded-sm hover:bg-status-nominal/90 transition-colors"
                onClick={handleApprove}
              >
                批准并执行
              </button>
            </div>
          )}
        </div>
      ) : null}

      {/* Formatted content (only visible when collapsed AND has result) */}
      {hasFormattedDisplay && !isExpanded && !needsApproval && result !== undefined && (
        <div className="border-t border-border px-3 py-2 space-y-2 overflow-hidden">
          {formattedContent}
          {formattedResult}
        </div>
      )}

      {/* Expanded content - raw details */}
      {isExpanded && !needsApproval && (
        <div className="border-t border-border px-3 py-2 space-y-2 overflow-hidden">
          {/* Formatted display first */}
          {formattedContent}
          {formattedResult}

          {/* Raw Arguments */}
          <div className="overflow-hidden w-full">
            <div className="text-section-header mb-1">RAW ARGUMENTS</div>
            <pre className="text-xs font-mono bg-background p-2 rounded-sm overflow-auto max-h-48 w-full whitespace-pre-wrap break-all">
              {safeStringify(args)}
            </pre>
          </div>

          {/* Raw Result */}
          {result !== undefined && (
            <div className="overflow-hidden w-full">
              <div className="text-section-header mb-1">RAW RESULT</div>
              <pre
                className={cn(
                  "text-xs font-mono p-2 rounded-sm overflow-auto max-h-48 w-full whitespace-pre-wrap break-all",
                  isError ? "bg-status-critical/10 text-status-critical" : "bg-background"
                )}
              >
                {typeof result === "string" ? result : safeStringify(result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
