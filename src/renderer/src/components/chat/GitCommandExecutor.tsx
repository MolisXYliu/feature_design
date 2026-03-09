import { useState } from "react"
import { Terminal, Play, Edit, Check, X, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

interface GitCommand {
  original: string
  command: string
  index: number
}

interface GitCommandExecutorProps {
  commands: GitCommand[]
  onExecuteCommand?: (command: string) => Promise<void>
}

interface CommandItemProps {
  command: GitCommand
  onExecute: (command: string) => Promise<void>
}

function CommandItem({ command, onExecute }: CommandItemProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editedCommand, setEditedCommand] = useState(command.command)
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionResult, setExecutionResult] = useState<{
    success: boolean
    output?: string
  } | null>(null)

  const handleEdit = () => {
    setIsEditing(true)
    setEditedCommand(command.command)
  }

  const handleSaveEdit = () => {
    setIsEditing(false)
    // Update the command
    command.command = editedCommand
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setEditedCommand(command.command)
  }

  const handleExecute = async () => {
    setIsExecuting(true)
    setExecutionResult(null)

    try {
      await onExecute(command.command)
      setExecutionResult({ success: true })
    } catch (error) {
      setExecutionResult({
        success: false,
        output: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setIsExecuting(false)
    }
  }

  return (
    <div className="border border-border rounded-sm bg-background-elevated">
      {/* Command Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-background/50">
        <Terminal className="size-4 text-status-info" />
        <span className="text-xs font-medium">Git Command #{command.index + 1}</span>

        {executionResult && (
          <Badge
            variant={executionResult.success ? "nominal" : "critical"}
            className="ml-auto"
          >
            {executionResult.success ? "SUCCESS" : "FAILED"}
          </Badge>
        )}

        {isExecuting && (
          <Badge variant="outline" className="ml-auto animate-pulse">
            EXECUTING
          </Badge>
        )}
      </div>

      {/* Command Content */}
      <div className="p-3 space-y-3">
        {/* Command Display/Edit */}
        {isEditing ? (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">编辑命令:</div>
            <textarea
              value={editedCommand}
              onChange={(e) => setEditedCommand(e.target.value)}
              className="w-full p-2 text-xs font-mono bg-background border border-border rounded resize-none"
              rows={Math.max(1, editedCommand.split("\n").length)}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveEdit}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-status-nominal text-background rounded hover:bg-status-nominal/90 transition-colors"
              >
                <Check className="size-3" />
                保存
              </button>
              <button
                onClick={handleCancelEdit}
                className="flex items-center gap-1 px-2 py-1 text-xs border border-border rounded hover:bg-background-interactive transition-colors"
              >
                <X className="size-3" />
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">命令:</div>
            <div className="font-mono text-xs bg-background p-2 rounded border border-border overflow-auto">
              <div className="flex items-start gap-2">
                <span className="text-status-info shrink-0">$</span>
                <pre className="whitespace-pre-wrap break-all">{command.command}</pre>
              </div>
            </div>
          </div>
        )}

        {/* Execution Result */}
        {executionResult && executionResult.output && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">执行结果:</div>
            <pre
              className={cn(
                "text-xs font-mono p-2 rounded border overflow-auto max-h-32 whitespace-pre-wrap break-all",
                executionResult.success
                  ? "bg-status-nominal/10 border-status-nominal/20 text-status-nominal"
                  : "bg-status-critical/10 border-status-critical/20 text-status-critical"
              )}
            >
              {executionResult.output}
            </pre>
          </div>
        )}

        {/* Action Buttons */}
        {!isEditing && (
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleExecute}
              disabled={isExecuting}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-status-nominal text-background rounded hover:bg-status-nominal/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Play className="size-3" />
              {isExecuting ? "执行中..." : "确认执行"}
            </button>
            <button
              onClick={handleEdit}
              disabled={isExecuting}
              className="flex items-center gap-1 px-3 py-1.5 text-xs border border-border rounded hover:bg-background-interactive disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Edit className="size-3" />
              编辑命令
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function GitCommandExecutor({ commands, onExecuteCommand }: GitCommandExecutorProps) {
  if (commands.length === 0) {
    return null
  }

  const handleExecute = async (command: string) => {
    if (onExecuteCommand) {
      await onExecuteCommand(command)
    } else {
      // Default implementation - use electron IPC to execute command
      try {
        await window.electron.ipcRenderer.invoke("execute-git-command", command)
      } catch (error) {
        console.error("Failed to execute command:", error)
        throw error
      }
    }
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 p-2 bg-amber-50/90 dark:bg-amber-950/90 border border-amber-200 dark:border-amber-800 rounded">
        <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
        <div className="text-xs">
          <div className="font-medium text-amber-800 dark:text-amber-200">
            检测到 {commands.length} 个 Git 命令
          </div>
          <div className="text-amber-700 dark:text-amber-300">请仔细检查命令后再执行</div>
        </div>
      </div>

      {/* Commands */}
      <div className="space-y-2">
        {commands.map((command) => (
          <CommandItem
            key={`${command.index}-${command.original}`}
            command={command}
            onExecute={handleExecute}
          />
        ))}
      </div>
    </div>
  )
}
