import { useEffect, useRef, useState, useCallback } from "react"
import { Terminal as TerminalIcon, RotateCcw, Square, FolderOpen, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import "@xterm/xterm/css/xterm.css"

interface Session {
  id: string
  termId: string | null
  xterm: Terminal
  fitAddon: FitAddon
  container: HTMLDivElement
  running: boolean
  workDir: string
  claudeModelId?: string
  // #1 fix: 分离 DOM 级别的 cleanup 和 PTY/IPC 级别的 cleanup
  domCleanups: Array<() => void>
  ptyCleanups: Array<() => void>
}

let sessionCounter = 0
const MAX_TRY_OPEN_ATTEMPTS = 100

// 判断是否为打包环境
const isPackaged = !window.location.hostname.includes("localhost")

function createXterm(): { xterm: Terminal; fitAddon: FitAddon } {
  const xterm = new Terminal({
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
    theme: {
      background: "#faf9f6",
      foreground: "#1a1a1a",
      cursor: "#1a1a1a",
      selectionBackground: "#d4d0c8",
      black: "#1a1a1a",
      red: "#c4261d",
      green: "#2e7d32",
      yellow: "#f57f17",
      blue: "#1565c0",
      magenta: "#7b1fa2",
      cyan: "#00838f",
      white: "#faf9f6"
    },
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true
    // #17: scrollbar: { width: 14 } 不是 xterm.js 有效选项，已移除
  })
  const fitAddon = new FitAddon()
  xterm.loadAddon(fitAddon)
  return { xterm, fitAddon }
}

export function ClaudeCodePanel(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const sessionsRef = useRef<Map<string, Session>>(new Map())
  const [sessionIds, setSessionIds] = useState<string[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [models, setModels] = useState<Array<{ id: string; name: string; model: string }>>([])
  const [selectedModelId, setSelectedModelId] = useState<string>("")

  // 加载模型列表（仅打包环境）
  useEffect(() => {
    if (!isPackaged) return
    window.api.models.getCustomConfigs().then((configs) => {
      const list = configs.map((c) => ({
        id: c.id,
        name: c.name,
        model: c.model
      }))
      setModels(list)
      if (list.length > 0) setSelectedModelId(list[0].id)
    }).catch(console.error)
  }, [])

  const getSession = useCallback((id: string) => sessionsRef.current.get(id), [])
  const pendingResizeRef = useRef(false)

  const isVisible = useCallback(() => {
    return hostRef.current !== null && hostRef.current.offsetWidth > 0
  }, [])

  // 从 xterm 内部获取 cell 尺寸
  const getCellDimensions = useCallback((xterm: Terminal) => {
    const core = (xterm as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } })._core
    const w = core?._renderService?.dimensions?.css?.cell?.width
    const h = core?._renderService?.dimensions?.css?.cell?.height
    return w && h ? { width: w, height: h } : null
  }, [])

  // 计算目标 cols/rows
  const calcDimensions = useCallback((session: Session) => {
    const { container } = session
    if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return null
    const cell = getCellDimensions(session.xterm)
    if (!cell) return null
    const scrollbarWidth = 14
    return {
      cols: Math.max(Math.floor((container.offsetWidth - scrollbarWidth) / cell.width), 1),
      rows: Math.max(Math.floor(container.offsetHeight / cell.height), 1)
    }
  }, [getCellDimensions])

  // 完整 fit（rows + cols 一起）
  const fitTerminal = useCallback((session: Session) => {
    const dims = calcDimensions(session)
    if (!dims) {
      session.fitAddon.fit()
      return
    }
    if (session.xterm.cols !== dims.cols || session.xterm.rows !== dims.rows) {
      session.xterm.resize(dims.cols, dims.rows)
    }
  }, [calcDimensions]) // #9 fix: 加上 calcDimensions 依赖

  const mountXterm = useCallback((session: Session): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!hostRef.current) { resolve(false); return }
      for (const s of sessionsRef.current.values()) {
        s.container.style.display = s.id === session.id ? "" : "none"
      }
      hostRef.current.appendChild(session.container)

      // #6 fix: RAF 可取消
      let cancelled = false
      session.domCleanups.push(() => { cancelled = true })

      let attempts = 0
      const tryOpen = (): void => {
        if (cancelled) { resolve(false); return }
        attempts++
        if (attempts > MAX_TRY_OPEN_ATTEMPTS) {
          console.warn("[ClaudeCode] tryOpen exceeded max attempts, giving up")
          resolve(false)
          return
        }
        if (session.container.offsetWidth > 0 && session.container.offsetHeight > 0) {
          // #7 fix: 防止 xterm.open 重复调用
          if (!session.xterm.element) {
            session.xterm.open(session.container)
          }
          session.fitAddon.fit()

          // 加载 WebGL，完成后刷新维度
          try {
            const webgl = new WebglAddon()
            session.xterm.loadAddon(webgl)
            webgl.onContextLoss(() => {
              console.warn("[ClaudeCode] WebGL context lost, falling back to canvas")
              webgl.dispose()
            })
          } catch (e) {
            console.warn("[ClaudeCode] WebGL addon failed, using canvas renderer:", e)
          }

          // #18 fix: 合并为一次延迟 fit
          setTimeout(() => { fitTerminal(session); resolve(true) }, 100)

          // #10 fix: ResizeObserver 绑定在 session.container 上而非 hostRef
          // 每个 session 只观察自己的 container，避免多 session 叠加 observer
          let colsTimer: ReturnType<typeof setTimeout> | null = null
          const resizeObserver = new ResizeObserver(() => {
            if (!isVisible()) {
              pendingResizeRef.current = true
              return
            }
            const dims = calcDimensions(session)
            if (!dims) return
            if (session.xterm.rows !== dims.rows) {
              session.xterm.resize(session.xterm.cols, dims.rows)
            }
            if (session.xterm.cols !== dims.cols) {
              if (colsTimer) clearTimeout(colsTimer)
              colsTimer = setTimeout(() => {
                const fresh = calcDimensions(session)
                if (fresh && session.xterm.cols !== fresh.cols) {
                  session.xterm.resize(fresh.cols, session.xterm.rows)
                }
              }, 100)
            }
          })
          resizeObserver.observe(session.container)
          // #1 fix: ResizeObserver 放到 domCleanups，startPty 不会清理它
          session.domCleanups.push(() => {
            resizeObserver.disconnect()
            if (colsTimer) clearTimeout(colsTimer)
          })
        } else {
          requestAnimationFrame(tryOpen)
        }
      }
      requestAnimationFrame(tryOpen)
    })
  }, [fitTerminal, isVisible, calcDimensions]) // #9 fix: 完整依赖

  // 清理 PTY 相关的监听器
  const cleanupPty = useCallback((session: Session) => {
    session.ptyCleanups.forEach((fn) => fn())
    session.ptyCleanups = []
  }, [])

  const startPty = useCallback(async (session: Session) => {
    if (session.termId) {
      await window.api.terminal.dispose(session.termId)
      session.termId = null
    }
    // #1 #2 fix: 只清理 PTY 相关的 cleanup，保留 DOM 级别的
    cleanupPty(session)

    const termId = await window.api.terminal.create({
      workDir: session.workDir || undefined,
      cols: session.xterm.cols,
      rows: session.xterm.rows,
      claudeModelId: session.claudeModelId
    })
    // #2 fix: 如果 await 期间 session 被关闭，dispose 新创建的 PTY
    if (!sessionsRef.current.has(session.id)) {
      window.api.terminal.dispose(termId)
      return
    }
    session.termId = termId
    session.running = true

    const removeData = window.api.terminal.onData(termId, (data, bytes) => {
      // xterm.write 接受回调，回调触发时数据才真正被消费
      session.xterm.write(data, () => {
        window.api.terminal.ack(termId, bytes)
      })
    })
    session.ptyCleanups.push(removeData)

    const removeExit = window.api.terminal.onExit(termId, (code) => {
      session.xterm.write(`\r\n\x1b[90m[进程已退出，代码: ${code}]\x1b[0m\r\n`)
      session.running = false
      setSessionIds((prev) => [...prev])
    })
    session.ptyCleanups.push(removeExit)

    const onDataDisposable = session.xterm.onData((data) => {
      if (session.termId) window.api.terminal.write(session.termId, data)
    })
    session.ptyCleanups.push(() => onDataDisposable.dispose())

    const onResizeDisposable = session.xterm.onResize(({ cols, rows }) => {
      if (session.termId) window.api.terminal.resize(session.termId, cols, rows)
    })
    session.ptyCleanups.push(() => onResizeDisposable.dispose())

    fitTerminal(session)
    setSessionIds((prev) => [...prev])
  }, [fitTerminal, cleanupPty])

  const switchSession = useCallback((id: string) => {
    setActiveSessionId(id)
    for (const s of sessionsRef.current.values()) {
      s.container.style.display = s.id === id ? "" : "none"
    }
    const session = sessionsRef.current.get(id)
    if (session) {
      requestAnimationFrame(() => {
        fitTerminal(session)
        session.xterm.focus()
      })
    }
  }, [fitTerminal])

  const createSessionWithDir = useCallback(async () => {
    // 刷新模型列表和选择目录并行发起
    const [dir, resolvedModelId] = await Promise.all([
      window.api.terminal.selectDir(),
      isPackaged ? window.api.models.getCustomConfigs().then((configs) => {
        const list = configs.map((c) => ({ id: c.id, name: c.name, model: c.model }))
        setModels(list)
        const valid = list.some((m) => m.id === selectedModelId)
        if (!valid) {
          const fallback = list.length > 0 ? list[0].id : ""
          setSelectedModelId(fallback)
          return fallback
        }
        return selectedModelId
      }).catch(() => selectedModelId) : Promise.resolve(selectedModelId)
    ])
    if (!dir) return

    const id = `session-${++sessionCounter}`
    const { xterm, fitAddon } = createXterm()
    const container = document.createElement("div")
    container.style.position = "absolute"
    container.style.top = "0"
    container.style.left = "0"
    container.style.right = "0"
    container.style.bottom = "0"
    container.style.overflow = "hidden"

    const session: Session = {
      id, termId: null, xterm, fitAddon, container,
      running: false, workDir: dir, claudeModelId: resolvedModelId || undefined, domCleanups: [], ptyCleanups: []
    }

    sessionsRef.current.set(id, session)
    setSessionIds((prev) => [...prev, id])
    setActiveSessionId(id)

    // P3 fix: 用 cancelled flag 防止组件卸载后仍创建 PTY
    let cancelled = false
    session.domCleanups.push(() => { cancelled = true })

    // 等 React 渲染完毕且 hostRef 可用后再挂载
    let hostAttempts = 0
    const waitForHost = (): void => {
      if (cancelled) return
      hostAttempts++
      if (!hostRef.current) {
        if (hostAttempts > MAX_TRY_OPEN_ATTEMPTS) {
          console.warn("[ClaudeCode] hostRef never became available, cleaning up")
          session.domCleanups.forEach((fn) => fn())
          session.xterm.dispose()
          session.container.remove()
          sessionsRef.current.delete(id)
          setSessionIds((prev) => prev.filter((s) => s !== id))
          const remaining = [...sessionsRef.current.keys()]
          if (remaining.length > 0) {
            switchSession(remaining[remaining.length - 1])
          } else {
            setActiveSessionId(null)
          }
          return
        }
        requestAnimationFrame(waitForHost)
        return
      }
      mountXterm(session).then((mounted) => {
        if (cancelled || !mounted) {
          // 挂载失败：清理空会话
          if (!mounted && !cancelled) {
            session.xterm.dispose()
            session.container.remove()
            sessionsRef.current.delete(id)
            setSessionIds((prev) => prev.filter((s) => s !== id))
            // 回退到上一个会话并恢复可见性
            const remaining = [...sessionsRef.current.keys()]
            if (remaining.length > 0) {
              switchSession(remaining[remaining.length - 1])
            } else {
              setActiveSessionId(null)
            }
          }
          return
        }
        startPty(session).then(() => {
          if (!cancelled) xterm.focus()
        }).catch((err) => {
          console.error("[ClaudeCode] PTY creation failed:", err)
          session.xterm.write(`\r\n\x1b[31m[启动失败: ${err instanceof Error ? err.message : err}]\x1b[0m\r\n`)
          session.running = false
          setSessionIds((prev) => [...prev])
        })
      }).catch((err) => {
        console.error("[ClaudeCode] Terminal mount failed:", err)
      })
    }
    requestAnimationFrame(waitForHost)
  }, [mountXterm, startPty, switchSession, selectedModelId])

  // #16 fix: switchSession 从 setState 回调中移出
  const closeSession = useCallback(async (id: string) => {
    const session = sessionsRef.current.get(id)
    if (!session) return
    cleanupPty(session)
    session.domCleanups.forEach((fn) => fn())
    if (session.termId) await window.api.terminal.dispose(session.termId)
    session.xterm.dispose()
    session.container.remove()
    sessionsRef.current.delete(id)

    // sessionsRef 已同步删除，作为 source of truth
    setSessionIds((prev) => prev.filter((s) => s !== id))

    const remaining = [...sessionsRef.current.keys()]
    if (remaining.length === 0) {
      setActiveSessionId(null)
    } else if (activeSessionId === id) {
      // 只在关闭的是当前激活的 tab 时才切换
      const newActive = remaining[remaining.length - 1]
      requestAnimationFrame(() => switchSession(newActive))
    }
  }, [switchSession, cleanupPty, activeSessionId])

  // 组件卸载时清理所有会话
  useEffect(() => {
    return () => {
      for (const session of sessionsRef.current.values()) {
        session.ptyCleanups.forEach((fn) => fn())
        session.domCleanups.forEach((fn) => fn())
        if (session.termId) window.api.terminal.dispose(session.termId)
        session.xterm.dispose()
        session.container.remove()
      }
      sessionsRef.current.clear()
    }
  }, [])

  // 面板从隐藏变为可见时，flush 积攒的 resize
  useEffect(() => {
    if (!hostRef.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && pendingResizeRef.current) {
        pendingResizeRef.current = false
        const active = activeSessionId ? sessionsRef.current.get(activeSessionId) : null
        if (active) fitTerminal(active)
      }
    })
    observer.observe(hostRef.current)
    return () => observer.disconnect()
  }, [activeSessionId, fitTerminal])

  const activeSession = activeSessionId ? getSession(activeSessionId) : null

  const restartingRef = useRef(false)
  const handleRestart = useCallback(async () => {
    if (!activeSession || restartingRef.current) return
    restartingRef.current = true
    try {
      activeSession.xterm.clear()
      await startPty(activeSession)
    } catch (err) {
      activeSession.running = false
      activeSession.termId = null
      activeSession.xterm.write(`\r\n\x1b[31m[重启失败: ${err instanceof Error ? err.message : err}]\x1b[0m\r\n`)
      setSessionIds((prev) => [...prev]) // 刷新 UI 显示重启按钮
    } finally {
      restartingRef.current = false
    }
  }, [activeSession, startPty])

  // #3 fix: handleStop 清理 PTY 监听器
  const handleStop = useCallback(async () => {
    if (activeSession?.termId) {
      await window.api.terminal.dispose(activeSession.termId)
      activeSession.termId = null
      activeSession.running = false
      cleanupPty(activeSession)
      activeSession.xterm.write("\r\n\x1b[90m[已停止]\x1b[0m\r\n")
      setSessionIds((prev) => [...prev])
    }
  }, [activeSession, cleanupPty])

  // 没有会话时显示欢迎页
  if (sessionIds.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <div className="flex flex-col items-center gap-3">
          <div className="size-16 rounded-2xl bg-muted/60 flex items-center justify-center">
            <TerminalIcon className="size-8 text-muted-foreground/60" />
          </div>
          <h3 className="text-lg font-semibold text-foreground/80">Claude Code</h3>
          <p className="text-sm text-muted-foreground text-center leading-relaxed">
            点击下方按钮选择项目目录，Claude Code 将在该目录下启动。<br />
            你可以通过顶部 Tab 栏新建多个会话，每个会话对应不同的项目目录。
          </p>
        </div>
        {isPackaged && models.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">模型：</span>
            <select
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value)}
              className="h-8 px-2 rounded-md border border-border bg-background text-sm"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}
        <Button onClick={createSessionWithDir} className="gap-2">
          <FolderOpen className="size-4" />
          选择工作目录并启动
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-4 text-primary" />
          <h2 className="text-sm font-bold">Claude Code</h2>
        </div>
        <div className="flex items-center gap-1">
          {activeSession && (
            <span className="text-[11px] text-muted-foreground mr-1">
              {activeSession.workDir.split(/[\\/]/).pop() || activeSession.workDir}
            </span>
          )}
          {activeSession?.running ? (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleStop} title="停止">
              <Square className="size-3.5" />
            </Button>
          ) : activeSession ? (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleRestart} title="重启">
              <RotateCcw className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* 会话 Tab 栏 */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border bg-muted/30 overflow-x-auto">
        {sessionIds.map((id, i) => {
          const s = getSession(id)
          return (
            <div
              key={id}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded text-xs cursor-pointer transition-colors group",
                id === activeSessionId
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
              onClick={() => switchSession(id)}
            >
              <span className={cn("size-1.5 rounded-full", s?.running ? "bg-green-500" : "bg-muted-foreground/40")} />
              <span>{s?.workDir.split(/[\\/]/).pop() || `会话 ${i + 1}`}</span>
              <button
                className="size-3.5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted"
                onClick={(e) => { e.stopPropagation(); closeSession(id) }}
              >
                <X className="size-2.5" />
              </button>
            </div>
          )
        })}
        <button
          className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50"
          onClick={createSessionWithDir}
          title="新建会话"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {/* 终端容器 */}
      <div ref={hostRef} className="flex-1 min-h-0 overflow-hidden" style={{ position: "relative", backgroundColor: "#faf9f6" }} />
    </div>
  )
}
