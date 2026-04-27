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
  isIteration?: boolean     // true = follow-up iteration, false = first generation
}

interface QuestionDef {
  id: string
  type: "text" | "textarea" | "chips"
  label: string
  hint?: string
  options?: string[]
  multi?: boolean   // chips: allow multiple selections
}

type RightPanelTab = "design" | "questions"
type GenerationState = "idle" | "asking" | "questions_ready" | "generating" | "done" | "error"

type AnswerValue = string | string[]

interface VariationItem {
  id: string          // 'a' | 'b' | 'c'
  label: string       // 'Variation A' etc.
  html: string        // standalone full HTML for this variant
}

interface CommentItem {
  id: string
  // Stored as absolute positions in the iframe's document coordinate space (pixels).
  // These are pageX/pageY from the click event — viewport-relative + scroll offset.
  pageX: number
  pageY: number
  text: string
  elementDesc: string
  createdAt: number
}

interface TabState {
  messages: Message[]
  html: string
  generationState: GenerationState
  questions: QuestionDef[]
  answers: Record<string, AnswerValue>
  originalPrompt: string
  rightTab: RightPanelTab
  variations: VariationItem[]
  activeVariationId: string | null  // null = show full html; 'a'|'b'|'c' = show that variant
  // Per-tab canvas controls
  tweaksOn: boolean
  activeMode: "comment" | "edit" | "draw" | null
  zoom: number
  // Per-tab input
  inputValue: string
  // Per-tab comments
  comments: CommentItem[]
  // draftComment uses pageX/pageY (document coords) same as CommentItem
  draftComment: { pageX: number; pageY: number; elementDesc: string } | null
  activeCommentId: string | null
  // Iframe scroll position — updated continuously via __iframe_scroll postMessage
  iframeScrollX: number
  iframeScrollY: number
  // Edit mode
  editModeAvailable: boolean   // set true when iframe posts __edit_mode_available
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
    variations: [],
    activeVariationId: null,
    tweaksOn: false,
    activeMode: null,
    zoom: 100,
    inputValue: "",
    comments: [],
    draftComment: null,
    activeCommentId: null,
    iframeScrollX: 0,
    iframeScrollY: 0,
    editModeAvailable: false,
  }
}

// ─────────────────────────────────────────────────────────
// Parse A/B/C variations from a full HTML string
// Looks for elements with id="variation-a/b/c"
// ─────────────────────────────────────────────────────────
function parseVariations(fullHtml: string): VariationItem[] {
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(fullHtml, "text/html")
    const headHtml = doc.head.innerHTML

    return (["a", "b", "c"] as const).reduce<VariationItem[]>((acc, id) => {
      const el = doc.getElementById(`variation-${id}`)
      if (!el) return acc

      // Read descriptive label from data-label attribute; fall back to generic
      const dataLabel = el.getAttribute("data-label")?.trim()
      const label = dataLabel || `方案 ${id.toUpperCase()}`

      // Wrap variation in a self-contained HTML doc, inherit shared head (fonts, styles)
      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${headHtml}
<style>html,body{margin:0;padding:0;min-height:100vh;}</style>
</head>
<body>
${el.outerHTML}
</body>
</html>`

      acc.push({ id, label, html })
      return acc
    }, [])
  } catch {
    return []
  }
}

let tabCounter = 1

const VARIATION_COLORS: Record<string, string> = {
  a: "#3b82f6",
  b: "#8b5cf6",
  c: "#f59e0b",
}

// ─────────────────────────────────────────────────────────
// Scroll tracker — always injected on iframe load.
// Sends the iframe's scroll position to the parent whenever it changes.
// This is separate from comment mode so pins stay aligned even if
// the user scrolls before/after entering comment mode.
// ─────────────────────────────────────────────────────────

const SCROLL_INJECT = `(function(){
  if(window.__st_active)return;
  window.__st_active=true;
  function report(){
    window.parent.postMessage({type:'__iframe_scroll',x:window.scrollX,y:window.scrollY},'*');
  }
  window.addEventListener('scroll',report,{passive:true});
  report();
  window.__st_cleanup=function(){
    window.removeEventListener('scroll',report);
    window.__st_active=false;delete window.__st_cleanup;
  };
})();`

const SCROLL_CLEANUP = `(function(){if(window.__st_cleanup)window.__st_cleanup();})();`

// ─────────────────────────────────────────────────────────
// Comment mode injection script (runs inside the iframe)
// ─────────────────────────────────────────────────────────

const COMMENT_INJECT = `(function(){
  if(window.__cm_active)return;
  window.__cm_active=true;
  var sty=document.createElement('style');
  sty.id='__cm_sty';
  sty.textContent='.__cm_h{outline:2px solid rgba(245,158,11,0.7)!important;outline-offset:1px!important;cursor:crosshair!important;transition:outline 0.08s;}';
  document.head.appendChild(sty);
  var hov=null;
  function over(e){
    if(hov)hov.classList.remove('__cm_h');
    var t=e.target;
    if(t&&t!==document.body&&t!==document.documentElement){hov=t;t.classList.add('__cm_h');}
  }
  function out(){if(hov){hov.classList.remove('__cm_h');hov=null;}}
  function label(t){
    if(t.id)return'#'+t.id;
    var tag=t.tagName.toLowerCase();
    var cls=Array.from(t.classList).filter(function(c){return!c.startsWith('__cm')}).slice(0,2).join('.');
    var txt=(t.textContent||'').trim().replace(/\\s+/g,' ').slice(0,28);
    return tag+(cls?'.'+cls:'')+(txt?' \\''+txt+'\\'':'');
  }
  function click(e){
    e.preventDefault();e.stopPropagation();
    // Use pageX/pageY (= clientX + scrollX) so coordinates are document-absolute,
    // not viewport-relative. This lets pins stay anchored to the content regardless
    // of the current scroll position.
    window.parent.postMessage({
      type:'__comment_click',
      pageX:e.pageX,pageY:e.pageY,
      winW:window.innerWidth,winH:window.innerHeight,
      elementDesc:label(e.target)
    },'*');
  }
  document.addEventListener('mouseover',over,true);
  document.addEventListener('mouseout',out,true);
  document.addEventListener('click',click,true);
  window.__cm_cleanup=function(){
    document.removeEventListener('mouseover',over,true);
    document.removeEventListener('mouseout',out,true);
    document.removeEventListener('click',click,true);
    var s=document.getElementById('__cm_sty');if(s)s.remove();
    if(hov)hov.classList.remove('__cm_h');
    window.__cm_active=false;delete window.__cm_cleanup;
  };
})();`

const COMMENT_CLEANUP = `(function(){if(window.__cm_cleanup)window.__cm_cleanup();})();`

// Merge edits into the /*EDITMODE-BEGIN*/.../*EDITMODE-END*/ JSON block in an HTML string
function mergeEditModeKeys(html: string, edits: Record<string, unknown>): string {
  return html.replace(
    /\/\*EDITMODE-BEGIN\*\/([\s\S]*?)\/\*EDITMODE-END\*\//,
    (_, existing) => {
      try {
        const current = JSON.parse(existing.trim()) as Record<string, unknown>
        const merged = { ...current, ...edits }
        return `/*EDITMODE-BEGIN*/${JSON.stringify(merged)}/*EDITMODE-END*/`
      } catch {
        return `/*EDITMODE-BEGIN*/${existing}/*EDITMODE-END*/`
      }
    }
  )
}

// Send a postMessage into the iframe
function sendToIframe(iframe: HTMLIFrameElement | null, msg: object) {
  iframe?.contentWindow?.postMessage(msg, "*")
}

function injectIntoIframe(iframe: HTMLIFrameElement | null, script: string) {
  try {
    const doc = iframe?.contentDocument
    if (!doc) return
    const s = doc.createElement("script")
    s.textContent = script
    doc.head.appendChild(s)
    s.remove() // self-remove; the code already ran
  } catch { /* cross-origin or not yet loaded */ }
}

// ─────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────

export function DesignView(): React.JSX.Element {
  const [chatTabs, setChatTabs]       = useState<ChatTab[]>([{ id: "chat-1", label: "Chat" }])
  const [activeTabId, setActiveTabId] = useState("chat-1")
  const [tabStates, setTabStates]     = useState<Record<string, TabState>>({ "chat-1": makeTabState() })

  // Per-tab session tracking: tabId → { cleanup, sessionId }
  // Stored in a ref so it never triggers re-renders and isn't stale across tabs
  const tabSessionsRef = useRef<Map<string, { cleanup: () => void; sessionId: string }>>(new Map())

  // Canvas refs
  const iframeRef         = useRef<HTMLIFrameElement>(null)
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const activeTabIdRef    = useRef(activeTabId)

  const ts = tabStates[activeTabId] ?? makeTabState()

  // ── Per-tab derived values (all read from ts) ────────────────
  const inputValue = ts.inputValue
  const tweaksOn   = ts.tweaksOn
  const activeMode = ts.activeMode
  const zoom       = ts.zoom

  const setInputValue = (val: string) => updateTs(activeTabId, { inputValue: val })
  const setTweaksOn   = (val: boolean | ((v: boolean) => boolean)) =>
    updateTs(activeTabId, (prev) => ({ tweaksOn: typeof val === "function" ? val(prev.tweaksOn) : val }))
  const setActiveMode = (val: "comment" | "edit" | "draw" | null) =>
    updateTs(activeTabId, { activeMode: val })
  const setZoom = (val: number | ((v: number) => number)) =>
    updateTs(activeTabId, (prev) => ({ zoom: typeof val === "function" ? val(prev.zoom) : val }))

  // ── helpers ──────────────────────────────────────────────

  const updateTs = useCallback((tabId: string, patch: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => {
    setTabStates((prev) => {
      const current = prev[tabId] ?? makeTabState()
      const updates = typeof patch === "function" ? patch(current) : patch
      return { ...prev, [tabId]: { ...current, ...updates } }
    })
  }, [])

  // ── Keep activeTabIdRef in sync ───────────────────────────
  useEffect(() => { activeTabIdRef.current = activeTabId }, [activeTabId])

  // ── Inject / remove comment script when mode changes ─────
  useEffect(() => {
    if (activeMode === "comment") {
      injectIntoIframe(iframeRef.current, COMMENT_INJECT)
    } else {
      injectIntoIframe(iframeRef.current, COMMENT_CLEANUP)
    }
  }, [activeMode])

  // ── Send edit mode postMessages when mode changes ─────────
  useEffect(() => {
    if (activeMode === "edit") {
      sendToIframe(iframeRef.current, { type: "__activate_edit_mode" })
    } else {
      // Deactivate edit mode whenever we leave it (switching to comment/draw/null)
      sendToIframe(iframeRef.current, { type: "__deactivate_edit_mode" })
    }
  }, [activeMode])

  // ── Listen for all postMessages from iframe ───────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data
      if (!msg?.type) return

      // ── Iframe scroll position update ─────────────────────
      if (msg.type === "__iframe_scroll") {
        const { x, y } = msg as { x: number; y: number }
        updateTs(activeTabIdRef.current, { iframeScrollX: x, iframeScrollY: y })
        return
      }

      // ── Comment click ──────────────────────────────────────
      if (msg.type === "__comment_click") {
        const { pageX, pageY, elementDesc } = msg as {
          pageX: number; pageY: number; elementDesc: string
        }
        updateTs(activeTabIdRef.current, {
          draftComment: { pageX, pageY, elementDesc: elementDesc || "元素" },
          activeCommentId: null,
        })
        return
      }

      // ── Edit mode: iframe announces it has a Tweaks panel ──
      if (msg.type === "__edit_mode_available") {
        updateTs(activeTabIdRef.current, { editModeAvailable: true })
        // If we're already in edit mode (e.g. iframe just reloaded), immediately activate
        // Read current activeMode from the tab state via the ref
        setTabStates((prev) => {
          const tabId = activeTabIdRef.current
          const state = prev[tabId]
          if (state?.activeMode === "edit") {
            // Send activation — but we can't call sendToIframe here (side-effect in setState)
            // Instead, schedule it as a microtask
            Promise.resolve().then(() => sendToIframe(iframeRef.current, { type: "__activate_edit_mode" }))
          }
          return prev  // no state change needed
        })
        return
      }

      // ── Edit mode: user changed a value in the Tweaks panel ─
      if (msg.type === "__edit_mode_set_keys") {
        const edits = msg.edits as Record<string, unknown>
        const tabId = activeTabIdRef.current
        setTabStates((prev) => {
          const state = prev[tabId]
          if (!state) return prev
          // Merge edits into the EDITMODE-BEGIN block of the active HTML
          const targetHtml = state.activeVariationId
            ? (state.variations.find((v) => v.id === state.activeVariationId)?.html ?? state.html)
            : state.html
          const updated = mergeEditModeKeys(targetHtml, edits)
          if (state.activeVariationId) {
            // Update the specific variation's html
            return {
              ...prev,
              [tabId]: {
                ...state,
                variations: state.variations.map((v) =>
                  v.id === state.activeVariationId ? { ...v, html: updated } : v
                ),
              },
            }
          }
          return { ...prev, [tabId]: { ...state, html: updated } }
        })
        return
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [updateTs])

  // ── Tab management ────────────────────────────────────────

  function addTab() {
    tabCounter += 1
    const id = `chat-${tabCounter}`
    setChatTabs((prev) => [...prev, { id, label: "Chat" }])
    setTabStates((prev) => ({ ...prev, [id]: makeTabState() }))
    setActiveTabId(id)
  }

  function closeTab(id: string) {
    // Cancel any running session for the closed tab
    const entry = tabSessionsRef.current.get(id)
    if (entry) {
      entry.cleanup()
      window.api.design.cancel(entry.sessionId).catch(() => {})
      tabSessionsRef.current.delete(id)
    }
    setChatTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeTabId === id && next.length > 0) setActiveTabId(next[next.length - 1].id)
      return next
    })
    setTabStates((prev) => { const n = { ...prev }; delete n[id]; return n })
  }

  function switchTab(id: string) {
    // Each tab runs independently — do NOT cancel the previous tab's session
    setActiveTabId(id)
  }

  // ── Ask Questions ─────────────────────────────────────────

  const startAskQuestions = useCallback((prompt: string, tabId: string) => {
    const sessionId = uuid()
    updateTs(tabId, { generationState: "asking", originalPrompt: prompt, rightTab: "questions", questions: [] })

    // Cancel any existing session for this tab before starting a new one
    const existing = tabSessionsRef.current.get(tabId)
    if (existing) { existing.cleanup(); window.api.design.cancel(existing.sessionId).catch(() => {}) }

    const cleanup = window.api.design.askQuestions(sessionId, prompt, (event) => {
      if (event.type === "done" && event.questions) {
        updateTs(tabId, (prev) => ({
          generationState: "questions_ready",
          questions: event.questions as QuestionDef[],
          messages: [
            ...prev.messages,
            { role: "questions-prompt" as const, content: "we has some questions →" },
          ],
        }))
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "error") {
        updateTs(tabId, (prev) => ({
          generationState: "error",
          messages: [
            ...prev.messages,
            { role: "assistant" as const, content: `❌ ${event.error ?? "Failed to generate questions"}` },
          ],
        }))
        tabSessionsRef.current.delete(tabId)
      }
    })
    tabSessionsRef.current.set(tabId, { cleanup, sessionId })
  }, [updateTs])

  // ── Generate Design ───────────────────────────────────────

  const startGeneration = useCallback((prompt: string, tabId: string, isIteration = false) => {
    const sessionId = uuid()
    updateTs(tabId, (prev) => ({
      generationState: "generating",
      rightTab: "design",
      messages: [
        ...prev.messages,
        {
          role: "assistant" as const,
          content: "",
          isStreaming: true,
          isIteration,
        },
      ],
    }))

    // Cancel any existing session for this tab before starting a new one
    const existing = tabSessionsRef.current.get(tabId)
    if (existing) { existing.cleanup(); window.api.design.cancel(existing.sessionId).catch(() => {}) }

    const cleanup = window.api.design.generate(sessionId, prompt, (event) => {
      if (event.type === "done" && event.html) {
        const variations = parseVariations(event.html)

        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.role === "assistant") {
            const doneLabel = variations.length > 0
              ? `✓ ${isIteration ? "Design updated" : "Design generated"} — ${variations.length} variations`
              : isIteration ? "✓ Design updated" : "✓ Design generated"
            msgs[last] = { ...msgs[last], content: doneLabel, isStreaming: false }
          }
          return {
            generationState: "done",
            html: event.html!,
            messages: msgs,
            variations,
            activeVariationId: variations[0]?.id ?? null,
          }
        })

        if (variations.length > 0) {
          variations.forEach((v) => { window.api.design.saveVariant(v.id, v.html).catch(() => {}) })
        }
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "error") {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.role === "assistant") {
            msgs[last] = { ...msgs[last], content: `❌ ${event.error ?? "Unknown error"}`, isStreaming: false }
          }
          return { generationState: "error", messages: msgs }
        })
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "cancelled") {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.isStreaming) msgs[last] = { ...msgs[last], isStreaming: false }
          return { generationState: "idle", messages: msgs }
        })
        tabSessionsRef.current.delete(tabId)
      }
    })
    tabSessionsRef.current.set(tabId, { cleanup, sessionId })
  }, [updateTs])

  // ── Build comment prompt helper ───────────────────────────
  const buildCommentPrompt = useCallback((
    comments: { elementDesc: string; text: string }[],
    state: TabState
  ): string => {
    const activeVarId = state.activeVariationId
    const contextHtml = activeVarId
      ? (state.variations.find((v) => v.id === activeVarId)?.html ?? state.html)
      : state.html

    const MAX_HTML_CHARS = 6000
    const htmlSnippet = contextHtml.length > MAX_HTML_CHARS
      ? contextHtml.slice(0, MAX_HTML_CHARS) + "\n<!-- ...truncated... -->"
      : contextHtml

    const variantNote = activeVarId ? `正在迭代变体 ${activeVarId.toUpperCase()}。` : ""
    const commentLines = comments
      .map((c, i) => `[${i + 1}] 元素 (${c.elementDesc}): ${c.text}`)
      .join("\n")

    return `用户通过 Comment 模式在设计上标注了以下修改意见。请严格按照每条批注对对应元素进行修改，其他部分完全保持不变：

${commentLines}

${variantNote}

---
CURRENT DESIGN HTML (iterate on this — do NOT ignore it):
${htmlSnippet}`
  }, [])

  // ── Send a single comment directly (without saving to list) ─
  const handleSendDraftComment = useCallback((text: string, elementDesc: string) => {
    const tabId = activeTabId
    const state = tabStates[tabId]
    if (!state || !text.trim()) return

    const prompt = buildCommentPrompt([{ elementDesc, text }], state)

    updateTs(tabId, (prev) => ({
      draftComment: null,
      activeCommentId: null,
      messages: [
        ...prev.messages,
        { role: "user" as const, content: `📝 ${text.trim().slice(0, 50)}${text.length > 50 ? "…" : ""}` },
      ],
    }))
    startGeneration(prompt, tabId, true)
  }, [activeTabId, tabStates, updateTs, startGeneration, buildCommentPrompt])

  // ── Send a saved comment pin → model ─────────────────────
  const handleSendComment = useCallback((commentId: string, overrideText?: string) => {
    const tabId = activeTabId
    const state = tabStates[tabId]
    if (!state) return

    const comment = state.comments.find((c) => c.id === commentId)
    if (!comment) return

    const text = overrideText ?? comment.text
    const prompt = buildCommentPrompt([{ elementDesc: comment.elementDesc, text }], state)

    updateTs(tabId, (prev) => ({
      comments: prev.comments.filter((c) => c.id !== commentId),
      draftComment: null,
      activeCommentId: null,
      messages: [
        ...prev.messages,
        { role: "user" as const, content: `📝 ${text.trim().slice(0, 50)}${text.length > 50 ? "…" : ""}` },
      ],
    }))
    startGeneration(prompt, tabId, true)
  }, [activeTabId, tabStates, updateTs, startGeneration, buildCommentPrompt])

  // ── Edit a saved comment's text ───────────────────────────
  const handleEditComment = useCallback((commentId: string, newText: string) => {
    updateTs(activeTabId, (prev) => ({
      comments: prev.comments.map((c) =>
        c.id === commentId ? { ...c, text: newText } : c
      ),
    }))
  }, [activeTabId, updateTs])

  // ── Apply ALL saved comments → send to model ─────────────
  const handleApplyComments = useCallback(() => {
    const tabId = activeTabId
    const state = tabStates[tabId]
    const pending = state?.comments ?? []
    if (pending.length === 0) return

    const prompt = buildCommentPrompt(
      pending.map((c) => ({ elementDesc: c.elementDesc, text: c.text })),
      state
    )

    updateTs(tabId, (prev) => ({
      comments: [],
      draftComment: null,
      activeCommentId: null,
      messages: [
        ...prev.messages,
        { role: "user" as const, content: `📝 发送 ${pending.length} 条批注` },
      ],
    }))

    startGeneration(prompt, tabId, true)
  }, [activeTabId, tabStates, updateTs, startGeneration, buildCommentPrompt])

  // ── Send message ──────────────────────────────────────────

  const handleSend = useCallback(() => {
    const prompt = (tabStates[activeTabId]?.inputValue ?? "").trim()
    if (!prompt) return
    const state = tabStates[activeTabId]?.generationState ?? "idle"
    if (state === "asking" || state === "generating") return
    updateTs(activeTabId, { inputValue: "" })

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
      // Subsequent messages → iterate on existing design
      // If a specific variation is active, iterate on that; otherwise use the full HTML
      const currentState = tabStates[tabId]
      const activeVarId  = currentState?.activeVariationId ?? null
      const contextHtml  = activeVarId
        ? (currentState?.variations.find((v) => v.id === activeVarId)?.html ?? currentState?.html ?? "")
        : (currentState?.html ?? "")

      let iterationPrompt = prompt

      if (contextHtml) {
        const MAX_HTML_CHARS = 6000
        const htmlContext = contextHtml.length > MAX_HTML_CHARS
          ? contextHtml.slice(0, MAX_HTML_CHARS) + "\n<!-- ...truncated... -->"
          : contextHtml

        const variantNote = activeVarId
          ? `Iterating on Variation ${activeVarId.toUpperCase()} specifically.`
          : ""

        iterationPrompt = `User follow-up instruction: ${prompt}
${variantNote}

---
CURRENT DESIGN HTML (iterate on this — do NOT ignore it):
${htmlContext}`
      }

      startGeneration(iterationPrompt, tabId, /* isIteration */ !!contextHtml)
    }
  }, [activeTabId, tabStates, updateTs, startAskQuestions, startGeneration])

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
        if (!val || (Array.isArray(val) && val.length === 0)) return null
        const formatted = Array.isArray(val) ? val.join("、") : val
        return `- ${q.label}: ${formatted}`
      })
      .filter(Boolean)
      .join("\n")

    const enrichedPrompt = `${originalPrompt}\n\n---\nUser's answers to clarifying questions:\n${answerLines}\n\nRemember: Generate exactly 3 variations (A / B / C) within one HTML file.`

    // Build pill tags for the user message update
    const tags = questions
      .map((q) => {
        const val = answers[q.id]
        if (!val || (Array.isArray(val) && val.length === 0)) return null
        return Array.isArray(val) ? val.slice(0, 2).join("、") : val
      })
      .filter((v): v is string => Boolean(v))
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
    const entry = tabSessionsRef.current.get(activeTabId)
    if (entry) {
      entry.cleanup()
      window.api.design.cancel(entry.sessionId).catch(() => {})
      tabSessionsRef.current.delete(activeTabId)
    }
    updateTs(activeTabId, { generationState: "idle" })
  }, [activeTabId, updateTs])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const setAnswer = useCallback((qId: string, value: AnswerValue) => {
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
            <button style={S.navBtn} title="Refresh">↻</button>

            {/* Right panel tabs */}
            <div style={{ display: "flex", gap: 0, marginLeft: 8 }}>
              <RightTabBtn
                label="Design"
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
              {/* Active variation indicator in top bar */}
              {ts.variations.length > 0 && ts.activeVariationId && ts.rightTab === "design" && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "0 12px", height: 44, fontSize: 12, fontWeight: 600,
                  color: VARIATION_COLORS[ts.activeVariationId] ?? "#888",
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: VARIATION_COLORS[ts.activeVariationId] ?? "#888",
                  }} />
                  {ts.variations.find(v => v.id === ts.activeVariationId)?.label}
                </div>
              )}
            </div>

            <div style={{ flex: 1 }} />

            {/* Top-bar tools — tweaks toggle + mode buttons + zoom + export */}
            {ts.html && ts.rightTab === "design" && (
              <div style={S.tweaksBar}>
                {/* Tweaks toggle */}
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: tweaksOn ? "#1a1a1a" : "#8a8a8a" }}>Tweaks</span>
                  <button
                    onClick={() => { setTweaksOn((v) => !v); setActiveMode(null) }}
                    style={{ ...S.toggleTrack, background: tweaksOn ? "#1a1a1a" : "#d4d2cc" }}
                    title={tweaksOn ? "Disable Tweaks" : "Enable Tweaks"}
                  >
                    <span style={{ ...S.toggleThumb, transform: tweaksOn ? "translateX(14px)" : "translateX(0)" }} />
                  </button>
                </div>

                {tweaksOn && (
                  <>
                    <div style={S.tweaksDivider} />
                    <TweaksBtn label="Comment" icon={<CommentIcon active={activeMode === "comment"} />} active={activeMode === "comment"} onClick={() => setActiveMode(activeMode === "comment" ? null : "comment")} />
                    <TweaksBtn label="Edit"    icon={<EditIcon    active={activeMode === "edit"}    />} active={activeMode === "edit"}    onClick={() => setActiveMode(activeMode === "edit"    ? null : "edit")}    />
                    <TweaksBtn label="Draw"    icon={<DrawIcon    active={activeMode === "draw"}    />} active={activeMode === "draw"}    onClick={() => setActiveMode(activeMode === "draw"    ? null : "draw")}    />
                  </>
                )}

                <div style={S.tweaksDivider} />
                {/* Zoom */}
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button onClick={() => setZoom((z) => Math.max(25, z - 25))} style={S.zoomBtn}>−</button>
                  <span style={{ fontSize: 12, fontWeight: 500, color: "#4a4a4a", minWidth: 36, textAlign: "center" }}>{zoom}%</span>
                  <button onClick={() => setZoom((z) => Math.min(200, z + 25))} style={S.zoomBtn}>+</button>
                </div>
                <div style={S.tweaksDivider} />
                <button style={S.canvasActionBtn} onClick={() => downloadHtml(ts.html)}>⬇ Export</button>
              </div>
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
                      <span style={{ fontSize: 14, color: "#8a8a8a" }}>Generating variations…</span>
                    </div>
                  </div>
                ) : ts.html ? (
                  (() => {
                    // Resolve which HTML to show: active variation or full HTML
                    const displayHtml = ts.activeVariationId
                      ? (ts.variations.find((v) => v.id === ts.activeVariationId)?.html ?? ts.html)
                      : ts.html
                    const activeVar = ts.variations.find((v) => v.id === ts.activeVariationId)
                    const varColor  = ts.activeVariationId === "a" ? "#3b82f6"
                      : ts.activeVariationId === "b" ? "#8b5cf6"
                      : ts.activeVariationId === "c" ? "#f59e0b" : undefined

                    return (
                  <div
                    ref={canvasContainerRef}
                    style={{ position: "relative", width: "100%", height: "100%", overflow: "auto" }}
                    onClick={() => {
                      if (ts.activeCommentId) updateTs(activeTabId, { activeCommentId: null })
                    }}
                  >
                    {/* Iteration in-progress banner */}
                    {isGenerating && (
                      <div style={{
                        position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "8px 16px",
                        background: "rgba(26,26,26,0.82)",
                        backdropFilter: "blur(6px)",
                        color: "#ffffff", fontSize: 13, fontWeight: 500,
                      }}>
                        <PulsingDot />
                        <span>Updating design… previous version shown below</span>
                        <button
                          onClick={handleCancel}
                          style={{ marginLeft: "auto", padding: "3px 12px", fontSize: 12, fontWeight: 600,
                            background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.25)",
                            borderRadius: 6, color: "#fff", cursor: "pointer" }}
                        >
                          Stop
                        </button>
                      </div>
                    )}
                    {/* Active variation label badge */}
                    {activeVar && !isGenerating && (
                      <div style={{
                        position: "absolute", top: 12, right: 16, zIndex: 5,
                        padding: "4px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                        background: varColor, color: "#fff",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                        pointerEvents: "none",
                      }}>
                        {activeVar.label}
                      </div>
                    )}
                    <iframe
                      ref={iframeRef}
                      key={ts.activeVariationId ?? "all"}
                      srcDoc={displayHtml}
                      style={{
                        ...S.iframe,
                        transformOrigin: "top left",
                        transform: `scale(${zoom / 100})`,
                        width: `${10000 / zoom}%`,
                        height: `${10000 / zoom}%`,
                        // Comment mode: iframe handles clicks (script injected); other modes: block
                        pointerEvents: activeMode && activeMode !== "comment" ? "none" : "auto",
                      }}
                      sandbox="allow-scripts allow-same-origin"
                      title="Design Preview"
                      onLoad={() => {
                        // Always inject scroll tracker so pins stay anchored to content
                        injectIntoIframe(iframeRef.current, SCROLL_INJECT)
                        // Reset scroll state — new iframe always starts at (0, 0)
                        updateTs(activeTabId, { iframeScrollX: 0, iframeScrollY: 0 })
                        // Re-inject comment script after iframe reloads (variation switch, etc.)
                        if (activeMode === "comment") injectIntoIframe(iframeRef.current, COMMENT_INJECT)
                        // Re-activate edit mode if active
                        if (activeMode === "edit") sendToIframe(iframeRef.current, { type: "__activate_edit_mode" })
                      }}
                    />
                    {/* ── Comment layer ── */}
                    {/* No click overlay needed — iframe script handles clicks via postMessage */}

                    {/* Existing comment pins — always visible while comment mode or there are comments */}
                    {(activeMode === "comment" || ts.comments.length > 0) && (() => {
                      const zf = zoom / 100
                      const cw = canvasContainerRef.current?.clientWidth || 800
                      const ch = canvasContainerRef.current?.clientHeight || 600
                      return ts.comments.map((c, i) => {
                        // Convert document-absolute coords to current canvas-relative % via scroll offset
                        const pinLeft = ((c.pageX - ts.iframeScrollX) * zf / cw) * 100
                        const pinTop  = ((c.pageY - ts.iframeScrollY) * zf / ch) * 100
                        // Hide pins that have scrolled out of the visible canvas area
                        const inView = pinLeft > -6 && pinLeft < 106 && pinTop > -6 && pinTop < 106
                        if (!inView) return null
                        return (
                          <CommentPin
                            key={c.id}
                            comment={c}
                            index={i + 1}
                            pinLeft={pinLeft}
                            pinTop={pinTop}
                            isActive={ts.activeCommentId === c.id}
                            onToggle={() => updateTs(activeTabId, {
                              activeCommentId: ts.activeCommentId === c.id ? null : c.id,
                              draftComment: null,
                            })}
                            onSend={(text) => handleSendComment(c.id, text)}
                            onEdit={(newText) => handleEditComment(c.id, newText)}
                          />
                        )
                      })
                    })()}

                    {/* Draft comment input — shown after clicking canvas */}
                    {ts.draftComment && (() => {
                      const zf = zoom / 100
                      const cw = canvasContainerRef.current?.clientWidth || 800
                      const ch = canvasContainerRef.current?.clientHeight || 600
                      const draftLeft = Math.min(95, Math.max(2,
                        ((ts.draftComment.pageX - ts.iframeScrollX) * zf / cw) * 100
                      ))
                      const draftTop = Math.min(95, Math.max(2,
                        ((ts.draftComment.pageY - ts.iframeScrollY) * zf / ch) * 100
                      ))
                      return (
                        <CommentDraftInput
                          x={draftLeft}
                          y={draftTop}
                          elementDesc={ts.draftComment.elementDesc}
                          onSubmit={(text) => {
                            if (!text.trim()) { updateTs(activeTabId, { draftComment: null }); return }
                            const newComment: CommentItem = {
                              id: uuid(),
                              pageX: ts.draftComment!.pageX,
                              pageY: ts.draftComment!.pageY,
                              text: text.trim(),
                              elementDesc: ts.draftComment!.elementDesc,
                              createdAt: Date.now(),
                            }
                            updateTs(activeTabId, (prev) => ({
                              comments: [...prev.comments, newComment],
                              draftComment: null,
                              activeCommentId: newComment.id,
                            }))
                          }}
                          onSend={(text) => {
                            if (!text.trim()) return
                            const draft = ts.draftComment!
                            handleSendDraftComment(text, draft.elementDesc)
                          }}
                          onCancel={() => updateTs(activeTabId, { draftComment: null })}
                        />
                      )
                    })()}

                    {/* Non-comment mode badge (Edit / Draw) */}
                    {activeMode && activeMode !== "comment" && (
                      <div style={{
                        position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
                        padding: "7px 18px", borderRadius: 20,
                        background: activeMode === "edit" ? "#3b82f6" : "#8b5cf6",
                        color: "#fff", fontSize: 12, fontWeight: 600,
                        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                        display: "flex", alignItems: "center", gap: 7,
                        pointerEvents: "none",
                      }}>
                        {activeMode === "edit" && "✏️"}
                        {activeMode === "draw" && "🖊️"}
                        {activeMode.charAt(0).toUpperCase() + activeMode.slice(1)} mode
                      </div>
                    )}

                    {/* Comment bottom bar: hint when empty, Apply bar when there are comments */}
                    {activeMode === "comment" && !ts.draftComment && (
                      <div style={{
                        position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
                        display: "flex", alignItems: "center", gap: 10,
                        padding: ts.comments.length > 0 ? "8px 8px 8px 16px" : "6px 16px",
                        borderRadius: 999,
                        background: "rgba(26,26,26,0.82)", backdropFilter: "blur(8px)",
                        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
                        whiteSpace: "nowrap",
                      }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: ts.comments.length > 0 ? "#d1d5db" : "#fff" }}>
                          {ts.comments.length === 0
                            ? "点击元素添加批注"
                            : ts.comments.length === 1
                              ? "1 条批注已保存"
                              : `${ts.comments.length} 条批注已保存`}
                        </span>
                        {ts.comments.length > 1 && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleApplyComments() }}
                            style={{
                              padding: "5px 14px", borderRadius: 999,
                              background: "#cc785c", border: "none",
                              fontSize: 12, fontWeight: 700, color: "#fff",
                              cursor: "pointer", fontFamily: "inherit",
                            }}
                          >
                            发送全部 →
                          </button>
                        )}
                      </div>
                    )}

                    {/* Floating Tweaks Panel — bottom-right variation switcher */}
                    {ts.variations.length > 0 && !isGenerating && (
                      <TweaksFloatingPanel
                        variations={ts.variations}
                        activeId={ts.activeVariationId}
                        onSelect={(id) => updateTs(activeTabId, { activeVariationId: id, rightTab: "design" })}
                      />
                    )}
                  </div>
                    )
                  })()
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
// Floating Tweaks Panel — bottom-right variation switcher
// ─────────────────────────────────────────────────────────

function TweaksFloatingPanel({
  variations,
  activeId,
  onSelect,
}: {
  variations: VariationItem[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div style={{
      position: "absolute",
      bottom: 28,
      right: 28,
      zIndex: 30,
      userSelect: "none",
    }}>
      {collapsed ? (
        /* Collapsed pill */
        <button
          onClick={() => setCollapsed(false)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 16px",
            background: "#1a1a1a",
            borderRadius: 999,
            border: "none", cursor: "pointer",
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            color: "#ffffff", fontSize: 12, fontWeight: 700,
            letterSpacing: "0.06em",
            fontFamily: "inherit",
          }}
        >
          <span style={{ fontSize: 10 }}>◈</span>
          TWEAKS
        </button>
      ) : (
        /* Expanded card */
        <div style={{
          background: "#ffffff",
          borderRadius: 20,
          boxShadow: "0 8px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)",
          padding: "20px 22px 18px",
          minWidth: 200,
        }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color: "#1a1a1a", textTransform: "uppercase" }}>
              Tweaks
            </span>
            <button
              onClick={() => setCollapsed(true)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "0 0 0 8px", fontSize: 16, color: "#8a8a8a", lineHeight: 1, fontFamily: "inherit" }}
            >
              ×
            </button>
          </div>

          {/* Variation label */}
          <div style={{ fontSize: 12, color: "#8a8a8a", fontWeight: 500, marginBottom: 10, letterSpacing: "0.02em" }}>
            变体选择
          </div>

          {/* Variation chips */}
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {variations.map((v) => {
              const isActive = activeId === v.id
              const color = VARIATION_COLORS[v.id] ?? "#888"
              return (
                <button
                  key={v.id}
                  onClick={() => onSelect(v.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 14px",
                    borderRadius: 12,
                    fontSize: 13, fontWeight: isActive ? 700 : 500,
                    color: isActive ? "#ffffff" : "#1a1a1a",
                    background: isActive ? "#1a1a1a" : "#f5f4f0",
                    border: "none", cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 0.12s ease",
                    textAlign: "left" as const,
                  }}
                >
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%",
                    background: isActive ? color : "#c8c6c0",
                    flexShrink: 0,
                    transition: "background 0.12s",
                  }} />
                  {v.label}
                </button>
              )
            })}
          </div>

          {/* Active indicator */}
          {activeId && (
            <div style={{
              marginTop: 14, paddingTop: 12, borderTop: "1px solid #f0efeb",
              fontSize: 11, color: "#8a8a8a", textAlign: "center" as const,
            }}>
              后续追问将迭代此变体
            </div>
          )}
        </div>
      )}
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
  answers: Record<string, AnswerValue>
  isLoading: boolean
  onAnswer: (id: string, value: AnswerValue) => void
  onContinue: () => void
}) {
  // Check if a question has been answered
  function isAnswered(q: QuestionDef): boolean {
    const v = answers[q.id]
    if (!v) return false
    if (Array.isArray(v)) return v.length > 0
    return v.trim().length > 0
  }

  const answeredCount = questions.filter(isAnswered).length
  const allAnswered   = questions.length > 0 && answeredCount === questions.length

  // Toggle a chip option for multi-select
  function toggleChip(qId: string, opt: string, multi: boolean) {
    if (!multi) {
      onAnswer(qId, opt)
      return
    }
    const current = answers[qId]
    const arr: string[] = Array.isArray(current) ? current : (current ? [current as string] : [])
    const next = arr.includes(opt) ? arr.filter((v) => v !== opt) : [...arr, opt]
    onAnswer(qId, next)
  }

  function isChipSelected(qId: string, opt: string): boolean {
    const v = answers[qId]
    if (Array.isArray(v)) return v.includes(opt)
    return v === opt
  }

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

  return (
    <div style={S.questionsContainer}>
      <div style={S.questionsInner}>
        <h2 style={S.questionsTitle}>告诉我更多关于这个设计</h2>

        {questions.map((q) => {
          const answered = isAnswered(q)
          return (
            <div key={q.id} style={{ ...S.questionBlock, opacity: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <label style={S.questionLabel}>{q.label}</label>
                {q.type === "chips" && q.multi && (
                  <span style={{ fontSize: 11, color: "#8a8a8a", background: "#f0efeb", padding: "2px 7px", borderRadius: 999, fontWeight: 500 }}>
                    可多选
                  </span>
                )}
                {answered && (
                  <span style={{ fontSize: 11, color: "#4ade80", marginLeft: "auto" }}>✓</span>
                )}
              </div>
              {q.hint && <p style={S.questionHint}>{q.hint}</p>}

              {q.type === "chips" && q.options ? (
                <div style={S.chipsRow}>
                  {q.options.map((opt) => {
                    const selected = isChipSelected(q.id, opt)
                    return (
                      <button
                        key={opt}
                        onClick={() => toggleChip(q.id, opt, q.multi ?? false)}
                        style={{
                          ...S.chip,
                          background: selected ? "#1a1a1a" : "#ffffff",
                          color: selected ? "#ffffff" : "#1a1a1a",
                          border: selected ? "1px solid #1a1a1a" : "1px solid #d4d2cc",
                          // multi-select: show a subtle checkmark prefix when selected
                          paddingLeft: q.multi && selected ? 10 : undefined,
                        }}
                      >
                        {q.multi && selected && <span style={{ marginRight: 5, fontSize: 11 }}>✓</span>}
                        {opt}
                      </button>
                    )
                  })}
                </div>
              ) : q.type === "textarea" ? (
                <textarea
                  value={(answers[q.id] as string) ?? ""}
                  onChange={(e) => onAnswer(q.id, e.target.value)}
                  placeholder="Your answer..."
                  rows={3}
                  style={S.questionTextarea}
                />
              ) : (
                <input
                  type="text"
                  value={(answers[q.id] as string) ?? ""}
                  onChange={(e) => onAnswer(q.id, e.target.value)}
                  placeholder="Your answer..."
                  style={S.questionInput}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Footer with Continue */}
      <div style={S.questionsFooter}>
        <span style={{ fontSize: 13, color: "#8a8a8a" }}>
          {allAnswered
            ? "Ready to generate"
            : `${answeredCount} / ${questions.length} answered`}
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

function VariationTabBtn({ label, active, color, onClick }: {
  label: string; active: boolean; color: string; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={active ? `Viewing ${label} — follow-up messages will iterate this variant` : `Switch to ${label}`}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "0 14px", height: 44,
        fontSize: 13, fontWeight: active ? 700 : 500,
        color: active ? color : "#6a6a6a",
        background: active ? "#ffffff" : "transparent",
        border: "1px solid",
        borderColor: active ? color : "transparent",
        borderBottom: active ? `2px solid ${color}` : "1px solid transparent",
        borderRadius: active ? "6px 6px 0 0" : 0,
        cursor: "pointer", fontFamily: "inherit",
        position: "relative", top: 1,
        transition: "all 0.12s ease",
      }}
    >
      {/* Color dot */}
      <span style={{
        width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
        background: active ? color : "#c8c6c0",
        transition: "background 0.12s",
      }} />
      {label}
    </button>
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
          {message.content || (message.isStreaming
            ? <span style={{ opacity: 0.4 }}>{message.isIteration ? "Updating design…" : "Generating…"}</span>
            : "")}
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
// Tweaks toolbar components
// ─────────────────────────────────────────────────────────

function TweaksBtn({ label, icon, active, onClick }: {
  label: string; icon: React.ReactNode; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "5px 10px", height: 30,
        fontSize: 12, fontWeight: 500,
        color: active ? "#1a1a1a" : "#6a6a6a",
        background: active ? "#e8e6e0" : "transparent",
        border: active ? "1px solid #c8c6c0" : "1px solid transparent",
        borderRadius: 7, cursor: "pointer",
        fontFamily: "inherit", transition: "all 0.12s ease",
      }}
    >
      {icon}
      {label}
    </button>
  )
}

function CommentIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M2 2h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5l-3 2V3a1 1 0 0 1 1-1z"
        stroke={active ? "#f59e0b" : "#6a6a6a"} strokeWidth="1.5" fill={active ? "rgba(245,158,11,0.12)" : "none"} strokeLinejoin="round" />
    </svg>
  )
}

function EditIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M11 2l3 3-8 8H3v-3l8-8z"
        stroke={active ? "#3b82f6" : "#6a6a6a"} strokeWidth="1.5" fill={active ? "rgba(59,130,246,0.12)" : "none"} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function DrawIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M2 13c1-1 2-3 4-4s4 0 5-1 1-3 3-4" stroke={active ? "#8b5cf6" : "#6a6a6a"} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="14" cy="4" r="1.5" fill={active ? "#8b5cf6" : "#6a6a6a"} />
    </svg>
  )
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
// Comment Pin — positioned pin with expand-on-click popover
// ─────────────────────────────────────────────────────────

function CommentPin({ comment, index, pinLeft, pinTop, isActive, onToggle, onSend, onEdit }: {
  comment: CommentItem
  index: number
  pinLeft: number   // computed canvas-left % (accounts for scroll + zoom)
  pinTop: number    // computed canvas-top %
  isActive: boolean
  onToggle: () => void
  onSend: (text: string) => void
  onEdit: (newText: string) => void
}) {
  const AVATAR_SIZE = 26
  const [editText, setEditText] = useState(comment.text)

  // Keep local edit text in sync if parent updates the comment (e.g. after re-open)
  useEffect(() => { setEditText(comment.text) }, [comment.text, isActive])

  const hasEdits = editText.trim() !== comment.text.trim()

  const handleClose = () => {
    if (hasEdits && editText.trim()) onEdit(editText.trim())
    onToggle()
  }

  return (
    <div
      style={{
        position: "absolute",
        left: `${pinLeft}%`,
        top: `${pinTop}%`,
        zIndex: 20,
        transform: "translate(-50%, -50%)",
        pointerEvents: "auto",
      }}
    >
      {/* The pin circle */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        title={comment.text}
        style={{
          width: AVATAR_SIZE, height: AVATAR_SIZE,
          borderRadius: "50% 50% 50% 0",
          transform: "rotate(-45deg)",
          background: "#f59e0b",
          border: "2px solid #fff",
          boxShadow: isActive
            ? "0 0 0 3px rgba(245,158,11,0.35), 0 4px 12px rgba(0,0,0,0.2)"
            : "0 2px 8px rgba(0,0,0,0.18)",
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, padding: 0,
          transition: "box-shadow 0.15s",
        }}
      >
        <span style={{
          transform: "rotate(45deg)",
          fontSize: 11, fontWeight: 700, color: "#fff", lineHeight: 1,
          fontFamily: "inherit",
        }}>
          {index}
        </span>
      </button>

      {/* Expanded popover */}
      {isActive && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: AVATAR_SIZE + 8,
            left: "50%",
            transform: "translateX(-50%)",
            width: 252,
            background: "#ffffff",
            borderRadius: 14,
            boxShadow: "0 8px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)",
            padding: "14px 14px 12px",
            zIndex: 30,
          }}
        >
          {/* Header row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{
              width: 20, height: 20, borderRadius: "50%",
              background: "#f59e0b",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 700, color: "#fff", flexShrink: 0,
            }}>
              {index}
            </span>
            <span style={{ fontSize: 11, color: "#8a8a8a", flex: 1 }}>
              {new Date(comment.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
            </span>
            <button
              onClick={handleClose}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: "#aaa", padding: "0 2px", lineHeight: 1 }}
            >×</button>
          </div>

          {/* Element tag */}
          <div style={{
            display: "inline-block", marginBottom: 8,
            padding: "2px 8px", borderRadius: 5,
            background: "#fef3c7", color: "#92400e",
            fontSize: 11, fontFamily: "monospace",
            maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {comment.elementDesc}
          </div>

          {/* Editable comment text */}
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                if (editText.trim()) onSend(editText.trim())
              }
              if (e.key === "Escape") { e.preventDefault(); handleClose() }
            }}
            rows={3}
            style={{
              width: "100%", border: "1px solid #e0ded8", borderRadius: 8,
              padding: "7px 9px", fontSize: 13, fontFamily: "inherit",
              resize: "none", outline: "none", lineHeight: 1.5, color: "#1a1a1a",
              boxSizing: "border-box", marginBottom: 10,
              background: "#fafaf8",
            }}
          />

          {/* Actions */}
          <div style={{ display: "flex", gap: 7 }}>
            <button
              onClick={handleClose}
              style={{
                flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 500,
                background: "#f5f4f0", border: "none", borderRadius: 8,
                cursor: "pointer", color: "#6a6a6a", fontFamily: "inherit",
              }}
            >
              {hasEdits ? "保存" : "关闭"}
            </button>
            <button
              onClick={() => { if (editText.trim()) onSend(editText.trim()) }}
              disabled={!editText.trim()}
              style={{
                flex: 2, padding: "6px 0", fontSize: 12, fontWeight: 700,
                background: editText.trim() ? "#cc785c" : "#e0ded8",
                border: "none", borderRadius: 8,
                cursor: editText.trim() ? "pointer" : "default",
                color: editText.trim() ? "#fff" : "#aaa",
                fontFamily: "inherit", transition: "background 0.12s",
              }}
            >
              发送 →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Comment Draft Input — floating text box on new click
// ─────────────────────────────────────────────────────────

function CommentDraftInput({ x, y, elementDesc, onSubmit, onSend, onCancel }: {
  x: number
  y: number
  elementDesc: string
  onSubmit: (text: string) => void   // 保存 — add to pins list
  onSend: (text: string) => void     // 发送 — skip saving, send directly to model
  onCancel: () => void
}) {
  const [text, setText] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { textareaRef.current?.focus() }, [])

  const canSubmit = text.trim().length > 0

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        transform: "translate(-50%, 8px)",
        zIndex: 25,
        width: 264,
        background: "#ffffff",
        borderRadius: 14,
        boxShadow: "0 8px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)",
        padding: "14px 14px 12px",
      }}
    >
      {/* Draft pin indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{
          width: 20, height: 20, borderRadius: "50%",
          background: "#f59e0b",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, color: "#fff", fontWeight: 700, flexShrink: 0,
        }}>+</span>
        <span style={{ fontSize: 12, color: "#8a8a8a", fontWeight: 500 }}>添加批注</span>
      </div>

      {/* Element context tag */}
      <div style={{
        display: "inline-block", marginBottom: 10,
        padding: "3px 10px", borderRadius: 6,
        background: "#fef3c7", color: "#92400e",
        fontSize: 11, fontFamily: "monospace", fontWeight: 500,
        maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {elementDesc}
      </div>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (canSubmit) onSubmit(text.trim()) }
          if (e.key === "Escape") { e.preventDefault(); onCancel() }
        }}
        placeholder="输入批注内容… (Shift+Enter 换行)"
        rows={3}
        style={{
          width: "100%", border: "1px solid #e0ded8", borderRadius: 8,
          padding: "8px 10px", fontSize: 13, fontFamily: "inherit",
          resize: "none", outline: "none", lineHeight: 1.5, color: "#1a1a1a",
          boxSizing: "border-box",
        }}
      />

      {/* 3-button row: 取消 / 保存 / 发送 */}
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button
          onClick={onCancel}
          style={{
            flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 500,
            background: "#f5f4f0", border: "none", borderRadius: 8,
            cursor: "pointer", color: "#6a6a6a", fontFamily: "inherit",
          }}
        >
          取消
        </button>
        <button
          onClick={() => { if (canSubmit) onSubmit(text.trim()) }}
          disabled={!canSubmit}
          style={{
            flex: 1.4, padding: "6px 0", fontSize: 12, fontWeight: 600,
            background: canSubmit ? "#f5f4f0" : "#ebebeb",
            border: canSubmit ? "1px solid #c8c6c0" : "1px solid #e0ded8",
            borderRadius: 8,
            cursor: canSubmit ? "pointer" : "default",
            color: canSubmit ? "#1a1a1a" : "#aaa",
            fontFamily: "inherit", transition: "all 0.12s",
          }}
        >
          保存
        </button>
        <button
          onClick={() => { if (canSubmit) onSend(text.trim()) }}
          disabled={!canSubmit}
          style={{
            flex: 1.6, padding: "6px 0", fontSize: 12, fontWeight: 700,
            background: canSubmit ? "#cc785c" : "#e0ded8",
            border: "none", borderRadius: 8,
            cursor: canSubmit ? "pointer" : "default",
            color: canSubmit ? "#fff" : "#aaa",
            fontFamily: "inherit", transition: "background 0.12s",
          }}
        >
          发送 →
        </button>
      </div>
    </div>
  )
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

  // Tweaks toolbar
  tweaksBar:         { display: "flex", alignItems: "center", gap: 4 },
  tweaksDivider:     { width: 1, height: 18, background: "#d4d2cc", margin: "0 4px", flexShrink: 0 },
  toggleTrack:       { width: 28, height: 16, borderRadius: 999, border: "none", cursor: "pointer", position: "relative" as const, padding: 0, transition: "background 0.2s", flexShrink: 0 },
  toggleThumb:       { position: "absolute" as const, top: 2, left: 2, width: 12, height: 12, borderRadius: "50%", background: "#ffffff", transition: "transform 0.2s", display: "block" },
  zoomBtn:           { width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "1px solid #d4d2cc", borderRadius: 5, cursor: "pointer", fontSize: 13, color: "#4a4a4a", fontFamily: "inherit", lineHeight: 1 },
}
