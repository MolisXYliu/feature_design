import { useState } from "react"
import { ArrowLeft, Brain, Clock, HeartPulse, Plug, Puzzle, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { SkillsPanel } from "./SkillsPanel"
import { McpPanel } from "./McpPanel"
import { ScheduledPanel } from "./ScheduledPanel"
import { MemoryPanel } from "./MemoryPanel"
import { HeartbeatPanel } from "./HeartbeatPanel"

type CustomizeTab = "skills" | "connectors" | "plugin" | "scheduled" | "heartbeat" | "memory"

export function CustomizeView(): React.JSX.Element {
  const { setShowCustomizeView } = useAppStore()
  const [activeTab, setActiveTab] = useState<CustomizeTab>("skills")

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <div className="w-[200px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7 w-9 p-0" onClick={() => setShowCustomizeView(false)}>
            <ArrowLeft className="size-6" strokeWidth={1} />
          </Button>
          <span className="text-base font-bold">自定义</span>
        </div>
        <nav className="px-3 space-y-0.5">
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "skills" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("skills")}
          >
            <Sparkles className="size-4 shrink-0" />
            Skills
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "connectors" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("connectors")}
          >
            <Plug className="size-4 shrink-0" />
            MCPs
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "plugin" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("plugin")}
          >
            <Puzzle className="size-4 shrink-0" />
            Plugins
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "scheduled" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("scheduled")}
          >
            <Clock className="size-4 shrink-0" />
            Scheduled
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "heartbeat" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("heartbeat")}
          >
            <HeartPulse className="size-4 shrink-0" />
            Heartbeat
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "memory" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("memory")}
          >
            <Brain className="size-4 shrink-0" />
            Memory
          </button>
        </nav>
      </div>

      {activeTab === "skills" ? (
        <SkillsPanel />
      ) : activeTab === "connectors" ? (
        <McpPanel />
      ) : activeTab === "scheduled" ? (
        <ScheduledPanel />
      ) : activeTab === "heartbeat" ? (
        <HeartbeatPanel />
      ) : activeTab === "memory" ? (
        <MemoryPanel />
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          <div className="text-center space-y-2">
            <Puzzle className="size-8 mx-auto opacity-40" />
            <p className="font-medium">Plugins</p>
            <p className="text-xs">功能建设中，敬请期待</p>
          </div>
        </div>
      )}
    </div>
  )
}
