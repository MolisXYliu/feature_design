import { Activity, Users, Clock, ArrowDownToLine, ArrowUpFromLine } from "lucide-react"
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts"
import type { OverviewData } from "../use-dashboard"

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  color: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className={`flex size-9 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-4 text-white" />
      </div>
      <div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="text-lg font-bold text-foreground leading-tight">{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

function formatTime(timeStr: string): string {
  const d = new Date(timeStr)
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, "0")
  const mo = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  // If includes day info
  if (h === 0 && m === "00") return `${mo}-${day}`
  return `${h}:${m}`
}

export function OverviewPanel({
  data,
  loading
}: {
  data: OverviewData | null
  loading: boolean
}) {
  if (loading && !data) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }
  if (!data) return null

  const trendData = data.trend.map((t) => ({
    ...t,
    time: formatTime(t.time)
  }))

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-5 gap-3">
        <StatCard
          icon={Activity}
          label="调用总次数"
          value={formatNumber(data.totalCalls)}
          color="bg-blue-500"
        />
        <StatCard
          icon={Users}
          label="活跃用户数"
          value={String(data.activeUsers)}
          color="bg-violet-500"
        />
        <StatCard
          icon={Clock}
          label="平均耗时"
          value={formatDuration(data.avgDurationMs)}
          color="bg-amber-500"
        />
        <StatCard
          icon={ArrowDownToLine}
          label="输入 Token"
          value={formatNumber(data.inputTokens)}
          color="bg-sky-500"
        />
        <StatCard
          icon={ArrowUpFromLine}
          label="输出 Token"
          value={formatNumber(data.outputTokens)}
          color="bg-rose-500"
        />
      </div>

      {/* Trend chart */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-xs font-medium text-muted-foreground mb-3">调用量趋势</h3>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={{ stroke: "var(--color-border)" }}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={{ stroke: "var(--color-border)" }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              type="monotone"
              dataKey="count"
              name="调用次数"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
            <Line
              type="monotone"
              dataKey="users"
              name="活跃用户"
              stroke="#8b5cf6"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
