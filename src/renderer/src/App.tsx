import { useEffect, useState, useCallback, useRef, useLayoutEffect } from "react"
import { ThreadSidebar } from "@/components/sidebar/ThreadSidebar"
import { TabbedPanel } from "@/components/tabs"
import { RightPanel } from "@/components/panels/RightPanel"
import { KanbanView } from "@/components/kanban"
import { ResizeHandle } from "@/components/ui/resizable"
import { useAppStore } from "@/lib/store"
import { ThreadProvider } from "@/lib/thread-context"

const LEFT_MIN = 180
const LEFT_MAX = 350
const LEFT_DEFAULT = 240

const RIGHT_MIN = 250
const RIGHT_MAX = 450
const RIGHT_DEFAULT = 300

function App(): React.JSX.Element {
  const { currentThreadId, loadThreads, createThread, showKanbanView } = useAppStore()
  const [isLoading, setIsLoading] = useState(true)
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT)
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT)
  const [zoomLevel, setZoomLevel] = useState(1)

  // Track drag start widths
  const dragStartWidths = useRef<{ left: number; right: number } | null>(null)

  // Track zoom level changes and update CSS custom properties for safe areas
  useLayoutEffect(() => {
    const updateZoom = (): void => {
      // Detect zoom by comparing outer/inner window dimensions
      const detectedZoom = Math.round((window.outerWidth / window.innerWidth) * 100) / 100
      if (detectedZoom > 0.5 && detectedZoom < 3) {
        setZoomLevel(detectedZoom)

        // Traffic lights are at fixed screen position (y: ~28px bottom including padding)
        // Titlebar is 36px CSS, which becomes 36*zoom screen pixels
        // Extra padding needed when titlebar shrinks below traffic lights
        const TRAFFIC_LIGHT_BOTTOM_SCREEN = 40 // screen pixels to clear traffic lights
        const TITLEBAR_HEIGHT_CSS = 36
        const titlebarScreenHeight = TITLEBAR_HEIGHT_CSS * detectedZoom
        const extraPaddingScreen = Math.max(0, TRAFFIC_LIGHT_BOTTOM_SCREEN - titlebarScreenHeight)
        const extraPaddingCss = Math.round(extraPaddingScreen / detectedZoom)

        document.documentElement.style.setProperty("--sidebar-safe-padding", `${extraPaddingCss}px`)
      }
    }

    updateZoom()
    window.addEventListener("resize", updateZoom)
    return () => window.removeEventListener("resize", updateZoom)
  }, [])

  const leftMinWidth = LEFT_MIN

  const handleLeftResize = useCallback(
    (totalDelta: number) => {
      if (!dragStartWidths.current) {
        dragStartWidths.current = { left: leftWidth, right: 0 }
      }
      const newWidth = dragStartWidths.current.left + totalDelta
      setLeftWidth(Math.min(LEFT_MAX, Math.max(leftMinWidth, newWidth)))
    },
    [leftWidth, leftMinWidth]
  )

  const handleRightResize = useCallback(
    (totalDelta: number) => {
      if (!dragStartWidths.current) {
        dragStartWidths.current = { left: leftWidth, right: rightWidth }
      }
      const newWidth = dragStartWidths.current.right - totalDelta
      setRightWidth(Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, newWidth)))
    },
    [leftWidth, rightWidth]
  )

  // Reset drag start on mouse up
  useEffect(() => {
    const handleMouseUp = (): void => {
      dragStartWidths.current = null
    }
    document.addEventListener("mouseup", handleMouseUp)
    return () => document.removeEventListener("mouseup", handleMouseUp)
  }, [])

  useEffect(() => {
    async function init(): Promise<void> {
      try {
        await loadThreads()
        // Create a default thread if none exist
        const threads = useAppStore.getState().threads
        if (threads.length === 0) {
          await createThread()
        }
      } catch (error) {
        console.error("Failed to initialize:", error)
      } finally {
        setIsLoading(false)
      }
    }
    init()
  }, [loadThreads, createThread])

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground">Initializing...</div>
      </div>
    )
  }

  return (
    <ThreadProvider>
      <div className="flex flex-col h-screen overflow-hidden bg-background">
        {/* Titlebar - spans full width */}
        <div className="flex h-9 w-full shrink-0 app-drag-region items-center justify-center border-b border-border">
          <span
            className="app-badge-name"
            style={{
              transform: `scale(${1 / zoomLevel})`,
              transformOrigin: "center center"
            }}
          >
            Cmb Cowork
          </span>
        </div>

        {/* Main content below titlebar */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left Sidebar */}
          <div style={{ width: leftWidth }} className="shrink-0">
            <ThreadSidebar />
          </div>

          <ResizeHandle onDrag={handleLeftResize} />

          {showKanbanView ? (
            <main className="flex flex-1 flex-col min-w-0 overflow-hidden">
              <KanbanView />
            </main>
          ) : (
            <>
              {/* Center - Content Panel */}
              <main className="flex flex-1 flex-col min-w-0 overflow-hidden">
                {currentThreadId ? (
                  <TabbedPanel threadId={currentThreadId} showTabBar={false} />
                ) : (
                  <div className="flex flex-1 items-center justify-center text-muted-foreground">
                    选择或创建一个任务开始
                  </div>
                )}
              </main>
            </>
          )}

          {!showKanbanView && (
            <>
              <ResizeHandle onDrag={handleRightResize} />
              {/* Right Panel - floating style */}
              <div style={{ width: rightWidth }} className="shrink-0 p-2 pl-0">
                <RightPanel />
              </div>
            </>
          )}
        </div>
      </div>
    </ThreadProvider>
  )
}

export default App
