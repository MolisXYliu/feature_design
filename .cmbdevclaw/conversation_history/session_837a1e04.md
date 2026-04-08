## Summarized at 2026-04-01T07:28:18.659Z

Human: nihao
AI: model, <think>用户说"nihao"，这是一个简单的问候。我应该简洁地回应。
</think>

你好！有什么我可以帮你的吗？
Human: 帮我查一下 src/main/ipc/agent.ts
AI: model, <think>
用户想查看一个 TypeScript 文件，我需要使用 read_file 工具来读取这个文件。
</think>


[{"name":"read_file","args":{"file_path":"/Users/heyirui/Desktop/cmbCowork/src/main/ipc/agent.ts","offset":0,"limit":200},"id":"call_function_1ahyt6uo4px6_1","type":"tool_call"}]
Tool: read_file, [Lines 1-199 of 1752. Use offset=199 to read more.]
     1	import { IpcMain, BrowserWindow } from "electron"
     2	import { HumanMessage, SystemMessage } from "@langchain/core/messages"
     3	import { Command } from "@langchain/langgraph"
     4	import {
     5	  createAgentRuntime,
     6	  getSkillEvolutionThreshold
     7	} from "../agent/runtime"
     8	import { getThread } from "../db"
     9	import { summarizeAndSave } from "../memory/summarizer"
    10	import { getMemoryStore } from "../memory/store"
    11	import { ChatOpenAI } from "@langchain/openai"
    12	import {
    13	  getCustomModelConfigs,
    14	  isMemoryEnabled,
    15	  getCustomSkillsDir,
    16	  invalidateEnabledSkillsCache,
    17	  isOnlineSkillEvolutionEnabled,
    18	  isSkillAutoProposeEnabled,
    19	  getGlobalRoutingMode
    20	} from "../storage"
    21	import { resolveModel, rememberRoutingDecision, rememberRoutingFeedback, setFailoverSticky } from "../routing"
    22	import { notifyIfBackground, stripThink } from "../services/notify"
    23	import { trySendChatXReply } from "../services/chatx"
    24	import { TraceCollector } from "../agent/trace/collector"
    25	import {
    26	  requestSkillIntent,
    27	  requestSkillConfirmation,
    28	  sanitizeSkillId
    29	} from "../agent/tools/skill-evolution-tool"
    30	import { mkdirSync, writeFileSync } from "fs"
    31	import { join } from "path"
    32	import { v4 as uuid } from "uuid"
    33	import { LocalSandbox } from "../agent/local-sandbox"
    34	import { SkillUsageDetector } from "../agent/skill-evolution/usage-detector"
    35	import { ToolCallCounter } from "../agent/skill-evolution/tool-call-counter"
    36	import {
    37	  resetSkillEvolutionSession,
    38	  shouldResetSkillEvolutionSessionAfterIntent
    39	} from "../agent/skill-evolution/session-state"
    40	import {
    41	  appendSkillProposalWindowTurn,
    42	  buildSkillProposalWindowContext,
    43	  snapshotSkillProposalWindow,
    44	  isSkillProposalWindowContext,
    45	  type SkillProposalWindowContext
    46	} from "../agent/skill-evolution/proposal-window"
    47	import {
    48	  buildWorthinessPrompt,
    49	  getSkillProposalMode,
    50	  parseWorthinessResponse,
    51	  parseSkillProposal,
    52	  shouldEvaluateSkillProposalWindow,
    53	  shouldJudgeSkillWorthiness,
    54	  shouldProposeSkill,
    55	  type SkillProposal,
    56	  type WorthinessResult
    57	} from "../agent/skill-evolution/skill-proposal-logic"
    58	import {
    59	  isRetryableApiError,
    60	  buildOrderedChain,
    61	  type FailoverAttempt
    62	} from "../agent/failover"
    63	import type {
    64	  AgentInvokeParams,
    65	  AgentResumeParams,
    66	  AgentInterruptParams,
    67	  AgentCancelParams
    68	} from "../types"
    69	
    70	const MIN_CHARS_FOR_MEMORY = 200
    71	
    72	// Track active runs for cancellation
    73	const activeRuns = new Map<string, AbortController>()
    74	
    75	// ─────────────────────────────────────────────────────────
    76	// Auto skill proposal: generate a skill from conversation context
    77	// ─────────────────────────────────────────────────────────
    78	
    79	
    80	const SKILL_PROPOSAL_SYSTEM_PROMPT = `You are an expert at capturing reusable agent skills from conversation history.
    81	
    82	Given a conversation between a user and an AI agent, your job is to extract a GENERALIZED, reusable skill.
    83	Your primary task is to identify the underlying repeatable WORKFLOW or METHOD — not to describe the specific task instance.
    84	Strip out all one-off details (file names, component names, specific bug descriptions, exact error messages, ticket IDs) and abstract to the task family.
    85	
    86	Output ONLY valid JSON (no markdown, no explanation) with this exact shape:
    87	{
    88	  "name": "Short Human-Readable Name (3-6 words)",
    89	  "skillId": "snake_case_identifier",
    90	  "description": "One sentence: WHEN should this skill be loaded? Describe the recurring task pattern, not the one-off artifact.",
    91	  "content": "Full SKILL.md content (including YAML frontmatter)"
    92	}
    93	
    94	SKILL.md format:
    95	---
    96	name: skill-name
    97	description: Trigger description
    98	version: 1.0.0
    99	---
   100	
   101	# Overview
   102	Brief description of the generalized workflow.
   103	
   104	## When to use
   105	Recurring trigger patterns and task families.
   106	
   107	## Steps / Guidelines
   108	Concrete, generalizable instructions the agent should follow.
   109	
   110	Generalization rules (CRITICAL — read carefully):
   111	Target the right abstraction level — not too narrow, not too broad:
   112	- TOO NARROW (bad):  "当用户要找 ChatContainer.tsx 里的 null pointer bug 时" — single file + single bug
   113	- TOO BROAD (bad):   "当用户遇到任何代码问题时" — no useful specificity
   114	- JUST RIGHT (good): "当用户要系统排查 React 组件的渲染或状态类 bug 时" — task family with clear domain boundary
   115	
   116	More examples:
   117	- BAD name:  "Fix ChatContainer Null Pointer Bug" | GOOD name: "React Component Bug Investigation"
   118	- BAD steps: "1. Open ChatContainer.tsx 2. Check line 47" | GOOD steps: "1. Identify component boundary 2. Check state/prop flow"
   119	- BAD trigger: "用户说 ChatContainer 崩溃" | GOOD trigger: "用户要排查 React 组件异常行为"
   120	
   121	What to keep vs. strip:
   122	- STRIP: specific file names, component names, exact error strings, line numbers, ticket IDs, one-off data values
   123	- KEEP: framework names (React, Electron), patterns (IPC, state management), domain types (bug investigation, deployment, refactor)
   124	- A skill scoped to a stable tool/framework (e.g. "Electron IPC debugging") is valid and reusable — don't over-generalize it to "any debugging"
   125	
   126	Steps should describe the METHOD (how to approach the problem class), not the SOLUTION to this specific instance.
   127	If the conversation is narrow, lift it one level: "how we fixed X" → "systematic approach to X-type problems".
   128	
   129	Other rules:
   130	- description is the MOST important field — it controls when the skill is injected in future sessions
   131	- Output ONLY valid JSON, no other text`
   132	
   133	/**
   134	 * Broadcast a skill generation progress event to all renderer windows.
   135	 * `phase`:
   136	 *   "start"    — generation beginning (clears previous output)
   137	 *   "token"    — incremental token chunk
   138	 *   "done"     — generation complete, full raw text in `text`
   139	 *   "error"    — generation failed
   140	 */
   141	function emitSkillGenerating(
   142	  threadId: string,
   143	  phase: "start" | "token" | "done" | "error",
   144	  text = ""
   145	): void {
   146	  for (const win of BrowserWindow.getAllWindows()) {
   147	    win.webContents.send("skill:generating", { threadId, phase, text })
   148	  }
   149	}
   150	
   151	/**
   152	 * Ask the LLM whether this conversation is worth saving as a skill.
   153	 * Called unconditionally for every threshold-passing conversation.
   154	 * Returns true if worthy, false if not (or if no model / parse error).
   155	 */
   156	async function judgeSkillWorthiness(
   157	  threadId: string,
   158	  context: SkillProposalWindowContext
   159	): Promise<WorthinessResult | null> {
   160	  const configs = getCustomModelConfigs()
   161	  const config = configs[0]
   162	  if (!config?.apiKey) {
   163	    console.log(`[SkillEvolution][${threadId}] Worthiness LLM skipped: missing model config or API key`)
   164	    return null
   165	  }
   166	
   167	  const model = new ChatOpenAI({
   168	    model: config.model,
   169	    apiKey: config.apiKey,
   170	    configuration: { baseURL: config.baseUrl },
   171	    maxTokens: 1024,
   172	    temperature: 0
   173	  })
   174	
   175	  const userPrompt = `## Conversation window since last skill-evolution reset (${context.turnCount} turns)
   176	${context.transcript.slice(0, 3200)}
   177	
   178	## Tools used (${context.toolCallCount} total)
   179	${context.toolCallSummary}
   180	
   181	Is this conversation worth saving as a reusable skill?`
   182	
   183	  try {
   184	    console.log(`[SkillEvolution][${threadId}] Worthiness LLM invoke start ${JSON.stringify({
   185	      toolCallCount: context.toolCallCount,
   186	      threshold: getSkillEvolutionThreshold(),
   187	      turnCount: context.turnCount,
   188	      errorCount: context.errorCount,
   189	      toolCallSummary: context.toolCallSummary
   190	    })}`)
   191	    const response = await model.invoke([
   192	      new SystemMessage(buildWorthinessPrompt(context.toolCallCount, getSkillEvolutionThreshold())),
   193	      new HumanMessage(userPrompt)
   194	    ])
   195	    const raw = typeof response.content === "string" ? response.content : ""
   196	    console.log(`[SkillEvolution][${threadId}] Worthiness LLM raw ${JSON.stringify({
   197	      preview: raw.slice(0, 400)
   198	    })}`)
   199	    const result = parseWorthinessResponse(raw)
AI: model, <think>
文件有 1752 行，我只读取了前 200 行。用户可能想看整个文件或者只是要了解文件内容。让我问一下用户是否需要读取更多，或者直接展示更多内容。

实际上，由于这是一个相对较大的文件（1752行），我应该问用户想要看哪部分，或者直接提供文件的概览。不过用户只是说"帮我查一下"，可能只是想了解文件内容。我已经读取了前200行，可以给用户一个总结，并问是否需要看更多。
</think>

文件共 **1752 行**，这是前 200 行内容概览：

**主要功能：**
- Electron IPC 主进程处理（IpcMain）
- Agent 运行时集成（LangChain/LangGraph）
- **技能进化（Skill Evolution）**：从对话历史自动生成可复用技能
  - 技能价值判断（judgeSkillWorthiness）
  - 技能提案窗口（SkillProposalWindowContext）
  - 技能生成与发布流程

**核心模块：**
- `createAgentRuntime` - Agent 运行时
- `summarizeAndSave` - 记忆摘要
- 路由管理（routing）
- 故障转移（failover）
- 本地沙箱（LocalSandbox）

需要看哪部分内容？我可以：
1. 继续读取后面的部分（如具体的 IPC handler 实现）
2. 搜索特定关键词
3. 只读某个函数
Human: 好的非常好
Human: 好的非常好
Human: 好的非常好
AI: model, 
Human: 好的非常好
Human: 继续
Human: 好的非常好
Human: 好的
AI: model, <think>
用户说"好的"、"继续"，看起来是确认我之前的内容可以，想要我继续读取更多内容。让我继续读取 agent.ts 的后续部分。
</think>

继续读 agent.ts 后续内容：
[{"name":"read_file","args":{"file_path":"/Users/heyirui/Desktop/cmbCowork/src/main/ipc/agent.ts","offset":199,"limit":300},"id":"call_function_ee6rrz5grkyx_1","type":"tool_call"}]
Tool: read_file, [Lines 200-498 of 1756. Use offset=498 to read more.]
   200	    if (!result) {
   201	      console.warn(`[SkillEvolution][${threadId}] Failed to parse worthiness response:`, raw.slice(0, 200))
   202	      return null
   203	    }
   204	    console.log(`[SkillEvolution][${threadId}] Worthiness LLM invoke done ${JSON.stringify({
   205	      worthy: result.worthy,
   206	      reason: result.reason
   207	    })}`)
   208	    return result
   209	  } catch (e) {
   210	    console.warn(`[SkillEvolution][${threadId}] Failed to judge worthiness:`, e)
   211	    return null
   212	  }
   213	}
   214	
   215	/**
   216	 * Use the default configured LLM to generate a skill proposal from the
   217	 * given conversation context.  Streams tokens to the renderer via
   218	 * `skill:generating` events so the user can see progress in real time.
   219	 * Returns null if no model is configured or the LLM response cannot be parsed.
   220	 */
   221	async function generateSkillProposal(
   222	  threadId: string,
   223	  context: SkillProposalWindowContext
   224	): Promise<SkillProposal | null> {
   225	  // Always emit "start" first so the renderer card resets to generating state,
   226	  // both on the initial run and on manual retry.
   227	  emitSkillGenerating(threadId, "start")
   228	
   229	  const configs = getCustomModelConfigs()
   230	  const config = configs[0]
   231	  if (!config?.apiKey) {
   232	    emitSkillGenerating(threadId, "error", "未配置模型或 API Key，无法生成技能草稿")
   233	    return null
   234	  }
   235	
   236	  const userPrompt = `# Conversation window to analyze
   237	
   238	## Transcript (${context.turnCount} turns)
   239	${context.transcript.slice(0, 4000)}
   240	
   241	## Tools used (${context.toolCallCount} total)
   242	${context.toolCallSummary}
   243	
   244	Based on this conversation, generate a reusable skill. Output JSON only.`
   245	
   246	  try {
   247	    const model = new ChatOpenAI({
   248	      model: config.model,
   249	      apiKey: config.apiKey,
   250	      configuration: { baseURL: config.baseUrl },
   251	      maxTokens: 2048,
   252	      temperature: 0.3,
   253	      streaming: true
   254	    })
   255	
   256	    // Per-token idle timeout: if no new chunk arrives within this window the
   257	    // internal model has likely stalled mid-stream without closing the connection.
   258	    const TOKEN_IDLE_TIMEOUT_MS = 60_000
   259	
   260	    const abortController = new AbortController()
   261	    let timedOut = false
   262	    let idleTimer = setTimeout(() => {
   263	      timedOut = true
   264	      abortController.abort()
   265	    }, TOKEN_IDLE_TIMEOUT_MS)
   266	    const resetIdleTimer = (): void => {
   267	      clearTimeout(idleTimer)
   268	      idleTimer = setTimeout(() => {
   269	        timedOut = true
   270	        abortController.abort()
   271	      }, TOKEN_IDLE_TIMEOUT_MS)
   272	    }
   273	
   274	    let fullText = ""
   275	    const stream = await model.stream(
   276	      [new SystemMessage(SKILL_PROPOSAL_SYSTEM_PROMPT), new HumanMessage(userPrompt)],
   277	      { signal: abortController.signal }
   278	    )
   279	
   280	    try {
   281	      for await (const chunk of stream) {
   282	        resetIdleTimer()
   283	        const token = typeof chunk.content === "string" ? chunk.content : ""
   284	        if (token) {
   285	          fullText += token
   286	          emitSkillGenerating(threadId, "token", token)
   287	        }
   288	      }
   289	    } catch (streamErr) {
   290	      clearTimeout(idleTimer)
   291	      if (timedOut) {
   292	        throw new Error(`技能草稿生成超时（${TOKEN_IDLE_TIMEOUT_MS / 1000}s 内无新内容），请点击重试`)
   293	      }
   294	      throw streamErr
   295	    }
   296	    clearTimeout(idleTimer)
   297	
   298	    emitSkillGenerating(threadId, "done", fullText)
   299	
   300	    // Strip <think>...</think> reasoning blocks and markdown fences, then parse JSON
   301	    const proposal = parseSkillProposal(fullText)
   302	    if (!proposal) {
   303	      console.warn("[Agent] Failed to parse skill proposal JSON")
   304	      // Emit error so the renderer card transitions out of "generating" state
   305	      emitSkillGenerating(threadId, "error", "技能草稿解析失败，请重试")
   306	      return null
   307	    }
   308	    return proposal
   309	  } catch (e) {
   310	    console.warn("[Agent] Failed to generate skill proposal:", e)
   311	    emitSkillGenerating(threadId, "error", e instanceof Error ? e.message : String(e))
   312	    return null
   313	  }
   314	}
   315	
   316	/**
   317	 * Write an approved skill proposal to disk and notify the renderer.
   318	 */
   319	async function writeSkillToDisk(skillId: string, content: string, name: string): Promise<void> {
   320	  const skillDir = join(getCustomSkillsDir(), skillId)
   321	  mkdirSync(skillDir, { recursive: true })
   322	  writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8")
   323	  invalidateEnabledSkillsCache()
   324	  for (const win of BrowserWindow.getAllWindows()) {
   325	    win.webContents.send("skills:changed")
   326	  }
   327	  console.log(`[Agent] Wrote skill "${name}" to ${skillDir}`)
   328	}
   329	
   330	/**
   331	 * Show the detail confirm dialog and, on adoption, write the skill to disk.
   332	 * Extracted so it can be shared between the normal flow and manual retry.
   333	 */
   334	async function confirmAndWriteSkillProposal(
   335	  threadId: string,
   336	  proposal: SkillProposal
   337	): Promise<void> {
   338	  const skillId = sanitizeSkillId(proposal.skillId || proposal.name)
   339	  if (!skillId) return
   340	
   341	  const confirmId = uuid()
   342	  const adopted = await requestSkillConfirmation({
   343	    threadId,
   344	    requestId: confirmId,
   345	    skillId,
   346	    name: proposal.name,
   347	    description: proposal.description,
   348	    content: proposal.content
   349	  })
   350	
   351	  if (!adopted) {
   352	    console.log(`[Agent][${threadId}] User rejected skill detail for "${proposal.name}"`)
   353	    return
   354	  }
   355	
   356	  await writeSkillToDisk(skillId, proposal.content, proposal.name)
   357	}
   358	
   359	/**
   360	 * Shared tail of the skill proposal flow (used by both modes):
   361	 *   1. Ask user intent via banner
   362	 *   2. On yes → LLM generates skill (streaming)
   363	 *   3. Show detail confirm dialog
   364	 *   4. On adopt → write to disk
   365	 */
   366	async function runSkillProposalFlow(
   367	  threadId: string,
   368	  context: SkillProposalWindowContext,
   369	  intentMode: "mode_a_rule" | "mode_b_llm",
   370	  recommendationReason?: string
   371	): Promise<void> {
   372	  const latestUserMessage = context.turns[context.turns.length - 1]?.userMessage ?? context.transcript
   373	
   374	  // Step 1 — Intent banner: ask user whether they want to save as a skill.
   375	  // We include the proposal context so the renderer can cache it for manual retry.
   376	  const intentId = uuid()
   377	  const wantsSkill = await requestSkillIntent({
   378	    threadId,
   379	    requestId: intentId,
   380	    summary: latestUserMessage.slice(0, 120),
   381	    toolCallCount: context.toolCallCount,
   382	    mode: intentMode,
   383	    recommendationReason,
   384	    context
   385	  })
   386	
   387	  if (shouldResetSkillEvolutionSessionAfterIntent(wantsSkill ? "accept" : "skip")) {
   388	    resetSkillEvolutionSession(threadId)
   389	  }
   390	
   391	  if (!wantsSkill) {
   392	    console.log(`[Agent][${threadId}] User declined skill intent`)
   393	    return
   394	  }
   395	
   396	  // Step 2 — LLM generates skill draft (streaming, visible in right panel)
   397	  // generateSkillProposal() is responsible for emitting skill:generating events
   398	  // (including the terminal "error" event) before returning null, so the renderer
   399	  // card will always transition to a final state.
   400	  console.log(`[Agent][${threadId}] User confirmed intent, generating skill proposal…`)
   401	  const proposal = await generateSkillProposal(threadId, context)
   402	  if (!proposal) {
   403	    console.log(`[Agent][${threadId}] Could not generate skill proposal (no model or parse error)`)
   404	    return
   405	  }
   406	
   407	  // Step 3+4 — Detail confirm dialog → write to disk
   408	  await confirmAndWriteSkillProposal(threadId, proposal)
   409	}
   410	
   411	/**
   412	 * After a conversation meets the tool-call threshold, decide whether to
   413	 * propose a skill and, if so, run the shared proposal flow.
   414	 *
   415	 * Mode A (toggle ON):
   416	 *   threshold reached -> enter proposal flow directly
   417	 *
   418	 * Mode B (toggle OFF):
   419	 *   threshold reached -> ask worthiness LLM -> only continue when worthy=true
   420	 *
   421	 * Both modes then share the same user-facing flow:
   422	 *   Intent Banner → LLM generates draft → Detail confirm → Write to disk
   423	 */
   424	async function autoProposeSKill(
   425	  threadId: string,
   426	  context: SkillProposalWindowContext
   427	): Promise<void> {
   428	  const autoProposeEnabled = isSkillAutoProposeEnabled()
   429	  const mode = getSkillProposalMode(autoProposeEnabled)
   430	
   431	  console.log(`[SkillEvolution][${threadId}] Decision start ${JSON.stringify({
   432	    mode,
   433	    toolCallCount: context.toolCallCount,
   434	    turnCount: context.turnCount,
   435	    errorCount: context.errorCount,
   436	    toolCallSummary: context.toolCallSummary
   437	  })}`)
   438	
   439	  let llmWorthy = false
   440	  let worthinessReason: string | undefined
   441	  if (shouldJudgeSkillWorthiness(mode)) {
   442	    const worthiness = await judgeSkillWorthiness(threadId, context)
   443	    llmWorthy = worthiness?.worthy ?? false
   444	    worthinessReason = worthiness?.reason
   445	  } else {
   446	    console.log(`[SkillEvolution][${threadId}] Mode A selected, skipping worthiness LLM`)
   447	  }
   448	
   449	  const shouldPropose = shouldProposeSkill(mode, llmWorthy)
   450	
   451	  if (!shouldPropose) {
   452	    console.log(`[SkillEvolution][${threadId}] Decision skip ${JSON.stringify({
   453	      mode,
   454	      llmWorthy,
   455	      reason: "proposal_flow_not_triggered"
   456	    })}`)
   457	    return
   458	  }
   459	
   460	  console.log(`[SkillEvolution][${threadId}] Decision enter proposal flow ${JSON.stringify({
   461	    mode,
   462	    llmWorthy,
   463	    toolCallCount: context.toolCallCount,
   464	    turnCount: context.turnCount
   465	  })}`)
   466	  await runSkillProposalFlow(threadId, context, mode, worthinessReason)
   467	}
   468	
   469	
   470	export function registerAgentHandlers(ipcMain: IpcMain): void {
   471	  console.log("[Agent] Registering agent handlers...")
   472	
   473	  // Manual retry for skill generation — triggered when the user clicks the retry button
   474	  // in the right panel after a generation failure.  Skips the intent banner (user already
   475	  // accepted), jumps straight to generate → confirm → write.
   476	  ipcMain.handle(
   477	    "skill:retryGeneration",
   478	    async (_event, payload: { threadId: string; context: unknown; intentMode: string }) => {
   479	      const { threadId, context, intentMode } = payload
   480	
   481	      if (!threadId) return
   482	      if (!isSkillProposalWindowContext(context)) {
   483	        emitSkillGenerating(threadId, "error", "技能草稿上下文无效，请等待下次重新触发")
   484	        return
   485	      }
   486	      if (intentMode !== "mode_a_rule" && intentMode !== "mode_b_llm") {
   487	        emitSkillGenerating(threadId, "error", "技能触发模式无效，请等待下次重新触发")
   488	        return
   489	      }
   490	
   491	      console.log(`[SkillEvolution][${threadId}] Manual retry requested ${JSON.stringify({
   492	        intentMode,
   493	        toolCallCount: context.toolCallCount,
   494	        turnCount: context.turnCount
   495	      })}`)
   496	
   497	      try {
   498	        const proposal = await generateSkillProposal(threadId, context)
AI: model, <think>
让我继续读取更多内容，了解 IPC handlers 的实现。
</think>

继续：
[{"name":"read_file","args":{"file_path":"/Users/heyirui/Desktop/cmbCowork/src/main/ipc/agent.ts","offset":499,"limit":300},"id":"call_function_or0zg5k9tue4_1","type":"tool_call"}]
Tool: read_file, [Lines 500-798 of 1760. Use offset=798 to read more.]
   500	        await confirmAndWriteSkillProposal(threadId, proposal)
   501	      } catch (e) {
   502	        console.warn(`[SkillEvolution][${threadId}] Retry flow failed:`, e)
   503	        emitSkillGenerating(threadId, "error", e instanceof Error ? e.message : String(e))
   504	      }
   505	    }
   506	  )
   507	
   508	  // Handle agent invocation with streaming
   509	  ipcMain.on("agent:invoke", async (event, { threadId, message, modelId }: AgentInvokeParams) => {
   510	    const channel = `agent:stream:${threadId}`
   511	    const window = BrowserWindow.fromWebContents(event.sender)
   512	
   513	    console.log("[Agent] Received invoke request:", {
   514	      threadId,
   515	      message: message.substring(0, 50),
   516	      modelId
   517	    })
   518	
   519	    if (!window) {
   520	      console.error("[Agent] No window found")
   521	      return
   522	    }
   523	
   524	    // Abort any existing stream for this thread before starting a new one
   525	    // This prevents concurrent streams which can cause checkpoint corruption
   526	    const existingController = activeRuns.get(threadId)
   527	    if (existingController) {
   528	      console.log("[Agent] Aborting existing stream for thread:", threadId)
   529	      existingController.abort()
   530	      activeRuns.delete(threadId)
   531	    }
   532	
   533	    const abortController = new AbortController()
   534	    activeRuns.set(threadId, abortController)
   535	
   536	    // Abort the stream if the window is closed/destroyed
   537	    const onWindowClosed = (): void => {
   538	      console.log("[Agent] Window closed, aborting stream for thread:", threadId)
   539	      abortController.abort()
   540	    }
   541	    window.once("closed", onWindowClosed)
   542	
   543	    // Start trace collection for this invocation (modelId resolved later)
   544	    const tracer = new TraceCollector(threadId, message, modelId ?? "unknown")
   545	    const skillUsageDetector = new SkillUsageDetector()
   546	    const toolCallCounter = new ToolCallCounter()
   547	    let assistantText = ""
   548	
   549	    const appendTurnToProposalWindow = (
   550	      status: "success" | "error",
   551	      errorMessage?: string
   552	    ): SkillProposalWindowContext => {
   553	      appendSkillProposalWindowTurn(threadId, {
   554	        userMessage: message,
   555	        assistantText,
   556	        toolCallNames: toolCallCounter.getNames(),
   557	        toolCallCount: toolCallCounter.getCount(),
   558	        status,
   559	        errorMessage,
   560	        usedSkills: skillUsageDetector.getUsedSkillNames(),
   561	        finishedAt: new Date().toISOString()
   562	      })
   563	
   564	      const context = buildSkillProposalWindowContext(snapshotSkillProposalWindow(threadId))
   565	      console.log(`[SkillEvolution][${threadId}] Window append ${JSON.stringify({
   566	        status,
   567	        currentTurnToolCallCount: toolCallCounter.getCount(),
   568	        windowTurnCount: context.turnCount,
   569	        windowToolCallCount: context.toolCallCount,
   570	        usedSkills: context.usedSkills
   571	      })}`)
   572	      return context
   573	    }
   574	
   575	    // Hoisted so catch block can access them for routing feedback
   576	    let invokeRoutingResult: Awaited<ReturnType<typeof resolveModel>> | null = null
   577	    let toolErrorCount = 0
   578	    // High-water mark of input tokens — hoisted for catch/finally access
   579	    let highWaterInputTokens = 0
   580	    // Actual model used after failover — hoisted for catch/finally routing feedback
   581	    let usedModelId: string | undefined
   582	
   583	    try {
   584	      // Get workspace path from thread metadata - REQUIRED
   585	      const thread = getThread(threadId)
   586	      let metadata: Record<string, unknown> = {}
   587	      if (thread?.metadata) {
   588	        try {
   589	          metadata = JSON.parse(thread.metadata)
   590	        } catch {
   591	          console.warn("[Agent] Failed to parse thread metadata, using empty object")
   592	        }
   593	      }
   594	      console.log("[Agent] Thread metadata:", metadata)
   595	
   596	      const workspacePath = metadata.workspacePath as string | undefined
   597	
   598	      if (!workspacePath) {
   599	        window.webContents.send(channel, {
   600	          type: "error",
   601	          error: "WORKSPACE_REQUIRED",
   602	          message: "Please select a workspace folder before sending messages."
   603	        })
   604	        await tracer.finish("error", "WORKSPACE_REQUIRED")
   605	        return
   606	      }
   607	
   608	      // Sync FTS index with any memory files changed since last invocation
   609	      if (isMemoryEnabled()) {
   610	        try {
   611	          const memoryStore = await getMemoryStore()
   612	          memoryStore.syncMemoryFiles()
   613	        } catch { /* non-critical */ }
   614	      }
   615	
   616	      const requestedModelId = modelId || (metadata.model as string | undefined)
   617	      invokeRoutingResult = await resolveModel({
   618	        taskSource: "chat",
   619	        message,
   620	        threadId,
   621	        requestedModelId,
   622	        routingMode: getGlobalRoutingMode()
   623	      }).catch(() => null)
   624	      let effectiveModelId = invokeRoutingResult?.resolvedModelId ?? requestedModelId
   625	
   626	      // Persist routing decision for thread continuity (sticky/force logic next turn)
   627	      if (invokeRoutingResult) rememberRoutingDecision(threadId, invokeRoutingResult)
   628	
   629	      // Attach routing funnel record to trace (setRoutingTrace is internally safe, never throws)
   630	      if (invokeRoutingResult?.routingTrace) {
   631	        tracer.setRoutingTrace(invokeRoutingResult.routingTrace)
   632	      }
   633	
   634	      // Emit routing result so the frontend can display which model was selected
   635	      if (invokeRoutingResult) {
   636	        window.webContents.send(channel, {
   637	          type: "custom",
   638	          data: {
   639	            type: "routing_result",
   640	            resolvedModelId: invokeRoutingResult.resolvedModelId,
   641	            resolvedTier: invokeRoutingResult.resolvedTier,
   642	            routeReason: invokeRoutingResult.routeReason
   643	          }
   644	        })
   645	      }
   646	
   647	      const humanMessage = new HumanMessage(message)
   648	      const streamConfig = {
   649	        configurable: { thread_id: threadId },
   650	        signal: abortController.signal,
   651	        streamMode: ["messages", "values"] as ("messages" | "values")[],
   652	        recursionLimit: 1000
   653	      }
   654	
   655	      // ── Failover loop: try models in order, resume from checkpoint on retryable errors ──
   656	      const primaryTier = invokeRoutingResult?.resolvedTier ?? "premium"
   657	      const orderedChain = buildOrderedChain(effectiveModelId, invokeRoutingResult?.fallbackChain, primaryTier)
   658	      const failoverAttempts: FailoverAttempt[] = []
   659	      usedModelId = effectiveModelId
   660	      let isFirstAttempt = true
   661	      let agent: Awaited<ReturnType<typeof createAgentRuntime>> | null = null
   662	      let stream: AsyncIterable<unknown> | null = null
   663	
   664	      for (const candidateId of orderedChain) {
   665	        if (abortController.signal.aborted) break
   666	        try {
   667	          agent = await createAgentRuntime({
   668	            threadId,
   669	            workspacePath,
   670	            modelId: candidateId,
   671	            abortSignal: abortController.signal,
   672	            noSkillEvolutionTool: true
   673	          })
   674	          // First attempt sends the message; subsequent attempts resume from checkpoint
   675	          const input = isFirstAttempt ? { messages: [humanMessage] } : null
   676	          stream = await agent.stream(input, streamConfig)
   677	          usedModelId = candidateId
   678	          break
   679	        } catch (err) {
   680	          if (!isRetryableApiError(err)) throw err
   681	          failoverAttempts.push({ modelId: candidateId, error: String(err), timestamp: Date.now() })
   682	          console.warn(`[Agent][Failover] ${candidateId} failed: ${err}, trying next...`)
   683	          // Keep isFirstAttempt=true: init-time errors (createAgentRuntime / agent.stream)
   684	          // happen before any graph tick, so HumanMessage is NOT yet checkpointed.
   685	          // Next candidate must still send { messages: [humanMessage] }.
   686	          if (!abortController.signal.aborted) {
   687	            await new Promise((r) => setTimeout(r, 500))
   688	          }
   689	        }
   690	      }
   691	
   692	      // P3: user cancellation during failover should not be reported as hard error
   693	      if (abortController.signal.aborted) {
   694	        // Fall through to outer abort handling
   695	        throw Object.assign(new Error("aborted"), { name: "AbortError" })
   696	      }
   697	
   698	      if (!stream || !agent) {
   699	        const allErrors = failoverAttempts.map((a) => `${a.modelId}: ${a.error}`).join("; ")
   700	        throw new Error(`All models failed: ${allErrors}`)
   701	      }
   702	
   703	      // Notify frontend if failover happened — update model display + context window
   704	      const notifyFailover = (): void => {
   705	        if (failoverAttempts.length > 0 && usedModelId !== effectiveModelId) {
   706	          const usedCfgId = usedModelId?.startsWith("custom:") ? usedModelId.slice("custom:".length) : usedModelId
   707	          const usedCfg = getCustomModelConfigs().find((c) => c.id === usedCfgId)
   708	          window.webContents.send(channel, {
   709	            type: "custom",
   710	            data: {
   711	              type: "routing_result",
   712	              resolvedModelId: usedModelId,
   713	              resolvedTier: usedCfg?.tier ?? "premium",
   714	              routeReason: `failover from ${failoverAttempts[0].modelId}`
   715	            }
   716	          })
   717	          window.webContents.send(channel, {
   718	            type: "custom",
   719	            data: { type: "model_failover", attempts: failoverAttempts, activeModelId: usedModelId }
   720	          })
   721	          // P2: persist failover model so resume/interrupt continuations use it
   722	          rememberRoutingDecision(threadId, {
   723	            resolvedModelId: usedModelId!,
   724	            resolvedTier: usedCfg?.tier ?? "premium",
   725	            routeReason: `failover from ${failoverAttempts[0].modelId}`,
   726	            fallbackChain: [],
   727	            layer: "pinned"
   728	          })
   729	          // Failover sticky is deferred until the turn completes successfully
   730	          // Update effectiveModelId for downstream trace/feedback
   731	          effectiveModelId = usedModelId
   732	        }
   733	      }
   734	      notifyFailover()
   735	
   736	      // Update tracer with resolved modelId.
   737	      // Set modelName from config.model (the real API model name, e.g. "MiniMax-M2.7") as an
   738	      // initial fallback — it will be overwritten later by the actual model name from the API
   739	      // response metadata once the first AI message arrives (see response_metadata.model_name below).
   740	      if (effectiveModelId) {
   741	        tracer.setModelId(effectiveModelId)
   742	        const cfgIdForName = effectiveModelId.startsWith("custom:")
   743	          ? effectiveModelId.slice("custom:".length)
   744	          : effectiveModelId
   745	        const cfgForName = getCustomModelConfigs().find((c) => c.id === cfgIdForName)
   746	        // Use config.model (the actual API model name) as fallback, not config.name (display label)
   747	        if (cfgForName?.model) tracer.setModelName(cfgForName.model)
   748	      }
   749	
   750	      // ── Tool-call extraction (tested in __tests__/tool-call-extraction.test.ts)
   751	      //
   752	      // "messages" mode delivers one [msgChunk, metadata?] tuple per LangGraph message.
   753	      // AI messages carry a complete tool_calls array even in streaming mode —
   754	      // confirmed by stream-converter.ts and unit tests.
   755	      //
   756	      // Deduplication: same AI message ID can appear in multiple chunks
   757	      // (e.g. once as AIMessageChunk, once as AIMessage in a values snapshot).
   758	      // We track seen IDs to count each unique tool invocation exactly once.
   759	      // ─────────────────────────────────────────────────────────────────────────
   760	
   761	      const _countedAiMsgIds = new Set<string>()
   762	      const _countedModelMsgIds = new Set<string>()
   763	      const _countedToolResultMsgIds = new Set<string>()
   764	      const _llmNodeByMessageId = new Map<string, string>()
   765	      const _toolNodeByRef = new Map<string, string>()
   766	      const MODEL_INPUT_WINDOW = 12
   767	      const MAX_TRACE_CONTENT = 2000
   768	
   769	      const trimContent = (s: string): string =>
   770	        s.length > MAX_TRACE_CONTENT ? `${s.slice(0, MAX_TRACE_CONTENT)}\n…(truncated)` : s
   771	
   772	      const normalizeMessageText = (s: string): string =>
   773	        s.replace(/\r\n/g, "\n").trim()
   774	
   775	      // Providers may surface usage as top-level `usage_metadata` or under
   776	      // `response_metadata.token_usage` / `response_metadata.usage`.
   777	      // Normalize all variants so trace capture and UI stay aligned.
   778	      // eslint-disable-next-line @typescript-eslint/no-explicit-any
   779	      const getUsageMetadata = (kwargs: any): unknown =>
   780	        kwargs?.usage_metadata ?? kwargs?.response_metadata?.token_usage ?? kwargs?.response_metadata?.usage
   781	
   782	      // eslint-disable-next-line @typescript-eslint/no-explicit-any
   783	      const extractText = (raw: any): string => {
   784	        if (typeof raw === "string") return trimContent(raw)
   785	        if (!Array.isArray(raw)) return ""
   786	        const text = raw
   787	          .map((b) => {
   788	            if (typeof b === "string") return b
   789	            if (!b || typeof b !== "object") return ""
   790	            if (typeof b.text === "string") return b.text
   791	            if (typeof b.content === "string") return b.content
   792	            return ""
   793	          })
   794	          .filter(Boolean)
   795	          .join("\n")
   796	        return trimContent(text)
   797	      }
   798	

