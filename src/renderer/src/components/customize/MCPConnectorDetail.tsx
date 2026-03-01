import { useCallback, useEffect, useRef, useState } from "react"
import { Power, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { McpConnectorConfig } from "@/types"

export function MCPConnectorDetail(props: {
  connector: McpConnectorConfig | null
  onToggleEnabled: (id: string, enabled: boolean) => void
  onDelete: (connector: McpConnectorConfig) => void
  onEdit: (connector: McpConnectorConfig) => void
}): React.JSX.Element {
  const { connector, onToggleEnabled, onDelete, onEdit } = props
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; tools?: string[]; error?: string } | null>(null)
  const prevConnectorId = useRef<string | null>(null)

  useEffect(() => {
    if (connector?.id !== prevConnectorId.current) {
      setTestResult(null)
      setTesting(false)
      prevConnectorId.current = connector?.id ?? null
    }
  }, [connector?.id])

  const handleTest = useCallback(async () => {
    if (!connector) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.api.mcp.testConnection({ id: connector.id })
      setTestResult(res)
    } catch (e) {
      setTestResult({ success: false, error: e instanceof Error ? e.message : "测试失败" })
    } finally {
      setTesting(false)
    }
  }, [connector])

  if (!connector) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        请选择一个 MCP 连接器查看详情
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="p-4 border-b border-border flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold truncate">{connector.name}</h2>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{connector.url}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => {
              if (confirm(`确定要删除连接器「${connector.name}」吗？`)) onDelete(connector)
            }}
          >
            <Trash2 className="size-3" />
            删除
          </Button>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => onEdit(connector)}>
            编辑
          </Button>
          <Button
            variant={connector.enabled ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => onToggleEnabled(connector.id, !connector.enabled)}
          >
            <Power className="size-3" />
            {connector.enabled ? "已启用" : "已禁用"}
          </Button>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-border">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={handleTest}
          disabled={testing}
        >
          {testing ? "测试中..." : "测试连接"}
        </Button>
        {testResult && (
          <div className={cn("mt-2 text-xs", testResult.success ? "text-muted-foreground" : "text-destructive")}>
            {testResult.success ? (
              <div>
                <p>连接成功，共 {testResult.tools?.length ?? 0} 个工具：</p>
                {testResult.tools && testResult.tools.length > 0 && (
                  <ul className="mt-1 list-disc list-inside space-y-0.5">
                    {testResult.tools.slice(0, 10).map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                    {testResult.tools.length > 10 && (
                      <li className="text-muted-foreground">... 等 {testResult.tools.length - 10} 个</li>
                    )}
                  </ul>
                )}
              </div>
            ) : (
              <p>{testResult.error}</p>
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-b border-border">
        <p className="text-xs text-muted-foreground">
          MCP 连接器可访问你配置的数据与工具。请仅添加你信任的服务器。
        </p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4" />
      </ScrollArea>
    </div>
  )
}
