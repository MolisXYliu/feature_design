/**
 * EvolutionPanel
 *
 * UI for the offline skill optimization loop.
 *
 * Tabs:
 *   - Candidates: list of LLM-generated skill improvement proposals
 *   - Traces:     recent execution traces (read-only, for context)
 *
 * Workflow:
 *   1. User clicks "分析 Traces" — calls optimizer:run
 *   2. LLM analyzes recent traces and returns candidates
 *   3. User reviews each candidate (description, rationale, SKILL.md preview)
 *   4. User approves (writes skill) or rejects (discards)
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
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────
// Types (mirrored from optimizer/skill-optimizer.ts)
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

// ─────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "approved") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-0 gap-1 text-xs">
        <CheckCircle2 className="size-3" />
        已采纳
      </Badge>
    )
  }
  if (status === "rejected") {
    return (
      <Badge className="bg-red-500/15 text-red-600 dark:text-red-400 border-0 gap-1 text-xs">
        <XCircle className="size-3" />
        已拒绝
      </Badge>
    )
  }
  return (
    <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-0 gap-1 text-xs">
      <Clock className="size-3" />
      待审批
    </Badge>
  )
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    success: { label: "成功", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
    error:   { label: "错误", cls: "bg-red-500/15 text-red-600 dark:text-red-400" },
    cancelled: { label: "已取消", cls: "bg-zinc-500/15 text-zinc-500" },
    unknown: { label: "未知", cls: "bg-zinc-500/15 text-zinc-500" }
  }
  const { label, cls } = map[outcome] ?? map.unknown
  return <Badge className={cn("border-0 text-xs", cls)}>{label}</Badge>
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
      {/* Header */}
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

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border bg-muted/30 px-4 pb-4 pt-3 space-y-3">
          {candidate.rationale && (
            <div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                优化理由
              </p>
              <p className="text-xs text-foreground/80">{candidate.rationale}</p>
            </div>
          )}
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">
              SKILL.md 预览
            </p>
            <div className="rounded border border-border bg-background p-3 max-h-64 overflow-y-auto">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                className="prose prose-sm dark:prose-invert max-w-none text-xs"
              >
                {candidate.proposedContent}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TraceCard({ trace }: { trace: TraceEntry }) {
  const durationSec = (trace.durationMs / 1000).toFixed(1)
  const short = trace.userMessage.slice(0, 80) + (trace.userMessage.length > 80 ? "…" : "")
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <OutcomeBadge outcome={trace.outcome} />
        <span className="text-xs text-muted-foreground font-mono">{trace.traceId.slice(0, 8)}</span>
        <span className="text-xs text-muted-foreground ml-auto">{durationSec}s · {trace.totalToolCalls} 次工具调用</span>
      </div>
      <p className="text-xs text-foreground/80">{short}</p>
      <p className="text-[10px] text-muted-foreground/60">
        {new Date(trace.startedAt).toLocaleString()}
        {trace.activeSkills.length > 0 && ` · Skills: ${trace.activeSkills.join(", ")}`}
      </p>
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

  // Load existing in-memory candidates on mount
  useEffect(() => {
    window.api.optimizer.getCandidates().then(setCandidates).catch(console.warn)
  }, [])

  // Load traces when switching to traces tab
  useEffect(() => {
    if (tab !== "traces") return
    setTracesLoading(true)
    window.api.optimizer
      .getTraces({ limit: 30 })
      .then(setTraces)
      .catch(console.warn)
      .finally(() => setTracesLoading(false))
  }, [tab])

  const handleRun = useCallback(async () => {
    setRunning(true)
    setSummary(null)
    try {
      const result = await window.api.optimizer.run()
      setSummary(result.summary)
      // Reload candidates (run merges with existing pending ones)
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
    } else {
      console.warn("[EvolutionPanel] Approve failed:", res.error)
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
          清除
        </Button>
        <Button
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={handleRun}
          disabled={running}
        >
          {running ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
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
            traces.map((t) => <TraceCard key={t.traceId} trace={t} />)
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
