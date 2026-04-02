import { useCallback, useEffect, useMemo, useState } from "react"
import {
  FileCode2,
  Loader2,
  Play,
  Save,
  Trash2,
  Wrench
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { ManagedSavedCodeExecTool, SavedCodeExecPreviewResult } from "@/types"

interface EditorState {
  toolName: string
  description: string
  code: string
  paramsText: string
}

interface SuccessfulPreviewState {
  code: string
  params: Record<string, unknown>
  paramsText: string
  output: string
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

function createEditorState(tool: ManagedSavedCodeExecTool): EditorState {
  return {
    toolName: tool.toolName,
    description: tool.description,
    code: tool.code,
    paramsText: "{\n  \n}"
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function formatStructuredValue(value: unknown): string {
  if (value == null) return "暂无"
  if (typeof value === "string") return value

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseParamsText(
  paramsText: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = paramsText.trim()
  if (!trimmed) {
    return { ok: true, value: {} }
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "params 必须是 JSON 对象" }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "params JSON 解析失败"
    }
  }
}

function isToolDirty(tool: ManagedSavedCodeExecTool, editor: EditorState | null): boolean {
  if (!editor) return false
  return (
    tool.toolName !== editor.toolName ||
    tool.description !== editor.description ||
    tool.code !== editor.code
  )
}

function getToolNameError(toolName: string): string | null {
  const normalized = toolName.replace(/^saved__?/i, "").trim()
  if (!normalized) {
    return "tool_name 不能为空"
  }

  if (!TOOL_NAME_PATTERN.test(normalized)) {
    return "tool_name 仅支持英文、数字、下划线(_)和短横线(-)，不能包含中文、空格或其他符号"
  }

  return null
}

export function CodeExecToolsPanel(): React.JSX.Element {
  const [tools, setTools] = useState<ManagedSavedCodeExecTool[]>([])
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [runResult, setRunResult] = useState<SavedCodeExecPreviewResult | null>(null)
  const [lastSuccessfulPreview, setLastSuccessfulPreview] = useState<SuccessfulPreviewState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const loadTools = useCallback(async (preferredToolId?: string) => {
    setLoading(true)
    setLoadError(null)

    try {
      const nextTools = await window.api.codeExecTools.list()
      setTools(nextTools)
      setSelectedToolId((current) => {
        const candidate = preferredToolId ?? current
        if (candidate && nextTools.some((tool) => tool.toolId === candidate)) {
          return candidate
        }
        return nextTools[0]?.toolId ?? null
      })
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "加载工具列表失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTools()
  }, [loadTools])

  const selectedTool = useMemo(
    () => tools.find((tool) => tool.toolId === selectedToolId) ?? null,
    [selectedToolId, tools]
  )

  useEffect(() => {
    if (!selectedTool) {
      setEditor(null)
      setRunResult(null)
      setLastSuccessfulPreview(null)
      return
    }

    setEditor(createEditorState(selectedTool))
    setRunResult(null)
    setLastSuccessfulPreview(null)
  }, [selectedTool])

  useEffect(() => {
    setActionError(null)
  }, [selectedToolId])

  const dirty = selectedTool ? isToolDirty(selectedTool, editor) : false

  const handleRunPreview = useCallback(async () => {
    if (!selectedTool || !editor) return

    const parsedParams = parseParamsText(editor.paramsText)
    if (!parsedParams.ok) {
      setActionError(parsedParams.error)
      setActionMessage(null)
      return
    }

    setRunning(true)
    setActionError(null)
    setActionMessage(null)

    try {
      const result = await window.api.codeExecTools.runPreview({
        code: editor.code,
        params: parsedParams.value,
        timeoutMs: selectedTool.timeoutMs
      })

      setRunResult(result)
      if (result.ok) {
        setLastSuccessfulPreview({
          code: editor.code,
          params: parsedParams.value,
          paramsText: editor.paramsText,
          output: result.output
        })
      } else {
        setLastSuccessfulPreview(null)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "试运行失败")
      setActionMessage(null)
    } finally {
      setRunning(false)
    }
  }, [editor, selectedTool])

  const handleSave = useCallback(async () => {
    if (!selectedTool || !editor) return
    const nextToolNameError = getToolNameError(editor.toolName)
    if (nextToolNameError) {
      setActionError(nextToolNameError)
      setActionMessage(null)
      return
    }

    setSaving(true)
    setActionError(null)
    setActionMessage(null)

    try {
      const matchedPreview =
        lastSuccessfulPreview &&
        lastSuccessfulPreview.code === editor.code &&
        lastSuccessfulPreview.paramsText === editor.paramsText
          ? lastSuccessfulPreview
          : null

      const updated = await window.api.codeExecTools.update({
        id: selectedTool.toolId,
        toolName: editor.toolName,
        description: editor.description,
        code: editor.code,
        timeoutMs: selectedTool.timeoutMs,
        ...(matchedPreview
          ? {
              previewParams: matchedPreview.params,
              previewOutput: matchedPreview.output
            }
          : {})
      })

      await loadTools(updated.toolId)
      setActionMessage("工具已保存")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }, [editor, lastSuccessfulPreview, loadTools, selectedTool])

  const handleDelete = useCallback(async () => {
    if (!selectedTool) return
    const confirmed = window.confirm(`确认删除工具 ${selectedTool.toolName} 吗？`)
    if (!confirmed) return

    setDeleting(true)
    setActionError(null)
    setActionMessage(null)

    try {
      await window.api.codeExecTools.delete(selectedTool.toolId)
      await loadTools()
      setActionMessage("工具已删除")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "删除失败")
    } finally {
      setDeleting(false)
    }
  }, [loadTools, selectedTool])

  return (
    <>
      <div className="w-[340px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-bold truncate">自定义工具管理</h2>
              <p className="text-xs text-muted-foreground mt-1">
                管理保存在 <span className="font-mono">code-exec-tools.json</span> 里的工具。这些工具可以像内置工具一样调用
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">共 {tools.length} 个工具</p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2 space-y-2">
            {loadError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {loadError}
              </div>
            ) : tools.length === 0 ? (
              <p className="text-xs text-muted-foreground px-2 py-3">
                暂无自主生成工具
              </p>
            ) : (
              tools.map((tool) => (
                <button
                  key={tool.toolId}
                  className={cn(
                    "w-full rounded-md border border-border/70 px-3 py-2 text-left transition-colors",
                    selectedTool?.toolId === tool.toolId ? "bg-muted/70" : "hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedToolId(tool.toolId)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{tool.toolName}</span>
                    <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                      saved
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {tool.toolId}
                  </div>
                  <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                    {tool.description || "暂无描述"}
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex-1 overflow-auto">
        {selectedTool && editor ? (
          <div className="p-6 space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <Wrench className="size-4 text-emerald-500 shrink-0" />
                  <h3 className="truncate text-base font-bold">{selectedTool.toolName}</h3>
                </div>
                <p className="font-mono text-xs text-muted-foreground break-all">
                  {selectedTool.toolId}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRunPreview}
                  disabled={running || saving || deleting}
                >
                  {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  试运行
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!dirty || saving || running || deleting}
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  保存修改
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting || saving || running}
                >
                  {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  删除
                </Button>
              </div>
            </div>

            {actionError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {actionError}
              </div>
            )}
            {actionMessage && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
                {actionMessage}
              </div>
            )}

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
              <div className="space-y-6">
                <section className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">tool_name</label>
                      <Input
                        value={editor.toolName}
                        onChange={(event) =>
                          setEditor((current) =>
                            current ? { ...current, toolName: event.target.value } : current
                          )
                        }
                        placeholder="例如：list_github_issues"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        仅支持英文、数字、下划线(_)和短横线(-)
                      </p>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">当前 tool_id</label>
                      <div className="min-h-9 rounded-sm border border-border bg-muted/30 px-3 py-2 font-mono text-xs break-all">
                        {selectedTool.toolId}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        保存后会按 tool_name 重新生成 tool_id
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">tool_description</label>
                    <textarea
                      value={editor.description}
                      onChange={(event) =>
                        setEditor((current) =>
                          current ? { ...current, description: event.target.value } : current
                        )
                      }
                      className="min-h-24 w-full rounded-sm border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                </section>

                <Separator />

                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-muted-foreground">code</label>
                    <span className="text-[11px] text-muted-foreground">
                      保存时会同步更新 codeHash 和依赖列表
                    </span>
                  </div>
                  <textarea
                    value={editor.code}
                    onChange={(event) =>
                      setEditor((current) =>
                        current ? { ...current, code: event.target.value } : current
                      )
                    }
                    className="min-h-[360px] w-full rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    spellCheck={false}
                  />
                </section>

                <Separator />

                <section className="space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-semibold">试运行</h4>
                      <p className="text-xs text-muted-foreground mt-1">
                        可直接用当前未保存的代码和 params 执行
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRunPreview}
                      disabled={running || saving || deleting}
                    >
                      {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                      运行
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">params</label>
                    <textarea
                      value={editor.paramsText}
                      onChange={(event) =>
                        setEditor((current) =>
                          current ? { ...current, paramsText: event.target.value } : current
                        )
                      }
                      className="min-h-44 w-full rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      spellCheck={false}
                    />
                  </div>

                  <div className="space-y-3 rounded-sm border border-border bg-muted/20 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-muted-foreground">运行结果</span>
                      {runResult && (
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium",
                            runResult.ok
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "bg-destructive/10 text-destructive"
                          )}
                        >
                          {runResult.ok ? "成功" : runResult.stage || "失败"}
                        </span>
                      )}
                    </div>

                    <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs leading-5">
                      {runResult
                        ? formatStructuredValue(runResult.ok ? runResult.parsedOutput ?? runResult.output : runResult.output)
                        : "填写 params 后点击“运行”查看结果"}
                    </pre>

                    {runResult?.logs?.length ? (
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">logs</div>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs leading-5">
                          {runResult.logs.join("\n")}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>

              <div className="space-y-6">
                <section className="space-y-4 rounded-sm border border-border p-4">
                  <h4 className="text-sm font-semibold">当前详情</h4>
                  <DetailRow label="tool_id" value={selectedTool.toolId} mono />
                  <DetailRow label="timeout" value={`${selectedTool.timeoutMs}ms`} />
                  <DetailRow label="创建时间" value={formatTime(selectedTool.createdAt)} />
                  <DetailRow label="更新时间" value={formatTime(selectedTool.updatedAt)} />
                  <DetailRow
                    label="依赖"
                    value={selectedTool.dependencies.length ? selectedTool.dependencies.join(", ") : "暂无"}
                    mono
                  />
                </section>

                <JsonBlock title="input_schema" value={selectedTool.inputSchema} />
                <JsonBlock title="output_schema" value={selectedTool.outputSchema ?? null} />
                <JsonBlock title="result_example" value={selectedTool.resultExample ?? null} />
              </div>
            </div>
          </div>
        ) : (
          <EmptyState loading={loading} />
        )}
      </div>
    </>
  )
}

function DetailRow(props: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">{props.label}</div>
      <div className={cn("text-sm break-all", props.mono && "font-mono text-xs")}>
        {props.value}
      </div>
    </div>
  )
}

function JsonBlock(props: { title: string; value: unknown }): React.JSX.Element {
  return (
    <section className="space-y-2 rounded-sm border border-border p-4">
      <h4 className="text-sm font-semibold">{props.title}</h4>
      <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/20 px-3 py-2 font-mono text-xs leading-5">
        {formatStructuredValue(props.value)}
      </pre>
    </section>
  )
}

function EmptyState(props: { loading: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-12 text-center">
      {props.loading ? (
        <Loader2 className="mb-4 size-10 animate-spin text-muted-foreground/60" />
      ) : (
        <FileCode2 className="mb-4 size-12 text-muted-foreground/40" />
      )}
      <h3 className="text-base font-bold">自定义工具管理</h3>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {props.loading
          ? "正在加载已保存的 code_exec 工具..."
          : "这里会显示通过 code_exec 保存下来的可复用工具。"}
      </p>
    </div>
  )
}
