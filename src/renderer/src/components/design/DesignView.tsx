import React, { useState, useRef, useCallback, useEffect } from "react"
import { v4 as uuid } from "uuid"

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface ChatTab {
  id: string
  label: string
}

interface Message {
  role: "user" | "assistant" | "questions-prompt"
  content: string
  tags?: string[]           // pill tags shown after question phase for user message
  isStreaming?: boolean
}

interface QuestionDef {
  id: string
  type: "text" | "textarea" | "chips"
  label: string
  hint?: string
  options?: string[]
}

type RightPanelTab = "design" | "questions"
type GenerationState = "idle" | "asking" | "questions_ready" | "generating" | "done" | "error"

interface TabState {
  messages: Message[]
  html: string
  generationState: GenerationState
  questions: QuestionDef[]
  answers: Record<string, string>
  originalPrompt: string
  rightTab: RightPanelTab
}

function makeTabState(): TabState {
  return {
    messages: [],
    html: "",
    generationState: "idle",
    questions: [],
    answers: {},
    originalPrompt: "",
    rightTab: "design",
  }
}

let tabCounter = 1

// ─────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────

export function DesignView(): React.JSX.Element {
  const [chatTabs, setChatTabs]       = useState<ChatTab[]>([{ id: "chat-1", label: "Chat" }])
  const [activeTabId, setActiveTabId] = useState("chat-1")
  const [tabStates, setTabStates]     = useState<Record<string, TabState>>({ "chat-1": makeTabState() })
  const [inputValue, setInputValue]   = useState("")

  const cancelRef = useRef<(() => void) | null>(null)

  const ts = tabStates[activeTabId] ?? makeTabState()

  // ── helpers ──────────────────────────────────────────────

  const updateTs = useCallback((tabId: string, patch: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => {
    setTabStates((prev) => {
      const current = prev[tabId] ?? makeTabState()
      const updates = typeof patch === "function" ? patch(current) : patch
      return { ...prev, [tabId]: { ...current, ...updates } }
    })
  }, [])

  // ── Tab management ────────────────────────────────────────

  function addTab() {
    tabCounter += 1
    const id = `chat-${tabCounter}`
    setChatTabs((prev) => [...prev, { id, label: "Chat" }])
    setTabStates((prev) => ({ ...prev, [id]: makeTabState() }))
    setActiveTabId(id)
  }

  function closeTab(id: string) {
    setChatTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeTabId === id && next.length > 0) setActiveTabId(next[next.length - 1].id)
      return next
    })
    setTabStates((prev) => { const n = { ...prev }; delete n[id]; return n })
  }

  function switchTab(id: string) {
    setActiveTabId(id)
    // cancel any running operation for previous tab
    if (cancelRef.current) { cancelRef.current(); cancelRef.current = null }
  }

  // ── Ask Questions ─────────────────────────────────────────

  const startAskQuestions = useCallback((prompt: string, tabId: string) => {
    const sessionId = uuid()
    updateTs(tabId, { generationState: "asking", originalPrompt: prompt, rightTab: "questions", questions: [] })

    const cleanup = window.api.design.askQuestions(sessionId, prompt, (event) => {
      if (event.type === "done" && event.questions) {
        updateTs(tabId, (prev) => ({
          generationState: "questions_ready",
          questions: event.questions as QuestionDef[],
          // add "Claude has some questions →" assistant message
          messages: [
            ...prev.messages,
            { role: "questions-prompt" as const, content: "we has some questions →" },
          ],
        }))
        cancelRef.current = null
      } else if (event.type === "error") {
        updateTs(tabId, (prev) => ({
          generationState: "error",
          messages: [
            ...prev.messages,
            { role: "assistant" as const, content: `❌ ${event.error ?? "Failed to generate questions"}` },
          ],
        }))
        cancelRef.current = null
      }
    })
    cancelRef.current = cleanup
  }, [updateTs])

  // ── Generate Design ───────────────────────────────────────

  const startGeneration = useCallback((prompt: string, tabId: string) => {
    const sessionId = uuid()
    updateTs(tabId, (prev) => ({
      generationState: "generating",
      rightTab: "design",
      messages: [
        ...prev.messages,
        { role: "assistant" as const, content: "", isStreaming: true },
      ],
    }))

    const cleanup = window.api.design.generate(sessionId, prompt, (event) => {
      if (event.type === "done" && event.html) {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.role === "assistant") {
            msgs[last] = { ...msgs[last], content: "✓ Design generated", isStreaming: false }
          }
          return { generationState: "done", html: event.html!, messages: msgs }
        })
        cancelRef.current = null
      } else if (event.type === "error") {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.role === "assistant") {
            msgs[last] = { ...msgs[last], content: `❌ ${event.error ?? "Unknown error"}`, isStreaming: false }
          }
          return { generationState: "error", messages: msgs }
        })
        cancelRef.current = null
      } else if (event.type === "cancelled") {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.isStreaming) msgs[last] = { ...msgs[last], isStreaming: false }
          return { generationState: "idle", messages: msgs }
        })
        cancelRef.current = null
      }
    })
    cancelRef.current = cleanup
  }, [updateTs])

  // ── Send message ──────────────────────────────────────────

  const handleSend = useCallback(() => {
    const prompt = inputValue.trim()
    if (!prompt) return
    const state = tabStates[activeTabId]?.generationState ?? "idle"
    if (state === "asking" || state === "generating") return
    setInputValue("")

    const tabId = activeTabId
    const existing = tabStates[tabId]?.messages ?? []

    // Always add user message first
    updateTs(tabId, (prev) => ({
      messages: [...prev.messages, { role: "user" as const, content: prompt }],
    }))

    // First message → ask questions
    if (existing.length === 0) {
      startAskQuestions(prompt, tabId)
    } else {
      // Subsequent messages → generate directly
      startGeneration(prompt, tabId)
    }
  }, [inputValue, activeTabId, tabStates, updateTs, startAskQuestions, startGeneration])

  // ── Continue (submit answers) ─────────────────────────────

  const handleContinue = useCallback(() => {
    const tabId = activeTabId
    const state = tabStates[tabId]
    if (!state) return

    const { originalPrompt, answers, questions } = state

    // Build enriched prompt with answers
    const answerLines = questions
      .map((q) => {
        const val = answers[q.id]
        if (!val) return null
        return `- ${q.label}: ${val}`
      })
      .filter(Boolean)
      .join("\n")

    const enrichedPrompt = `${originalPrompt}\n\n---\nUser's answers to clarifying questions:\n${answerLines}\n\nRemember: Generate exactly 3 variations (A / B / C) within one HTML file.`

    // Build pill tags for the user message update
    const tags = questions
      .map((q) => answers[q.id])
      .filter(Boolean)
      .slice(0, 4)

    // Update the first user message to show answer tags
    updateTs(tabId, (prev) => ({
      messages: prev.messages.map((m, i) =>
        i === 0 && m.role === "user" ? { ...m, tags } : m
      ),
      answers,
    }))

    startGeneration(enrichedPrompt, tabId)
  }, [activeTabId, tabStates, updateTs, startGeneration])

  const handleCancel = useCallback(() => {
    if (cancelRef.current) { cancelRef.current(); cancelRef.current = null }
    window.api.design.cancel(activeTabId).catch(() => {})
    updateTs(activeTabId, { generationState: "idle" })
  }, [activeTabId, updateTs])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const setAnswer = useCallback((qId: string, value: string) => {
    updateTs(activeTabId, (prev) => ({ answers: { ...prev.answers, [qId]: value } }))
  }, [activeTabId, updateTs])

  const isGenerating = ts.generationState === "generating"
  const isAsking     = ts.generationState === "asking"
  const isBlocked    = isGenerating || isAsking || ts.generationState === "questions_ready"

  // ── Render ─────────────────────────────────────────────────

  return (
    <div style={S.root}>
      {/* Title Bar */}
      <div style={S.titleBar}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={S.logo}>✦</div>
          <span style={S.titleText}>design</span>
        </div>
        <button style={S.shareBtn}>Share</button>
      </div>

      <div style={S.mainContent}>
        {/* ── Left Chat Panel ── */}
        <div style={S.leftPanel}>
          {/* Tab Bar */}
          <div style={S.tabBar}>
            {chatTabs.map((tab) => (
              <TabButton
                key={tab.id}
                label={tab.label}
                active={activeTabId === tab.id}
                closable={chatTabs.length > 1}
                onClick={() => switchTab(tab.id)}
                onClose={() => closeTab(tab.id)}
              />
            ))}
            <button onClick={addTab} style={S.addTabBtn} title="New chat">+</button>
          </div>

          {/* Chat Body */}
          <div style={S.chatBody}>
            {ts.messages.length === 0 ? (
              <EmptyState onSuggestion={(s) => setInputValue(s)} />
            ) : (
              <div style={S.messageList}>
                {ts.messages.map((msg, i) => (
                  <MessageBubble key={i} message={msg} />
                ))}
                {isAsking && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", color: "#8a8a8a", fontSize: 13 }}>
                    <PulsingDot />
                    <span>Generating questions…</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bottom Input */}
          <div style={S.inputArea}>
            <div style={S.inputBox}>
              <textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Describe what you want to create..."
                rows={2}
                style={S.textarea}
                disabled={isBlocked}
              />
              <div style={S.inputToolbar}>
                <div style={{ display: "flex", gap: 4 }}>
                  <ToolbarIcon title="Settings">⚙️</ToolbarIcon>
                  <ToolbarIcon title="Attach">📎</ToolbarIcon>
                  <button style={S.importBtn}>Import</button>
                </div>
                {isGenerating ? (
                  <button onClick={handleCancel} style={S.cancelBtn}>■ Stop</button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!inputValue.trim() || isBlocked}
                    style={{
                      ...S.sendBtn,
                      background: inputValue.trim() && !isBlocked ? "#cc785c" : "#e8b9a8",
                      cursor: inputValue.trim() && !isBlocked ? "pointer" : "default",
                    }}
                  >
                    ▶ Send
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Right Canvas Panel ── */}
        <div style={S.rightPanel}>
          {/* Canvas Tab Bar */}
          <div style={S.canvasBar}>
            <button style={S.navBtn} title="Back">←</button>
            <button style={S.navBtn} title="Refresh">↻</button>

            {/* Right panel tabs */}
            <div style={{ display: "flex", gap: 0, marginLeft: 8 }}>
              <RightTabBtn
                label="Design Files"
                active={ts.rightTab === "design"}
                onClick={() => updateTs(activeTabId, { rightTab: "design" })}
              />
              {(ts.generationState === "asking" || ts.generationState === "questions_ready") && (
                <RightTabBtn
                  label="Questions"
                  active={ts.rightTab === "questions"}
                  onClick={() => updateTs(activeTabId, { rightTab: "questions" })}
                  closable
                />
              )}
            </div>

            <div style={{ flex: 1 }} />
            {ts.html && ts.rightTab === "design" && (
              <button style={S.canvasActionBtn} onClick={() => downloadHtml(ts.html)}>⬇ Export</button>
            )}
          </div>

          {/* Canvas Content */}
          <div style={S.canvas}>
            {ts.rightTab === "questions" ? (
              /* ── Questions Form ── */
              <QuestionsPanel
                questions={ts.questions}
                answers={ts.answers}
                isLoading={ts.generationState === "asking"}
                onAnswer={setAnswer}
                onContinue={handleContinue}
              />
            ) : (
              /* ── Design Preview ── */
              <>
                {isGenerating && !ts.html ? (
                  <div style={S.canvasEmpty}>
                    <div style={S.generatingRow}>
                      <PulsingDot />
                      <span style={{ fontSize: 14, color: "#8a8a8a" }}>Generating 3 variations…</span>
                    </div>
                  </div>
                ) : ts.html ? (
                  <iframe
                    srcDoc={ts.html}
                    style={S.iframe}
                    sandbox="allow-scripts allow-same-origin"
                    title="Design Preview"
                  />
                ) : (
                  <div style={S.canvasEmpty}>
                    <p style={S.canvasEmptyText}>Creations will appear here</p>
                    <button style={S.startSketchBtn}>✏️ Start with a sketch</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Questions Panel — rendered in right canvas
// ─────────────────────────────────────────────────────────

function QuestionsPanel({
  questions,
  answers,
  isLoading,
  onAnswer,
  onContinue,
}: {
  questions: QuestionDef[]
  answers: Record<string, string>
  isLoading: boolean
  onAnswer: (id: string, value: string) => void
  onContinue: () => void
}) {
  const allAnswered = questions.length > 0 && questions.every((q) => {
    const v = answers[q.id] ?? ""
    return v.trim().length > 0
  })

  if (isLoading) {
    return (
      <div style={{ ...S.canvasEmpty, flexDirection: "column", gap: 12 }}>
        <PulsingDot />
        <span style={{ fontSize: 14, color: "#8a8a8a" }}>Generating questions…</span>
      </div>
    )
  }

  if (questions.length === 0) {
    return (
      <div style={S.canvasEmpty}>
        <span style={{ fontSize: 14, color: "#8a8a8a" }}>No questions generated yet</span>
      </div>
    )
  }

  // Extract title from first question or use default
  const title = "告诉我更多关于这个设计"

  return (
    <div style={S.questionsContainer}>
      <div style={S.questionsInner}>
        <h2 style={S.questionsTitle}>{title}</h2>

        {questions.map((q) => (
          <div key={q.id} style={S.questionBlock}>
            <label style={S.questionLabel}>{q.label}</label>
            {q.hint && <p style={S.questionHint}>{q.hint}</p>}

            {q.type === "chips" && q.options ? (
              <div style={S.chipsRow}>
                {q.options.map((opt) => {
                  const selected = answers[q.id] === opt
                  return (
                    <button
                      key={opt}
                      onClick={() => onAnswer(q.id, opt)}
                      style={{
                        ...S.chip,
                        background: selected ? "#1a1a1a" : "#ffffff",
                        color: selected ? "#ffffff" : "#1a1a1a",
                        border: selected ? "1px solid #1a1a1a" : "1px solid #d4d2cc",
                      }}
                    >
                      {opt}
                    </button>
                  )
                })}
                <input
                  type="text"
                  placeholder="Other..."
                  value={q.options.includes(answers[q.id] ?? "") ? "" : (answers[q.id] ?? "")}
                  onChange={(e) => onAnswer(q.id, e.target.value)}
                  style={S.chipOtherInput}
                />
              </div>
            ) : q.type === "textarea" ? (
              <textarea
                value={answers[q.id] ?? ""}
                onChange={(e) => onAnswer(q.id, e.target.value)}
                placeholder="Your answer..."
                rows={3}
                style={S.questionTextarea}
              />
            ) : (
              <input
                type="text"
                value={answers[q.id] ?? ""}
                onChange={(e) => onAnswer(q.id, e.target.value)}
                placeholder="Your answer..."
                style={S.questionInput}
              />
            )}
          </div>
        ))}
      </div>

      {/* Footer with Continue */}
      <div style={S.questionsFooter}>
        <span style={{ fontSize: 13, color: "#8a8a8a" }}>
          {allAnswered ? "Ready to generate" : `${Object.values(answers).filter(v => v.trim()).length} / ${questions.length} answered`}
        </span>
        <button
          onClick={onContinue}
          disabled={!allAnswered}
          style={{
            ...S.continueBtn,
            background: allAnswered ? "#1a1a1a" : "#d4d2cc",
            cursor: allAnswered ? "pointer" : "default",
          }}
        >
          Continue →
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────

function EmptyState({ onSuggestion }: { onSuggestion: (s: string) => void }) {
  return (
    <div style={S.emptyState}>
      <h2 style={S.emptyTitle}>Start with context</h2>
      <p style={S.emptySubtitle}>Designs grounded in real context turn out better.</p>
      <div style={S.contextCards}>
        <ContextCard icon="📋" label="Design System"    onClick={() => onSuggestion("Create a design system showcase with colors, typography, and components.")} />
        <ContextCard icon="🖼️" label="Add screenshot"   onClick={() => {}} />
        <ContextCard icon="🗂️" label="Attach codebase"  onClick={() => {}} />
        <ContextCard icon="🎨" label="Drag in a Figma file" hint onClick={() => {}} />
      </div>
    </div>
  )
}

function TabButton({
  label, active, closable, onClick, onClose,
}: {
  label: string; active: boolean; closable?: boolean; onClick: () => void; onClose?: () => void
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 44, borderBottom: active ? "2px solid #1a1a1a" : "2px solid transparent", flexShrink: 0 }}>
      <button
        onClick={onClick}
        style={{ display: "flex", alignItems: "center", padding: closable ? "0 4px 0 12px" : "0 12px", height: "100%", fontSize: 13, fontWeight: active ? 600 : 400, color: active ? "#1a1a1a" : "#8a8a8a", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
      >
        {label}
      </button>
      {closable && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose?.() }}
          style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#aaa", borderRadius: 3, marginRight: 6, padding: 0 }}
        >×</button>
      )}
    </div>
  )
}

function RightTabBtn({ label, active, onClick, closable }: { label: string; active: boolean; onClick: () => void; closable?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "0 14px", height: 44,
        fontSize: 13, fontWeight: active ? 600 : 400,
        color: active ? "#1a1a1a" : "#6a6a6a",
        background: active ? "#ffffff" : "transparent",
        border: "1px solid",
        borderColor: active ? "#e0ded8" : "transparent",
        borderBottom: active ? "1px solid #ffffff" : "1px solid transparent",
        borderRadius: active ? "8px 8px 0 0" : 0,
        cursor: "pointer", fontFamily: "inherit",
        position: "relative", top: 1,
      }}
    >
      {!active && closable && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#cc785c", flexShrink: 0 }} />}
      {label}
      {closable && active && <span style={{ fontSize: 12, color: "#aaa", marginLeft: 2 }}>×</span>}
    </button>
  )
}

function ContextCard({ icon, label, hint, onClick }: { icon: string; label: string; hint?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "#ffffff", border: "1px solid #e8e6e0", borderRadius: 24, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 500, color: "#1a1a1a", textAlign: "left", width: "100%" }}
    >
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {hint && <span style={{ width: 18, height: 18, borderRadius: "50%", border: "1px solid #c0beb8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#8a8a8a", flexShrink: 0 }}>?</span>}
    </button>
  )
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user"
  const isQPrompt = message.role === "questions-prompt"

  if (isQPrompt) {
    return (
      <div style={{ margin: "6px 0 10px" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "rgba(204,120,92,0.08)", border: "1px solid rgba(204,120,92,0.25)", borderRadius: 20, fontSize: 13, color: "#cc785c", fontWeight: 500 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#cc785c", flexShrink: 0 }} />
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
        <div style={{ maxWidth: "85%", padding: "9px 13px", borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px", background: isUser ? "#1a1a1a" : "#f4f3ef", color: isUser ? "#fff" : "#1a1a1a", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {message.content || (message.isStreaming ? <span style={{ opacity: 0.4 }}>Generating…</span> : "")}
        </div>
      </div>
      {/* Pill tags for user messages after question submission */}
      {isUser && message.tags && message.tags.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {message.tags.map((tag, i) => (
            <span key={i} style={{ padding: "2px 10px", background: "rgba(204,120,92,0.1)", color: "#cc785c", borderRadius: 999, fontSize: 11, fontWeight: 500, border: "1px solid rgba(204,120,92,0.2)" }}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ToolbarIcon({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <button title={title} style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 15 }}>
      {children}
    </button>
  )
}

function PulsingDot() {
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#cc785c", flexShrink: 0, animation: "pulse 1.2s ease-in-out infinite" }} />
}

// ─────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────

function downloadHtml(html: string) {
  const blob = new Blob([html], { type: "text/html" })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement("a")
  a.href = url; a.download = "design.html"; a.click()
  URL.revokeObjectURL(url)
}

// ─────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  root:              { display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: "#f0efeb" },
  titleBar:          { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", height: 48, background: "#f0efeb", flexShrink: 0 },
  logo:              { width: 28, height: 28, borderRadius: "50%", background: "#cc785c", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 14 },
  titleText:         { fontSize: 15, fontWeight: 500, color: "#1a1a1a" },
  shareBtn:          { padding: "6px 16px", fontSize: 13, fontWeight: 600, background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer" },
  mainContent:       { display: "flex", flex: 1, overflow: "hidden" },

  // Left panel
  leftPanel:         { width: 420, flexShrink: 0, display: "flex", flexDirection: "column", background: "#ffffff", borderRight: "1px solid #e8e6e0" },
  tabBar:            { display: "flex", alignItems: "center", padding: "0 8px 0 16px", borderBottom: "1px solid #e8e6e0", height: 44, overflowX: "auto" },
  addTabBtn:         { width: 28, height: 28, border: "none", background: "none", cursor: "pointer", fontSize: 18, color: "#8a8a8a", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4, flexShrink: 0, marginLeft: 4 },
  chatBody:          { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" },
  emptyState:        { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 24px", flex: 1 },
  emptyTitle:        { fontSize: 22, fontWeight: 600, color: "#1a1a1a", margin: "0 0 8px" },
  emptySubtitle:     { fontSize: 14, color: "#8a8a8a", margin: 0 },
  contextCards:      { display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 300, marginTop: 24 },
  messageList:       { flex: 1, overflowY: "auto", padding: "16px" },
  inputArea:         { padding: "12px 16px 16px", borderTop: "1px solid #e8e6e0", flexShrink: 0 },
  inputBox:          { border: "1px solid #e0ded8", borderRadius: 12, background: "#fafaf8", padding: "10px 12px" },
  textarea:          { width: "100%", border: "none", background: "transparent", resize: "none", fontSize: 14, color: "#1a1a1a", outline: "none", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" as const },
  inputToolbar:      { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  importBtn:         { padding: "4px 10px", fontSize: 12, fontWeight: 500, background: "none", border: "1px solid #d0cec8", borderRadius: 6, cursor: "pointer", color: "#4a4a4a", fontFamily: "inherit" },
  sendBtn:           { padding: "6px 16px", fontSize: 13, fontWeight: 600, color: "#fff", border: "none", borderRadius: 8, fontFamily: "inherit", transition: "background 0.15s" },
  cancelBtn:         { padding: "6px 16px", fontSize: 13, fontWeight: 600, background: "#e8e6e0", color: "#4a4a4a", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit" },

  // Right panel
  rightPanel:        { flex: 1, display: "flex", flexDirection: "column", background: "#f0efeb", overflow: "hidden" },
  canvasBar:         { display: "flex", alignItems: "center", padding: "0 12px", height: 45, background: "#f0efeb", borderBottom: "1px solid #e0ded8", flexShrink: 0, gap: 4 },
  navBtn:            { width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "#ffffff", border: "1px solid #d0cec8", borderRadius: 8, cursor: "pointer", fontSize: 14, color: "#4a4a4a", flexShrink: 0 },
  canvasActionBtn:   { display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", fontSize: 13, fontWeight: 500, background: "none", border: "1px solid #d0cec8", borderRadius: 8, cursor: "pointer", color: "#1a1a1a", fontFamily: "inherit" },
  canvas:            { flex: 1, position: "relative" as const, overflow: "hidden" },
  iframe:            { width: "100%", height: "100%", border: "none" },
  canvasEmpty:       { position: "absolute" as const, inset: 0, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", backgroundImage: "radial-gradient(circle, #c8c6c0 1px, transparent 1px)", backgroundSize: "24px 24px" },
  canvasEmptyText:   { fontSize: 18, color: "#8a8a8a", marginBottom: 20, fontWeight: 400 },
  startSketchBtn:    { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 20px", fontSize: 14, fontWeight: 500, background: "#ffffff", border: "1px solid #d0cec8", borderRadius: 10, cursor: "pointer", color: "#1a1a1a", fontFamily: "inherit", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" },
  generatingRow:     { display: "flex", alignItems: "center", gap: 10 },

  // Questions panel
  questionsContainer:{ display: "flex", flexDirection: "column" as const, height: "100%", background: "#f5f4f0" },
  questionsInner:    { flex: 1, overflowY: "auto" as const, padding: "40px 48px 24px" },
  questionsTitle:    { fontSize: 26, fontWeight: 600, color: "#1a1a1a", margin: "0 0 32px", lineHeight: 1.2 },
  questionBlock:     { marginBottom: 28 },
  questionLabel:     { display: "block", fontSize: 15, fontWeight: 600, color: "#1a1a1a", marginBottom: 6 },
  questionHint:      { fontSize: 13, color: "#8a8a8a", margin: "0 0 10px" },
  chipsRow:          { display: "flex", flexWrap: "wrap" as const, gap: 8 },
  chip:              { padding: "7px 16px", fontSize: 13, fontWeight: 500, borderRadius: 999, cursor: "pointer", fontFamily: "inherit", transition: "all 0.12s ease", whiteSpace: "nowrap" as const },
  chipOtherInput:    { padding: "6px 14px", fontSize: 13, border: "1px solid #d4d2cc", borderRadius: 999, background: "#ffffff", outline: "none", fontFamily: "inherit", color: "#1a1a1a", minWidth: 100 },
  questionInput:     { width: "100%", padding: "10px 14px", fontSize: 14, border: "1px solid #d4d2cc", borderRadius: 10, background: "#ffffff", outline: "none", fontFamily: "inherit", color: "#1a1a1a", boxSizing: "border-box" as const },
  questionTextarea:  { width: "100%", padding: "10px 14px", fontSize: 14, border: "1px solid #d4d2cc", borderRadius: 10, background: "#ffffff", outline: "none", fontFamily: "inherit", color: "#1a1a1a", resize: "vertical" as const, lineHeight: 1.5, boxSizing: "border-box" as const },
  questionsFooter:   { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 48px", borderTop: "1px solid #e0ded8", background: "#f0efeb", flexShrink: 0 },
  continueBtn:       { padding: "10px 28px", fontSize: 14, fontWeight: 600, color: "#ffffff", border: "none", borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s" },
}
