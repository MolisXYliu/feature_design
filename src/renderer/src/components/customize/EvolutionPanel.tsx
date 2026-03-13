/**
 * EvolutionPanel — Skill Optimization & LangSmith-style Trace Viewer
 */

import { useCallback, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock,
  Loader2, RefreshCw, Sparkles, Activity, Trash2, Wrench,
  MessageSquare, AlertCircle, User, Bot, Terminal, ArrowLeft,
  Timer, Hash, Cpu
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface SkillCandidate {
  candidateId: string; action: "create" | "patch"; skillId: string
  name: string; description: string; proposedContent: string
  rationale: string; sourceTraceIds: string[]; generatedAt: string
  status: "pending" | "approved" | "rejected"
}

interface TraceEntry {
  traceId: string; threadId: string; startedAt: string; durationMs: number
  userMessage: string; totalToolCalls: number; outcome: string; activeSkills: string[]
}

interface TraceToolCall {
  name: string; args: Record<string, unknown>; result?: string; durationMs?: number
}

interface TraceStep {
  index: number; startedAt: string; assistantText: string; toolCalls: TraceToolCall[]
}

interface TraceDetail extends TraceEntry {
  endedAt: string; modelId: string; errorMessage?: string; steps: TraceStep[]
}

// ─────────────────────────────────────────────────────────
// Colour helpers
// ─────────────────────────────────────────────────────────

const TOOL_COLORS: Record<string, string> = {
  read_file:       "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  write_file:      "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  list_directory:  "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
  bash:            "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
  search:          "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  manage_skill:    "bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20",
}

function toolColor(name: string) {
  return TOOL_COLORS[name] ?? "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20"
}

function outcomeColor(outcome: string) {
  return {
    success:   "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    error:     "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
    cancelled: "bg-zinc-500/15 text-zinc-500 border-zinc-500/20",
  }[outcome] ?? "bg-zinc-500/15 text-zinc-500 border-zinc-500/20"
}

function fmt(ms: number) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

// ─────────────────────────────────────────────────────────
// LangSmith-style Trace detail
// ─────────────────────────────────────────────────────────

/** Collapsible JSON viewer */
function JsonBlock({ data }: { data: unknown }) {
  const [open, setOpen] = useState(false)
  const str = JSON.stringify(data, null, 2)
  const lines = str.split("\n").length
  const preview = str.slice(0, 120).replace(/\n/g, " ")
  if (lines <= 3) {
    return (
      <pre className="font-mono text-[11px] text-foreground/70 leading-relaxed whitespace-pre-wrap break-all">
        {str}
      </pre>
    )
  }
  return (
    <div>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="text-[11px] font-mono text-muted-foreground/70 hover:text-foreground/80 transition-colors text-left"
        >
          {preview}… <span className="text-blue-500 hover:underline">展开</span>
        </button>
      )}
      {open && (
        <div>
          <pre className="font-mono text-[11px] text-foreground/70 leading-relaxed whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
            {str}
          </pre>
          <button onClick={() => setOpen(false)} className="text-[11px] text-blue-500 hover:underline mt-1">
            收起
          </button>
        </div>
      )}
    </div>
  )
}

/** One tool call row — LangSmith style with left accent bar */
function ToolCallRow({ tc, index }: { tc: TraceToolCall; index: number }) {
  const [open, setOpen] = useState(false)
  const cls = toolColor(tc.name)

  return (
    <div className={cn("ml-8 mt-1 rounded-md border overflow-hidden", cls.split(" ").find(c => c.startsWith("border")))}>
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors group text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div className={cn("flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono font-semibold border shrink-0", cls)}>
          <Wrench className="size-3" />
          {tc.name}
        </div>
        <span className="text-[11px] text-muted-foreground/70 font-mono truncate flex-1">
          {Object.entries(tc.args).slice(0, 2).map(([k, v]) =>
            `${k}=${JSON.stringify(v).slice(0, 40)}`
          ).join(", ")}
        </span>
        <span className="text-[10px] text-muted-foreground/40 shrink-0 mr-1">#{index + 1}</span>
        {open
          ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/40" />
          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/40" />
        }
      </button>

      {/* Expanded: args + result */}
      {open && (
        <div className="border-t border-border/50 divide-y divide-border/50">
          {/* Input */}
          <div className="px-3 py-2 bg-background/50">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
              Input
            </p>
            <JsonBlock data={tc.args} />
          </div>
          {/* Output */}
          {tc.result !== undefined && (
            <div className="px-3 py-2 bg-background/50">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Output
              </p>
              <pre className="font-mono text-[11px] text-foreground/70 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {tc.result.slice(0, 2000)}{tc.result.length > 2000 ? "\n…(truncated)" : ""}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** One reasoning step — LangSmith "run" row */
function StepRow({ step, runIndex, totalSteps }: { step: TraceStep; runIndex: number; totalSteps: number }) {
  const [open, setOpen] = useState(false)
  const hasText = step.assistantText.trim().length > 0
  const hasTools = step.toolCalls.length > 0
  const isLast = runIndex === totalSteps - 1

  return (
    <div className="relative">
      {/* Vertical timeline line */}
      {!isLast && (
        <div className="absolute left-[15px] top-9 bottom-0 w-px bg-border/60" />
      )}

      <div className="flex gap-3">
        {/* Step dot */}
        <div className="shrink-0 mt-3 size-[30px] rounded-full border-2 border-border bg-background flex items-center justify-center z-10">
          <Bot className="size-3.5 text-muted-foreground" />
        </div>

        <div className="flex-1 min-w-0 pb-4">
          {/* Step header */}
          <button
            className="w-full flex items-center gap-2 py-2 text-left group"
            onClick={() => setOpen(o => !o)}
          >
            <span className="text-[11px] font-semibold text-foreground/80">
              LLM Call #{runIndex + 1}
            </span>
            {hasTools && (
              <span className="flex items-center gap-1 flex-wrap">
                {step.toolCalls.slice(0, 4).map((tc, i) => (
                  <span key={i} className={cn("text-[10px] font-mono px-1.5 py-0 rounded border", toolColor(tc.name))}>
                    {tc.name}
                  </span>
                ))}
                {step.toolCalls.length > 4 && (
                  <span className="text-[10px] text-muted-foreground">+{step.toolCalls.length - 4}</span>
                )}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/50">
              {new Date(step.startedAt).toLocaleTimeString()}
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </span>
          </button>

          {/* Collapsed preview */}
          {!open && hasText && (
            <p className="text-[11px] text-muted-foreground/60 leading-relaxed line-clamp-2 ml-0.5">
              {step.assistantText.trim()}
            </p>
          )}

          {/* Expanded */}
          {open && (
            <div className="space-y-2 mt-1">
              {/* Thinking / reasoning text */}
              {hasText && (
                <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/50 bg-muted/30">
                    <MessageSquare className="size-3 text-muted-foreground" />
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Reasoning</span>
                  </div>
                  <div className="px-3 py-2.5 text-[12px] text-foreground/80 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto font-mono">
                    {step.assistantText.trim()}
                  </div>
                </div>
              )}

              {/* Tool calls */}
              {hasTools && (
                <div className="space-y-1">
                  {step.toolCalls.map((tc, i) => (
                    <ToolCallRow key={i} tc={tc} index={step.index * 10 + i} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Full LangSmith-style trace detail page */
function TraceDetailView({ detail, onClose }: { detail: TraceDetail; onClose: () => void }) {
  const durationMs = detail.durationMs

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Top nav bar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border bg-background/95 backdrop-blur">
        <button
          onClick={onClose}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Traces
        </button>
        <span className="text-muted-foreground/30 text-sm">/</span>
        <span className="text-xs font-mono text-muted-foreground">{detail.traceId.slice(0, 16)}</span>
        <span className="ml-auto">
          <Badge className={cn("border text-xs px-2 py-0.5", outcomeColor(detail.outcome))}>
            {detail.outcome === "success" ? "✓ 成功" : detail.outcome === "error" ? "✗ 错误" : "已取消"}
          </Badge>
        </span>
      </div>

      {/* Stats row — like LangSmith's summary bar */}
      <div className="shrink-0 flex gap-0 border-b border-border divide-x divide-border">
        {[
          { icon: <Timer className="size-3.5" />, label: "耗时", value: fmt(durationMs) },
          { icon: <Hash className="size-3.5" />, label: "工具调用", value: String(detail.totalToolCalls) },
          { icon: <Cpu className="size-3.5" />, label: "步骤", value: String(detail.steps.length) },
          { icon: <Bot className="size-3.5" />, label: "模型", value: detail.modelId.split("/").pop() ?? detail.modelId },
        ].map(({ icon, label, value }) => (
          <div key={label} className="flex items-center gap-2 px-4 py-2.5 min-w-0">
            <span className="text-muted-foreground/60 shrink-0">{icon}</span>
            <div className="min-w-0">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider leading-none mb-0.5">{label}</p>
              <p className="text-[12px] font-semibold text-foreground truncate">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Main: two-column layout like LangSmith */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: timeline */}
        <div className="flex-1 overflow-hidden flex flex-col border-r border-border">
          <div className="shrink-0 px-4 pt-3 pb-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">执行时间线</p>
          </div>
          <ScrollArea className="flex-1 px-4 pb-4">
            {/* User message node */}
            <div className="relative">
              <div className="absolute left-[15px] top-9 bottom-0 w-px bg-border/60" />
              <div className="flex gap-3 pb-4">
                <div className="shrink-0 mt-3 size-[30px] rounded-full border-2 border-blue-500/40 bg-blue-500/10 flex items-center justify-center z-10">
                  <User className="size-3.5 text-blue-500" />
                </div>
                <div className="flex-1 pt-2">
                  <p className="text-[11px] font-semibold text-foreground/80 mb-1">User Message</p>
                  <p className="text-[12px] text-foreground/70 leading-relaxed">{detail.userMessage}</p>
                </div>
              </div>
            </div>

            {/* Steps */}
            {detail.steps.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-center">
                <Terminal className="size-8 text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">无步骤记录</p>
              </div>
            ) : (
              detail.steps.map((step, i) => (
                <StepRow key={step.index} step={step} runIndex={i} totalSteps={detail.steps.length} />
              ))
            )}

            {/* End node */}
            <div className="flex gap-3">
              <div className={cn(
                "shrink-0 mt-1 size-[30px] rounded-full border-2 flex items-center justify-center",
                detail.outcome === "success"
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : "border-red-500/40 bg-red-500/10"
              )}>
                {detail.outcome === "success"
                  ? <CheckCircle2 className="size-3.5 text-emerald-500" />
                  : <AlertCircle className="size-3.5 text-red-500" />
                }
              </div>
              <div className="pt-1.5">
                <p className="text-[11px] font-semibold text-foreground/60">
                  {detail.outcome === "success" ? "完成" : detail.errorMessage ?? "错误"}
                </p>
                <p className="text-[10px] text-muted-foreground/40">{new Date(detail.endedAt).toLocaleTimeString()}</p>
              </div>
            </div>
          </ScrollArea>
        </div>

        {/* Right: metadata panel */}
        <div className="w-56 shrink-0 flex flex-col overflow-hidden">
          <div className="shrink-0 px-4 pt-3 pb-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">元数据</p>
          </div>
          <ScrollArea className="flex-1 px-4 pb-4">
            <div className="space-y-4 text-[11px]">
              <Section label="Trace ID">
                <span className="font-mono text-[10px] break-all">{detail.traceId}</span>
              </Section>
              <Section label="Thread ID">
                <span className="font-mono text-[10px] break-all">{detail.threadId}</span>
              </Section>
              <Section label="开始时间">
                {new Date(detail.startedAt).toLocaleString()}
              </Section>
              <Section label="结束时间">
                {new Date(detail.endedAt).toLocaleString()}
              </Section>
              {detail.activeSkills.length > 0 && (
                <Section label="Active Skills">
                  <div className="flex flex-wrap gap-1 mt-1">
                    {detail.activeSkills.map(s => (
                      <span key={s} className="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 text-[10px] font-mono">
                        {s}
                      </span>
                    ))}
                  </div>
                </Section>
              )}
              {detail.errorMessage && (
                <Section label="Error">
                  <span className="text-red-500 break-all">{detail.errorMessage}</span>
                </Section>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider mb-1">{label}</p>
      <div className="text-foreground/70">{children}</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Trace list card
// ─────────────────────────────────────────────────────────

function TraceCard({ trace, onExpand }: { trace: TraceEntry; onExpand: (id: string) => void }) {
  return (
    <button
      className="w-full text-left rounded-lg border border-border bg-card hover:bg-muted/30 transition-colors group overflow-hidden"
      onClick={() => onExpand(trace.traceId)}
    >
      {/* Accent bar */}
      <div className={cn("h-0.5 w-full",
        trace.outcome === "success" ? "bg-emerald-500/60" :
        trace.outcome === "error"   ? "bg-red-500/60" : "bg-zinc-500/30"
      )} />
      <div className="p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <Badge className={cn("border text-[10px] px-1.5 py-0 shrink-0", outcomeColor(trace.outcome))}>
            {trace.outcome === "success" ? "成功" : trace.outcome === "error" ? "错误" : "取消"}
          </Badge>
          <span className="text-[10px] font-mono text-muted-foreground/60">{trace.traceId.slice(0, 8)}</span>
          <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground/60 shrink-0">
            <span className="flex items-center gap-0.5"><Timer className="size-3" />{fmt(trace.durationMs)}</span>
            {trace.totalToolCalls > 0 && (
              <span className="flex items-center gap-0.5"><Wrench className="size-3" />{trace.totalToolCalls}</span>
            )}
            <ChevronRight className="size-3.5 opacity-0 group-hover:opacity-60 transition-opacity" />
          </span>
        </div>
        <p className="text-[12px] text-foreground/80 line-clamp-2 leading-snug">
          {trace.userMessage}
        </p>
        <p className="text-[10px] text-muted-foreground/50">
          {new Date(trace.startedAt).toLocaleString()}
          {trace.activeSkills.length > 0 && (
            <span className="ml-2 text-violet-500/70">{trace.activeSkills.join(", ")}</span>
          )}
        </p>
      </div>
    </button>
  )
}

// ─────────────────────────────────────────────────────────
// Candidate card (unchanged logic, cleaned up)
// ─────────────────────────────────────────────────────────

function CandidateCard({ candidate, onApprove, onReject }: {
  candidate: SkillCandidate
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)

  const approve = async () => { setLoading(true); await onApprove(candidate.candidateId); setLoading(false) }
  const reject  = async () => { setLoading(true); await onReject(candidate.candidateId);  setLoading(false) }

  const statusEl = candidate.status === "approved"
    ? <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 gap-1 text-xs"><CheckCircle2 className="size-3" />已采纳</Badge>
    : candidate.status === "rejected"
    ? <Badge className="bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/20 gap-1 text-xs"><XCircle className="size-3" />已拒绝</Badge>
    : <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20 gap-1 text-xs"><Clock className="size-3" />待审批</Badge>

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        <button className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setExpanded(e => !e)}>
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{candidate.name}</span>
            <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0">{candidate.skillId}</Badge>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">{candidate.action === "create" ? "新建" : "更新"}</Badge>
            {statusEl}
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{candidate.description}</p>
          <p className="text-[10px] text-muted-foreground/50 mt-1">
            基于 {candidate.sourceTraceIds.length} 条 trace · {new Date(candidate.generatedAt).toLocaleString()}
          </p>
        </div>
        {candidate.status === "pending" && (
          <div className="flex gap-1.5 shrink-0">
            <Button size="sm" variant="outline" disabled={loading}
              className="h-7 px-2.5 text-xs border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600"
              onClick={approve}>
              {loading ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3 mr-1" />}采纳
            </Button>
            <Button size="sm" variant="ghost" disabled={loading}
              className="h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive"
              onClick={reject}>
              <XCircle className="size-3 mr-1" />拒绝
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
  const [tab, setTab]             = useState<Tab>("candidates")
  const [running, setRunning]     = useState(false)
  const [summary, setSummary]     = useState<string | null>(null)
  const [candidates, setCandidates] = useState<SkillCandidate[]>([])
  const [traces, setTraces]       = useState<TraceEntry[]>([])
  const [tracesLoading, setTracesLoading] = useState(false)
  const [selectedTrace, setSelectedTrace] = useState<TraceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    window.api.optimizer.getCandidates().then(setCandidates).catch(console.warn)
  }, [])

  useEffect(() => {
    if (tab !== "traces" || selectedTrace) return
    setTracesLoading(true)
    window.api.optimizer.getTraces({ limit: 50 }).then(setTraces).catch(console.warn).finally(() => setTracesLoading(false))
  }, [tab, selectedTrace])

  const handleExpandTrace = useCallback(async (traceId: string) => {
    setDetailLoading(true)
    try {
      const d = await window.api.optimizer.getTraceDetail(traceId)
      if (d) setSelectedTrace(d as TraceDetail)
    } catch (e) { console.warn(e) }
    setDetailLoading(false)
  }, [])

  const handleRun = useCallback(async () => {
    setRunning(true); setSummary(null)
    try {
      const r = await window.api.optimizer.run()
      setSummary(r.summary)
      setCandidates(await window.api.optimizer.getCandidates())
    } catch (e) { setSummary(`运行失败: ${e}`) }
    setRunning(false)
  }, [])

  const handleApprove = useCallback(async (id: string) => {
    const r = await window.api.optimizer.approve(id)
    if (r.success) setCandidates(p => p.map(c => c.candidateId === id ? {...c, status:"approved"} : c))
  }, [])

  const handleReject = useCallback(async (id: string) => {
    await window.api.optimizer.reject(id)
    setCandidates(p => p.map(c => c.candidateId === id ? {...c, status:"rejected"} : c))
  }, [])

  const handleClear = useCallback(async () => {
    await window.api.optimizer.clear(); setCandidates([]); setSummary(null)
  }, [])

  const pendingCount = candidates.filter(c => c.status === "pending").length

  if (detailLoading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  )

  if (selectedTrace) return <TraceDetailView detail={selectedTrace} onClose={() => setSelectedTrace(null)} />

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-border px-4 py-3 flex items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold flex-1">技能优化 (Evolution)</span>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={handleClear} disabled={running || candidates.length === 0}>
          <Trash2 className="size-3" />清除候选
        </Button>
        <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={handleRun} disabled={running}>
          {running ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {running ? "分析中…" : "分析 Traces"}
        </Button>
      </div>

      {summary && (
        <div className="shrink-0 px-4 py-2 bg-muted/50 border-b border-border">
          <p className="text-xs text-muted-foreground">{summary}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="shrink-0 flex border-b border-border px-4">
        {(["candidates", "traces"] as Tab[]).map(t => (
          <button key={t}
            className={cn(
              "flex items-center gap-1.5 text-xs py-2 px-1 border-b-2 mr-4 transition-colors",
              tab === t ? "border-foreground text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setTab(t)}
          >
            {t === "candidates" ? <><Sparkles className="size-3.5" />优化候选{pendingCount > 0 && <span className="ml-1 inline-flex items-center justify-center size-4 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 text-[10px] font-bold">{pendingCount}</span>}</> : <><Activity className="size-3.5" />执行 Traces{tab === "traces" && traces.length > 0 && <span className="ml-1 text-[10px] text-muted-foreground">({traces.length})</span>}</>}
          </button>
        ))}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-2">
          {tab === "candidates" ? (
            candidates.length === 0
              ? <EmptyState icon={<Sparkles className="size-8 text-muted-foreground/40 mb-3" />} title="暂无优化候选" desc="点击「分析 Traces」，Agent 将分析近期执行记录并提出技能优化建议" />
              : candidates.map(c => <CandidateCard key={c.candidateId} candidate={c} onApprove={handleApprove} onReject={handleReject} />)
          ) : tracesLoading
            ? <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
            : traces.length === 0
            ? <EmptyState icon={<Activity className="size-8 text-muted-foreground/40 mb-3" />} title="暂无执行记录" desc="Traces 在每次 Agent 调用后自动记录到本地" />
            : traces.map(t => <TraceCard key={t.traceId} trace={t} onExpand={handleExpandTrace} />)
          }
        </div>
      </ScrollArea>
    </div>
  )
}

function EmptyState({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon}
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs">{desc}</p>
    </div>
  )
}
