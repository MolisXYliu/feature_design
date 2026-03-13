/**
 * EvolutionPanel — Skill Optimization & Trace Viewer
 *
 * Tabs:
 *   - 优化候选: LLM-generated skill proposals for human review
 *   - 执行 Traces: clickable trace cards with full step-by-step tree
 */

import { useCallback, useEffect, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  RefreshCw,
  Sparkles,
  Activity,
  Trash2,
  Wrench,
  MessageSquare,
  AlertCircle,
  Code2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface SkillCandidate {
  candidateId: string
  action: "create" | "patch"
  skillId: string
  name: string
  description: string
  proposedContent: string
  rationale: string
  sourceTraceIds: string[]
  generatedAt: string
  status: "pending" | "approved" | "rejected"
}

interface TraceEntry {
  traceId: string
  threadId: string
  startedAt: string
  durationMs: number
  userMessage: string
  totalToolCalls: number
  outcome: string
  activeSkills: string[]
}

interface TraceToolCall {
  name: string
  args: Record<string, unknown>
  result?: string
  durationMs?: number
}

interface TraceStep {
  index: number
  startedAt: string
  assistantText: string
  toolCalls: TraceToolCall[]
}

interface TraceDetail extends TraceEntry {
  endedAt: string
  modelId: string
  errorMessage?: string
  steps: TraceStep[]
}

// ─────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────

function OutcomeBadge({ outcome }: { outcome: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    success:   { label: "成功",   cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" },
    error:     { label: "错误",   cls: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20" },
    cancelled: { label: "已取消", cls: "bg-zinc-500/15 text-zinc-500 border-zinc-500/20" },
    unknown:   { label: "未知",   cls: "bg-zinc-500/15 text-zinc-500 border-zinc-500/20" }
  }
  const { label, cls } = map[outcome] ?? map.unknown
  return <Badge className={cn("border text-xs px-1.5 py-0", cls)}>{label}</Badge>
}

function ToolBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20">
      <Wrench className="size-2.5 shrink-0" />
      {name}
    </span>
  )
}

// ─────────────────────────────────────────────────────────
// Trace detail: step tree
// ─────────────────────────────────────────────────────────

function ToolCallRow({ tc, stepIndex, tcIndex }: { tc: TraceToolCall; stepIndex: number; tcIndex: number }) {
  const [open, setOpen] = useState(false)
  const hasArgs = tc.args && Object.keys(tc.args).length > 0

  return (
    <div className="ml-6 border-l border-border pl-3 py-0.5">
      <button
        className="flex items-center gap-2 w-full text-left py-1 group"
        onClick={() => hasArgs && setOpen((o) => !o)}
      >
        <span className="text-muted-foreground/50 text-[10px] font-mono w-5 shrink-0">
          {stepIndex}.{tcIndex + 1}
        </span>
        <ToolBadge name={tc.name} />
        {hasArgs && (
          <span className="text-[10px] text-muted-foreground/60 truncate flex-1">
            {Object.entries(tc.args).slice(0, 2).map(([k, v]) =>
              `${k}=${JSON.stringify(v).slice(0, 40)}`
            ).join(", ")}
          </span>
        )}
        {hasArgs && (
          open
            ? <ChevronDown className="size-3 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground" />
            : <ChevronRight className="size-3 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground" />
        )}
      </button>
      {open && hasArgs && (
        <div className="ml-5 mt-1 mb-1.5 rounded border border-border bg-muted/30 overflow-x-auto">
          <pre className="text-[10px] font-mono p-2 text-foreground/70 leading-relaxed whitespace-pre-wrap break-all">
            {JSON.stringify(tc.args, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function StepRow({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false)
  const hasText = step.assistantText.trim().length > 0
  const hasTools = step.toolCalls.length > 0

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Step header */}
      <button
        className="flex items-center gap-2.5 w-full text-left px-3 py-2.5 hover:bg-muted/40 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        {/* Step number bubble */}
        <span className="size-5 rounded-full bg-muted border border-border flex items-center justify-center text-[10px] font-mono shrink-0 text-muted-foreground">
          {step.index + 1}
        </span>

        {/* Summary */}
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          {hasText && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <MessageSquare className="size-3 shrink-0" />
              <span className="truncate max-w-[200px]">
                {step.assistantText.trim().slice(0, 80)}
                {step.assistantText.trim().length > 80 ? "…" : ""}
              </span>
            </span>
          )}
          {hasTools && (
            <span className="flex items-center gap-1 flex-wrap">
              {step.toolCalls.map((tc, i) => (
                <ToolBadge key={i} name={tc.name} />
              ))}
            </span>
          )}
          {!hasText && !hasTools && (
            <span className="text-[11px] text-muted-foreground/50 italic">（空步骤）</span>
          )}
        </div>

        {/* Expand icon */}
        {(hasText || hasTools) && (
          open
            ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/50" />
            : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
        )}
      </button>

      {/* Expanded content */}
      {open && (
        <div className="border-t border-border bg-muted/20 px-3 py-2.5 space-y-2">
          {/* Reasoning text */}
          {hasText && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <MessageSquare className="size-3" /> 推理过程
              </p>
              <div className="text-xs text-foreground/75 leading-relaxed bg-background rounded border border-border p-2.5 max-h-40 overflow-y-auto whitespace-pre-wrap">
                {step.assistantText.trim()}
              </div>
            </div>
          )}

          {/* Tool calls */}
          {hasTools && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <Wrench className="size-3" /> 工具调用 ({step.toolCalls.length})
              </p>
              <div className="space-y-0.5">
                {step.toolCalls.map((tc, i) => (
                  <ToolCallRow key={i} tc={tc} stepIndex={step.index + 1} tcIndex={i} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TraceDetailView({ detail, onClose }: { detail: TraceDetail; onClose: () => void }) {
  const durationSec = (detail.durationMs / 1000).toFixed(1)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-border bg-background">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight className="size-3.5 rotate-180" />
          返回
        </button>
        <span className="text-muted-foreground/40">/</span>
        <OutcomeBadge outcome={detail.outcome} />
        <span className="text-xs font-mono text-muted-foreground">{detail.traceId.slice(0, 8)}</span>
        <span className="ml-auto text-xs text-muted-foreground">{durationSec}s · {detail.totalToolCalls} 次工具调用</span>
      </div>

      {/* Meta row */}
      <div className="shrink-0 px-4 py-2 border-b border-border bg-muted/20 flex flex-wrap gap-x-4 gap-y-1">
        <span className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/70">时间：</span>
          {new Date(detail.startedAt).toLocaleString()}
        </span>
        <span className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/70">模型：</span>
          {detail.modelId}
        </span>
        {detail.activeSkills.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground/70">Skills：</span>
            {detail.activeSkills.join(", ")}
          </span>
        )}
      </div>

      {/* User message */}
      <div className="shrink-0 px-4 py-2.5 border-b border-border bg-blue-500/5">
        <p className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider mb-1">用户消息</p>
        <p className="text-sm text-foreground/80">{detail.userMessage}</p>
      </div>

      {/* Error banner */}
      {detail.errorMessage && (
        <div className="shrink-0 px-4 py-2 bg-red-500/10 border-b border-red-500/20 flex items-center gap-2">
          <AlertCircle className="size-3.5 text-red-500 shrink-0" />
          <span className="text-xs text-red-600 dark:text-red-400">{detail.errorMessage}</span>
        </div>
      )}

      {/* Steps */}
      <ScrollArea className="flex-1">
        <div className="px-4 py-3 space-y-2">
          {detail.steps.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-center">
              <Code2 className="size-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">无步骤记录</p>
              <p className="text-xs text-muted-foreground/60 mt-1">此 trace 未捕获到推理步骤</p>
            </div>
          ) : (
            detail.steps.map((step) => <StepRow key={step.index} step={step} />)
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Trace list card
// ─────────────────────────────────────────────────────────

function TraceCard({
  trace,
  onExpand
}: {
  trace: TraceEntry
  onExpand: (traceId: string) => void
}) {
  const durationSec = (trace.durationMs / 1000).toFixed(1)
  const short = trace.userMessage.slice(0, 80) + (trace.userMessage.length > 80 ? "…" : "")

  return (
    <button
      className="w-full text-left rounded-lg border border-border bg-card p-3 space-y-1.5 hover:bg-muted/40 transition-colors group"
      onClick={() => onExpand(trace.traceId)}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <OutcomeBadge outcome={trace.outcome} />
        <span className="text-xs text-muted-foreground font-mono">{trace.traceId.slice(0, 8)}</span>
        <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1.5">
          {durationSec}s
          {trace.totalToolCalls > 0 && (
            <span className="flex items-center gap-0.5">
              · <Wrench className="size-3" /> {trace.totalToolCalls}
            </span>
          )}
          <ChevronRight className="size-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
        </span>
      </div>
      <p className="text-xs text-foreground/80">{short}</p>
      <p className="text-[10px] text-muted-foreground/60">
        {new Date(trace.startedAt).toLocaleString()}
        {trace.activeSkills.length > 0 && ` · ${trace.activeSkills.join(", ")}`}
      </p>
    </button>
  )
}

// ─────────────────────────────────────────────────────────
// Candidate card
// ─────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "approved") return (
    <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 border gap-1 text-xs">
      <CheckCircle2 className="size-3" /> 已采纳
    </Badge>
  )
  if (status === "rejected") return (
    <Badge className="bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20 border gap-1 text-xs">
      <XCircle className="size-3" /> 已拒绝
    </Badge>
  )
  return (
    <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20 border gap-1 text-xs">
      <Clock className="size-3" /> 待审批
    </Badge>
  )
}

function CandidateCard({
  candidate,
  onApprove,
  onReject
}: {
  candidate: SkillCandidate
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleApprove = async (): Promise<void> => {
    setLoading(true)
    await onApprove(candidate.candidateId)
    setLoading(false)
  }

  const handleReject = async (): Promise<void> => {
    setLoading(true)
    await onReject(candidate.candidateId)
    setLoading(false)
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        <button
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{candidate.name}</span>
            <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0">{candidate.skillId}</Badge>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {candidate.action === "create" ? "新建" : "更新"}
            </Badge>
            <StatusBadge status={candidate.status} />
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{candidate.description}</p>
          <p className="text-[10px] text-muted-foreground/60 mt-1">
            基于 {candidate.sourceTraceIds.length} 条 trace · {new Date(candidate.generatedAt).toLocaleString()}
          </p>
        </div>
        {candidate.status === "pending" && (
          <div className="flex gap-1.5 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600"
              onClick={handleApprove}
              disabled={loading}
            >
              {loading ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3 mr-1" />}
              采纳
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive"
              onClick={handleReject}
              disabled={loading}
            >
              <XCircle className="size-3 mr-1" />
              拒绝
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-border bg-muted/30 px-4 pb-4 pt-3 space-y-3">
          {candidate.rationale && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">优化理由</p>
              <p className="text-xs text-foreground/80">{candidate.rationale}</p>
            </div>
          )}
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">SKILL.md 预览</p>
            <div className="rounded border border-border bg-background p-3 max-h-64 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]} className="prose prose-sm dark:prose-invert max-w-none text-xs">
                {candidate.proposedContent}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Main panel
// ─────────────────────────────────────────────────────────

type Tab = "candidates" | "traces"

export function EvolutionPanel(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("candidates")
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<SkillCandidate[]>([])
  const [traces, setTraces] = useState<TraceEntry[]>([])
  const [tracesLoading, setTracesLoading] = useState(false)
  const [selectedTrace, setSelectedTrace] = useState<TraceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Load existing in-memory candidates on mount
  useEffect(() => {
    window.api.optimizer.getCandidates().then(setCandidates).catch(console.warn)
  }, [])

  // Load traces when switching to traces tab
  useEffect(() => {
    if (tab !== "traces") return
    if (selectedTrace) return // don't reload when viewing detail
    setTracesLoading(true)
    window.api.optimizer
      .getTraces({ limit: 50 })
      .then(setTraces)
      .catch(console.warn)
      .finally(() => setTracesLoading(false))
  }, [tab, selectedTrace])

  const handleExpandTrace = useCallback(async (traceId: string) => {
    setDetailLoading(true)
    try {
      const detail = await window.api.optimizer.getTraceDetail(traceId)
      if (detail) setSelectedTrace(detail as TraceDetail)
    } catch (e) {
      console.warn("Failed to load trace detail:", e)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const handleRun = useCallback(async () => {
    setRunning(true)
    setSummary(null)
    try {
      const result = await window.api.optimizer.run()
      setSummary(result.summary)
      const all = await window.api.optimizer.getCandidates()
      setCandidates(all)
    } catch (e) {
      setSummary(`运行失败: ${String(e)}`)
    } finally {
      setRunning(false)
    }
  }, [])

  const handleApprove = useCallback(async (candidateId: string) => {
    const res = await window.api.optimizer.approve(candidateId)
    if (res.success) {
      setCandidates((prev) =>
        prev.map((c) => (c.candidateId === candidateId ? { ...c, status: "approved" } : c))
      )
    }
  }, [])

  const handleReject = useCallback(async (candidateId: string) => {
    await window.api.optimizer.reject(candidateId)
    setCandidates((prev) =>
      prev.map((c) => (c.candidateId === candidateId ? { ...c, status: "rejected" } : c))
    )
  }, [])

  const handleClear = useCallback(async () => {
    await window.api.optimizer.clear()
    setCandidates([])
    setSummary(null)
  }, [])

  const pendingCount = candidates.filter((c) => c.status === "pending").length

  // Show trace detail view
  if (detailLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (selectedTrace) {
    return <TraceDetailView detail={selectedTrace} onClose={() => setSelectedTrace(null)} />
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-border px-4 py-3 flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold flex-1">技能优化 (Evolution)</span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={handleClear}
          disabled={running || candidates.length === 0}
        >
          <Trash2 className="size-3" />
          清除候选
        </Button>
        <Button
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={handleRun}
          disabled={running}
        >
          {running ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {running ? "分析中…" : "分析 Traces"}
        </Button>
      </div>

      {/* Summary banner */}
      {summary && (
        <div className="shrink-0 px-4 py-2 bg-muted/50 border-b border-border">
          <p className="text-xs text-muted-foreground">{summary}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="shrink-0 flex border-b border-border px-4">
        <button
          className={cn(
            "flex items-center gap-1.5 text-xs py-2 px-1 border-b-2 mr-4 transition-colors",
            tab === "candidates"
              ? "border-foreground text-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setTab("candidates")}
        >
          <Sparkles className="size-3.5" />
          优化候选
          {pendingCount > 0 && (
            <span className="ml-1 inline-flex items-center justify-center size-4 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 text-[10px] font-bold">
              {pendingCount}
            </span>
          )}
        </button>
        <button
          className={cn(
            "flex items-center gap-1.5 text-xs py-2 px-1 border-b-2 transition-colors",
            tab === "traces"
              ? "border-foreground text-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setTab("traces")}
        >
          <Activity className="size-3.5" />
          执行 Traces
          {traces.length > 0 && tab === "traces" && (
            <span className="ml-1 text-[10px] text-muted-foreground">({traces.length})</span>
          )}
        </button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-2">
          {tab === "candidates" ? (
            candidates.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Sparkles className="size-8 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">暂无优化候选</p>
                <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs">
                  点击「分析 Traces」，Agent 将分析近期执行记录并提出技能优化建议
                </p>
              </div>
            ) : (
              candidates.map((c) => (
                <CandidateCard
                  key={c.candidateId}
                  candidate={c}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              ))
            )
          ) : tracesLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : traces.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Activity className="size-8 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">暂无执行记录</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Traces 在每次 Agent 调用后自动记录到本地
              </p>
            </div>
          ) : (
            traces.map((t) => (
              <TraceCard key={t.traceId} trace={t} onExpand={handleExpandTrace} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
