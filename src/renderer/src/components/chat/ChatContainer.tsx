import { useRef, useEffect, useMemo, useCallback, useState } from "react"
import {
  Send,
  Square,
  AlertCircle,
  X,
  FileText,
  FileSpreadsheet,
  Presentation,
  Search,
  Palette,
  FlaskConical,
  Code2,
  LayoutTemplate,
  Settings2,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Database,
  Layers
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAppStore } from "@/lib/store"
import { useCurrentThread, useThreadStream } from "@/lib/thread-context"
import { MessageBubble } from "./MessageBubble"
import { ModelSwitcher } from "./ModelSwitcher"
import { WorkspacePicker } from "./WorkspacePicker"
import { ChatTodos } from "./ChatTodos"
import { ContextUsageIndicator } from "./ContextUsageIndicator"
import type { Message, SkillMetadata } from "@/types"

interface AgentStreamValues {
  todos?: Array<{ id?: string; content?: string; status?: string }>
}

interface StreamMessage {
  id?: string
  type?: string
  content?: string | unknown[]
  tool_calls?: Message["tool_calls"]
  tool_call_id?: string
  name?: string
}

interface ChatContainerProps {
  threadId: string
}

const THINKING_MESSAGES = [
  "我先想想...",
  "让我捋一捋...",
  "我去翻翻代码...",
  "我来找线索...",
  "先做个判断...",
  "我再核对一下...",
  "先把思路摊开...",
  "我来拼一下答案...",
  "我再压一遍细节...",
  "先看下上下文...",
  "我再过一遍日志...",
  "我来换个角度...",
  "先把重点抓出来...",
  "让我算一轮...",
  "我再确认一下...",
  "我先试条路...",
  "我去查个依据...",
  "我先把话说准...",
  "我再补一刀...",
  "我来收个尾...",
  "先别急，快到了...",
  "差最后一段了...",
  "我再润一润...",
  "再给我两秒...",
  "我来给你个稳妥版...",
  "我先把坑绕开...",
  "我再压压风险...",
  "先把答案打磨下...",
  "马上给你结果...",
  "就快好了..."
]

export function ChatContainer({ threadId }: ChatContainerProps): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const isComposingRef = useRef(false)
  const [skills, setSkills] = useState<SkillMetadata[]>([])
  const [skillsLoading, setSkillsLoading] = useState(true)
  const [showAllGeneralSkills, setShowAllGeneralSkills] = useState(false)
  const [showAllProgrammingSkills, setShowAllProgrammingSkills] = useState(false)
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0)
  const thinkingCycleRef = useRef(-1)
  const wasLoadingRef = useRef(false)
  const loadingMessageCountRef = useRef(0)

  const { threads, models, loadThreads, generateTitleForFirstMessage } = useAppStore()

  // Get persisted thread state and actions from context
  const {
    messages: threadMessages,
    pendingApproval,
    todos,
    error: threadError,
    workspacePath,
    tokenUsage,
    currentModel,
    draftInput: input,
    setTodos,
    setPendingApproval,
    appendMessage,
    setError,
    clearError,
    setDraftInput: setInput
  } = useCurrentThread(threadId)

  // Get the stream data via subscription - reactive updates without re-rendering provider
  const streamData = useThreadStream(threadId)
  const stream = streamData.stream
  const isLoading = streamData.isLoading

  useEffect(() => {
    const currentMessageCount = streamData.messages.length

    if (!isLoading) {
      wasLoadingRef.current = false
      loadingMessageCountRef.current = 0
      return
    }

    // First entering loading for this turn.
    if (!wasLoadingRef.current) {
      thinkingCycleRef.current = (thinkingCycleRef.current + 1) % THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      loadingMessageCountRef.current = currentMessageCount
      wasLoadingRef.current = true
      return
    }

    // During the same turn, if new streamed messages arrive (e.g. tool round-trip),
    // switch to next slogan once to mimic "stage changed" feedback.
    if (currentMessageCount > loadingMessageCountRef.current) {
      thinkingCycleRef.current = (thinkingCycleRef.current + 1) % THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      loadingMessageCountRef.current = currentMessageCount
    }
  }, [isLoading, streamData.messages.length])

  const handleApprovalDecision = useCallback(
    async (decision: "approve" | "reject" | "edit"): Promise<void> => {
      if (!pendingApproval || !stream) return

      setPendingApproval(null)

      try {
        await stream.submit(null, {
          command: { resume: { decision } },
          config: { configurable: { thread_id: threadId, model_id: currentModel } }
        })
      } catch (err) {
        console.error("[ChatContainer] Resume command failed:", err)
      }
    },
    [pendingApproval, setPendingApproval, stream, threadId, currentModel]
  )

  const agentValues = stream?.values as AgentStreamValues | undefined
  const streamTodos = agentValues?.todos
  useEffect(() => {
    if (Array.isArray(streamTodos)) {
      setTodos(
        streamTodos.map((t) => ({
          id: t.id || crypto.randomUUID(),
          content: t.content || "",
          status: (t.status || "pending") as "pending" | "in_progress" | "completed" | "cancelled"
        }))
      )
    }
  }, [streamTodos, setTodos])

  const prevLoadingRef = useRef(false)
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading) {
      for (const rawMsg of streamData.messages) {
        const msg = rawMsg as StreamMessage
        if (msg.id) {
          const streamMsg = msg as StreamMessage & { id: string }

          let role: Message["role"] = "assistant"
          if (streamMsg.type === "human") role = "user"
          else if (streamMsg.type === "tool") role = "tool"
          else if (streamMsg.type === "ai") role = "assistant"

          const storeMsg: Message = {
            id: streamMsg.id,
            role,
            content: typeof streamMsg.content === "string" ? streamMsg.content : "",
            tool_calls: streamMsg.tool_calls,
            ...(role === "tool" &&
              streamMsg.tool_call_id && { tool_call_id: streamMsg.tool_call_id }),
            ...(role === "tool" && streamMsg.name && { name: streamMsg.name }),
            created_at: new Date()
          }
          appendMessage(storeMsg)
        }
      }
      loadThreads()
    }
    prevLoadingRef.current = isLoading
  }, [isLoading, streamData.messages, loadThreads, appendMessage])

  const displayMessages = useMemo(() => {
    const threadMessageIds = new Set(threadMessages.map((m) => m.id))

    const streamingMsgs: Message[] = ((streamData.messages || []) as StreamMessage[])
      .filter((m): m is StreamMessage & { id: string } => !!m.id && !threadMessageIds.has(m.id))
      .map((streamMsg) => {
        let role: Message["role"] = "assistant"
        if (streamMsg.type === "human") role = "user"
        else if (streamMsg.type === "tool") role = "tool"
        else if (streamMsg.type === "ai") role = "assistant"

        return {
          id: streamMsg.id,
          role,
          content: typeof streamMsg.content === "string" ? streamMsg.content : "",
          tool_calls: streamMsg.tool_calls,
          ...(role === "tool" &&
            streamMsg.tool_call_id && { tool_call_id: streamMsg.tool_call_id }),
          ...(role === "tool" && streamMsg.name && { name: streamMsg.name }),
          created_at: new Date()
        }
      })

    return [...threadMessages, ...streamingMsgs]
  }, [threadMessages, streamData.messages])

  // Build tool results map from tool messages
  const toolResults = useMemo(() => {
    const results = new Map<string, { content: string | unknown; is_error?: boolean }>()
    for (const msg of displayMessages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        results.set(msg.tool_call_id, {
          content: msg.content,
          is_error: false // Could be enhanced to track errors
        })
      }
    }
    return results
  }, [displayMessages])

  // Get the actual scrollable viewport element from Radix ScrollArea
  const getViewport = useCallback((): HTMLDivElement | null => {
    return scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement | null
  }, [])

  // Track scroll position to determine if user is at bottom
  const handleScroll = useCallback((): void => {
    const viewport = getViewport()
    if (!viewport) return

    const { scrollTop, scrollHeight, clientHeight } = viewport
    // Consider "at bottom" if within 50px of the bottom
    const threshold = 50
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < threshold
  }, [getViewport])

  // Attach scroll listener to viewport
  useEffect(() => {
    const viewport = getViewport()
    if (!viewport) return

    viewport.addEventListener("scroll", handleScroll)
    return () => viewport.removeEventListener("scroll", handleScroll)
  }, [getViewport, handleScroll])

  // Auto-scroll on new messages only if already at bottom
  useEffect(() => {
    const viewport = getViewport()
    if (viewport && isAtBottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [displayMessages, isLoading, getViewport])

  // Always scroll to bottom when switching threads
  useEffect(() => {
    const viewport = getViewport()
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
      isAtBottomRef.current = true
    }
  }, [threadId, getViewport])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [threadId])

  const handleDismissError = (): void => {
    clearError()
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!input.trim() || isLoading || !stream) return

    if (!currentModel) {
      setError("请先在下方选择模型后再发送消息。")
      return
    }

    const selectedModel = models.find((m) => m.id === currentModel)
    if (!selectedModel) {
      setError("当前线程模型不存在，请重新选择模型。")
      return
    }

    if (!selectedModel.available) {
      setError("当前模型不可用，请先在模型配置中设置 API 密钥。")
      return
    }

    if (!workspacePath) {
      setError("请先选择一个工作区文件夹再发送消息。")
      return
    }

    if (threadError) {
      clearError()
    }

    if (pendingApproval) {
      setPendingApproval(null)
    }

    const message = input.trim()
    setInput("")

    const isFirstMessage = threadMessages.length === 0

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: message,
      created_at: new Date()
    }
    appendMessage(userMessage)

    if (isFirstMessage) {
      const currentThread = threads.find((t) => t.thread_id === threadId)
      const hasDefaultTitle = currentThread?.title?.startsWith("Thread ")
      if (hasDefaultTitle) {
        generateTitleForFirstMessage(threadId, message)
      }
    }

    await stream.submit(
      {
        messages: [{ type: "human", content: message }]
      },
      {
        config: {
          configurable: { thread_id: threadId, model_id: currentModel }
        }
      }
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // IME composing (Chinese/Japanese/Korean) should not trigger submit on Enter
    const isComposing = e.nativeEvent.isComposing || isComposingRef.current
    if (isComposing) return

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  // Auto-resize textarea based on content
  const adjustTextareaHeight = (): void => {
    const textarea = inputRef.current
    if (textarea) {
      textarea.style.height = "auto"
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }

  useEffect(() => {
    adjustTextareaHeight()
  }, [input])

  const handleCancel = async (): Promise<void> => {
    await stream?.stop()
  }

  useEffect(() => {
    let mounted = true

    const loadSkills = async (): Promise<void> => {
      try {
        const [loadedSkills, disabledList] = await Promise.all([
          window.api.skills.list(),
          window.api.skills.getDisabled()
        ])
        if (!mounted) return
        const disabledSet = new Set(disabledList)
        const builtinOnly = loadedSkills.filter((s) => s.source === "project" && !disabledSet.has(s.name))
        setSkills([...builtinOnly].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")))
      } catch (error) {
        console.error("[ChatContainer] Failed to load skills:", error)
        if (mounted) setSkills([])
      } finally {
        if (mounted) setSkillsLoading(false)
      }
    }

    void loadSkills()

    return () => {
      mounted = false
    }
  }, [])

  const getSkillId = useCallback((skill: SkillMetadata): string => {
    const fromPath = skill.path.split("/").slice(-2, -1)[0]
    return (fromPath || skill.name || "").toLowerCase()
  }, [])

  const buildSkillPrompt = useCallback(
    (skill: SkillMetadata): string => {
      const skillId = getSkillId(skill)
      const promptMap: Record<string, string> = {
        "algorithmic-art": [
          "请帮我生成一套算法艺术方案。",
          "主题与风格：<请补充>",
          "输出：创意说明、实现步骤、可直接运行的代码。"
        ].join("\n"),
        "brand-guidelines": [
          "请按品牌规范统一这份内容的视觉风格。",
          "品牌调性：<请补充>",
          "输出：改造方案、关键规范、最终可用结果。"
        ].join("\n"),
        "canvas-design": [
          "请设计一张视觉海报。",
          "场景与受众：<请补充>",
          "输出：版式思路、配色建议、成稿方案。"
        ].join("\n"),
        docx: [
          "请帮我处理 Word 文档。",
          "具体需求：<新建/修改/排版/提取内容>",
          "输出：处理结果与修改要点。"
        ].join("\n"),
        "doc-coauthoring": [
          "请和我一起协作完善这份文档。",
          "文档类型与目标：<请补充>",
          "输出：结构优化建议和可直接使用的正文。"
        ].join("\n"),
        "frontend-design": [
          "请帮我设计并实现前端界面。",
          "页面目标与风格：<请补充>",
          "输出：页面方案、关键代码、验证方式。"
        ].join("\n"),
        "internal-comms": [
          "请帮我撰写内部沟通稿。",
          "沟通对象与目的：<请补充>",
          "输出：清晰版本正文与可选精简版。"
        ].join("\n"),
        "mcp-builder": [
          "请帮我搭建一个 MCP 服务。",
          "目标能力与外部系统：<请补充>",
          "输出：实现步骤、核心代码、联调说明。"
        ].join("\n"),
        pdf: [
          "请帮我处理 PDF 文档。",
          "具体操作：<提取/合并/拆分/转换/校对>",
          "输出：处理结果与关键说明。"
        ].join("\n"),
        pptx: [
          "请帮我制作或优化演示文稿。",
          "主题与页数预期：<请补充>",
          "输出：大纲、页面建议、可交付稿件。"
        ].join("\n"),
        "skill-creator": [
          "请帮我创建一个新技能包。",
          "技能用途与触发场景：<请补充>",
          "输出：技能结构、说明文档、示例。"
        ].join("\n"),
        "slack-gif-creator": [
          "请帮我制作一个用于 Slack 的动图。",
          "内容主题：<请补充>",
          "输出：制作方案、参数建议、成品要求。"
        ].join("\n"),
        "theme-factory": [
          "请帮我应用统一主题风格。",
          "应用对象：<文档/页面/演示稿>",
          "输出：主题方案与落地结果。"
        ].join("\n"),
        "web-app-testing": [
          "请帮我测试这个 Web 应用。",
          "重点流程：<请补充>",
          "输出：测试步骤、问题清单、修复建议。"
        ].join("\n"),
        "webapp-testing": [
          "请帮我测试这个 Web 应用。",
          "重点流程：<请补充>",
          "输出：测试步骤、问题清单、修复建议。"
        ].join("\n"),
        "security-review": [
          "请使用 security-review 技能对当前分支变更做安全审查。",
          "要求：仅输出高置信度（>=8/10）的中高危漏洞，避免误报。",
          "输出：按 漏洞标题/严重级别/影响文件与位置/利用路径/修复建议 的结构化报告。"
        ].join("\n"),
        "web-artifacts-builder": [
          "请帮我构建一个交互页面。",
          "功能目标：<请补充>",
          "输出：页面结构、实现代码、使用说明。"
        ].join("\n"),
        xlsx: [
          "请帮我处理表格数据。",
          "任务内容：<清洗/计算/格式化/分析>",
          "输出：处理结果、公式或规则说明。"
        ].join("\n"),
        "code-review-expert": [
          "请使用 code-review-expert 技能对当前 git 变更做结构化代码审查。",
          "审查范围：SOLID 原则、安全漏洞、性能问题、错误处理、边界条件。",
          "输出：按 P0-P3 严重级别分类的结构化报告，完成后询问是否修复。"
        ].join("\n"),
        "vercel-react-best-practices": [
          "请基于 React 最佳实践审查/优化当前组件代码。",
          "关注点：渲染性能、组合模式、状态管理、异步处理、打包优化。",
          "输出：问题列表、优化建议、改造代码。"
        ].join("\n"),
        "audit-website": [
          "请对以下网站做全面安全审计。",
          "目标网址：<请补充>",
          "输出：漏洞清单、风险等级、修复建议。"
        ].join("\n"),
        "supabase-postgres-best-practices": [
          "请基于 PostgreSQL 最佳实践审查当前数据库设计或查询。",
          "关注点：索引优化、RLS 安全策略、连接池、N+1 查询、分区策略。",
          "输出：问题诊断、优化建议、改进 SQL。"
        ].join("\n"),
        "typescript-advanced-types": [
          "请帮我优化 TypeScript 类型定义，运用高级类型技巧。",
          "目标文件或模块：<请补充>",
          "输出：类型改进方案、重构代码、类型安全提升说明。"
        ].join("\n"),
        "api-design-principles": [
          "请基于 API 设计原则审查/设计当前接口。",
          "API 类型：<REST / GraphQL>",
          "输出：设计规范建议、接口定义、示例代码。"
        ].join("\n"),
        "architecture-patterns": [
          "请基于架构模式对当前项目结构提出改进方案。",
          "关注点：Clean Architecture、六边形架构、DDD 领域驱动设计。",
          "输出：架构诊断、重构方案、目录结构建议。"
        ].join("\n"),
        "error-handling-patterns": [
          "请审查当前代码的错误处理策略并提出改进。",
          "关注点：异常层次、重试机制、熔断器、优雅降级。",
          "输出：问题清单、模式建议、改进代码。"
        ].join("\n"),
        "planning-with-files": [
          "请使用文件驱动规划方式管理当前复杂任务。",
          "任务目标：<请补充>",
          "输出：task_plan.md、findings.md、progress.md 三份规划文档。"
        ].join("\n")
      }
      return (
        promptMap[skillId] ||
        [
          "请帮我处理该技能相关任务。",
          "需求说明：<请补充>",
          "输出：结果、关键改动、验证方式。"
        ].join("\n")
      )
    },
    [getSkillId]
  )

  const getSkillSummary = useCallback(
    (skill: SkillMetadata): string => {
      const skillId = getSkillId(skill)
      const summaryMap: Record<string, string> = {
        "algorithmic-art": "生成艺术图案",
        "brand-guidelines": "统一品牌风格",
        "canvas-design": "设计视觉海报",
        docx: "编辑 Word 文档",
        "doc-coauthoring": "协作撰写文档",
        "frontend-design": "设计前端界面",
        "internal-comms": "撰写内部沟通稿",
        "mcp-builder": "搭建 MCP 服务",
        pdf: "处理 PDF 文档",
        pptx: "制作演示文稿",
        "skill-creator": "创建新技能包",
        "slack-gif-creator": "制作 Slack 动图",
        "theme-factory": "应用主题风格",
        "web-app-testing": "测试 Web 应用",
        "webapp-testing": "测试 Web 应用",
        "web-artifacts-builder": "构建交互页面",
        xlsx: "处理表格数据",
        "security-review": "安全代码审查",
        "code-review-expert": "结构化代码审查",
        "vercel-react-best-practices": "React 最佳实践",
        "audit-website": "网站安全审计",
        "supabase-postgres-best-practices": "PostgreSQL 优化",
        "typescript-advanced-types": "TS 高级类型优化",
        "api-design-principles": "API 设计原则",
        "architecture-patterns": "架构模式设计",
        "error-handling-patterns": "错误处理模式",
        "planning-with-files": "文件驱动规划"
      }
      return summaryMap[skillId] || "完成专项任务"
    },
    [getSkillId]
  )

  const getSkillIcon = useCallback(
    (skill: SkillMetadata): React.JSX.Element => {
      const skillId = getSkillId(skill)
      const iconMap: Record<string, React.JSX.Element> = {
        "algorithmic-art": <Palette className="size-4" />,
        "brand-guidelines": <Palette className="size-4" />,
        "canvas-design": <LayoutTemplate className="size-4" />,
        docx: <FileText className="size-4" />,
        "doc-coauthoring": <FileText className="size-4" />,
        "frontend-design": <LayoutTemplate className="size-4" />,
        "internal-comms": <FileText className="size-4" />,
        "mcp-builder": <Code2 className="size-4" />,
        pdf: <FileText className="size-4" />,
        pptx: <Presentation className="size-4" />,
        "skill-creator": <Settings2 className="size-4" />,
        "slack-gif-creator": <FlaskConical className="size-4" />,
        "theme-factory": <Palette className="size-4" />,
        "web-app-testing": <FlaskConical className="size-4" />,
        "webapp-testing": <FlaskConical className="size-4" />,
        "web-artifacts-builder": <LayoutTemplate className="size-4" />,
        xlsx: <FileSpreadsheet className="size-4" />,
        "security-review": <Code2 className="size-4" />,
        "code-review-expert": <Code2 className="size-4" />,
        "vercel-react-best-practices": <Code2 className="size-4" />,
        "audit-website": <ShieldCheck className="size-4" />,
        "supabase-postgres-best-practices": <Database className="size-4" />,
        "typescript-advanced-types": <Code2 className="size-4" />,
        "api-design-principles": <Layers className="size-4" />,
        "architecture-patterns": <Layers className="size-4" />,
        "error-handling-patterns": <AlertCircle className="size-4" />,
        "planning-with-files": <FileText className="size-4" />
      }
      return iconMap[skillId] || <Search className="size-4" />
    },
    [getSkillId]
  )

  const programmingSkillIds = useMemo(
    () =>
      new Set([
        "security-review",
        "code-review-expert",
        "vercel-react-best-practices",
        "audit-website",
        "supabase-postgres-best-practices",
        "typescript-advanced-types",
        "api-design-principles",
        "architecture-patterns",
        "error-handling-patterns",
        "planning-with-files",
        "mcp-builder",
        "webapp-testing",
        "frontend-design"
      ]),
    []
  )

  const isProgrammingSkill = useCallback(
    (skill: SkillMetadata): boolean => programmingSkillIds.has(getSkillId(skill)),
    [getSkillId, programmingSkillIds]
  )

  const { generalSkills, programmingSkills } = useMemo(() => {
    const general = skills.filter((skill) => !isProgrammingSkill(skill))
    const programming = skills.filter(isProgrammingSkill)
    return { generalSkills: general, programmingSkills: programming }
  }, [skills, isProgrammingSkill])

  const visibleGeneralSkillCards = useMemo(() => {
    const source = showAllGeneralSkills ? generalSkills : generalSkills.slice(0, 8)

    return source.map((skill) => ({
      skill,
      label: getSkillSummary(skill),
      icon: getSkillIcon(skill)
    }))
  }, [showAllGeneralSkills, generalSkills, getSkillSummary, getSkillIcon])

  const programmingSkillCards = useMemo(() => {
    const source = showAllProgrammingSkills ? programmingSkills : programmingSkills.slice(0, 8)

    return source.map((skill) => ({
      skill,
      label: getSkillSummary(skill),
      icon: getSkillIcon(skill)
    }))
  }, [showAllProgrammingSkills, programmingSkills, getSkillSummary, getSkillIcon])

  const handleUseSkillPrompt = useCallback(
    (skill: SkillMetadata): void => {
      const prompt = buildSkillPrompt(skill)
      setInput(prompt)
      requestAnimationFrame(() => {
        const textarea = inputRef.current
        if (!textarea) return
        textarea.focus()
        const cursor = prompt.length
        textarea.setSelectionRange(cursor, cursor)
      })
    },
    [buildSkillPrompt, setInput]
  )

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="p-4">
          <div className="max-w-3xl mx-auto space-y-4">
            {displayMessages.length === 0 && !isLoading && (
              <div className="pt-14 pb-8">
                <div className="mb-6 flex items-center justify-start">
                  <div className="text-2xl md:text-3xl font-bold tracking-tight text-foreground leading-none">
                    我能帮你做什么？
                  </div>
                </div>

                {skillsLoading ? (
                  <div className="text-sm text-muted-foreground text-center py-10">正在加载技能列表...</div>
                ) : skills.length === 0 ? null : (
                  <div className="space-y-3">
                    {programmingSkillCards.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs text-muted-foreground font-medium tracking-wider">
                          编程场景
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          {programmingSkillCards.map(({ skill, label, icon }) => (
                            <button
                              key={skill.path}
                              type="button"
                              onClick={() => handleUseSkillPrompt(skill)}
                              className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors"
                            >
                              <div className="flex items-center gap-3">
                                <div className="rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                                  {icon}
                                </div>
                                <div className="text-xs text-foreground leading-5">{label}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                        {programmingSkills.length > 8 && (
                          <button
                            type="button"
                            onClick={() => setShowAllProgrammingSkills((prev) => !prev)}
                            className="mx-auto flex items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
                          >
                            {showAllProgrammingSkills ? (
                              <>
                                <ChevronUp className="size-3.5" />
                                <span>收起</span>
                              </>
                            ) : (
                              <>
                                <ChevronDown className="size-3.5" />
                                <span>展开更多（+{programmingSkills.length - 8}）</span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    )}

                    {visibleGeneralSkillCards.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs text-muted-foreground font-medium tracking-wider">
                          通用场景
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          {visibleGeneralSkillCards.map(({ skill, label, icon }) => (
                            <button
                              key={skill.path}
                              type="button"
                              onClick={() => handleUseSkillPrompt(skill)}
                              className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors"
                            >
                              <div className="flex items-center gap-3">
                                <div className="rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                                  {icon}
                                </div>
                                <div className="text-xs text-foreground leading-5">{label}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {generalSkills.length > 8 && (
                      <button
                        type="button"
                        onClick={() => setShowAllGeneralSkills((prev) => !prev)}
                        className="mx-auto flex items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
                      >
                        {showAllGeneralSkills ? (
                          <>
                            <ChevronUp className="size-3.5" />
                            <span>收起</span>
                          </>
                        ) : (
                          <>
                            <ChevronDown className="size-3.5" />
                            <span>展开更多（+{generalSkills.length - 8}）</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {displayMessages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                toolResults={toolResults}
                pendingApproval={pendingApproval}
                onApprovalDecision={handleApprovalDecision}
              />
            ))}

            {/* Streaming indicator and inline TODOs */}
            {isLoading && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <div className="rainbow-spinner" />
                  <span className="thinking-shimmer-text" data-text={THINKING_MESSAGES[thinkingMessageIndex]}>
                    {THINKING_MESSAGES[thinkingMessageIndex]}
                  </span>
                </div>
                {todos.length > 0 && <ChatTodos todos={todos} />}
              </div>
            )}

            {/* Error state */}
            {threadError && !isLoading && (
              <div className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-4">
                <AlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-destructive text-sm">代理出错</div>
                  <div className="text-sm text-muted-foreground mt-1 break-words">
                    {threadError}
                  </div>
                  <div className="text-xs text-muted-foreground mt-2">
                    你可以尝试发送新消息继续对话。
                  </div>
                </div>
                <button
                  onClick={handleDismissError}
                  className="shrink-0 rounded p-1 hover:bg-destructive/20 transition-colors"
                  aria-label="Dismiss error"
                >
                  <X className="size-4 text-muted-foreground" />
                </button>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="p-4">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
          <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onCompositionStart={() => {
                  isComposingRef.current = true
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false
                }}
                onKeyDown={handleKeyDown}
                placeholder="输入消息..."
                disabled={isLoading}
                className="flex-1 min-w-0 resize-none rounded-xl border border-border bg-white px-4 py-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 shadow-sm"
                rows={1}
                style={{ minHeight: "48px", maxHeight: "200px" }}
              />
              <div className="flex items-center justify-center shrink-0 h-12">
                {isLoading ? (
                  <Button type="button" variant="ghost" size="icon" onClick={handleCancel}>
                    <Square className="size-4" />
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    variant="default"
                    size="icon"
                    disabled={!input.trim()}
                    className="rounded-md"
                  >
                    <Send className="size-4" />
                  </Button>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ModelSwitcher threadId={threadId} />
                <div className="w-px h-4 bg-border" />
                <WorkspacePicker threadId={threadId} />
              </div>
              {tokenUsage && (
                <ContextUsageIndicator tokenUsage={tokenUsage} modelId={currentModel} />
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
