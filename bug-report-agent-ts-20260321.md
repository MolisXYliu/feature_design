# Bug 修复报告

**文件**: `src/main/ipc/agent.ts`
**日期**: 2026-03-21
**发现问题数**: 8 个

---

## BUG-001: 并发竞态条件 - activeRuns 未正确清理

**严重程度**: 🔴 严重

**问题描述**:
当外部调用 `agent:cancel` 时，可能在流结束但 `finally` 未执行时就删除 `activeRuns`，导致后续流程状态不一致。

### 修复方案

```typescript
// ❌ 修复前
const existingController = activeRuns.get(threadId)
if (existingController) {
  existingController.abort()
  activeRuns.delete(threadId)  // ← 问题所在
}

const abortController = new AbortController()
activeRuns.set(threadId, abortController)
```

```typescript
// ✅ 修复后
try {
  const existingController = activeRuns.get(threadId)
  if (existingController) {
    existingController.abort()
    // 不再立即删除，等待 finally 统一清理
  }

  const abortController = new AbortController()
  activeRuns.set(threadId, abortController)

  // ... 执行逻辑 ...
} finally {
  // 只删除自己设置的控制器
  if (activeRuns.get(threadId) === abortController) {
    activeRuns.delete(threadId)
  }
}
```

---

## BUG-002: 窗口关闭事件监听器未正确管理

**严重程度**: 🟡 中等

**问题描述**:
使用 `once("closed")` 看似安全，但如果窗口在 abort 之前关闭，事件会触发；之后若再次触发 close 事件，监听器仍可能被执行。

### 修复方案

```typescript
// ❌ 修复前
const onWindowClosed = (): void => {
  abortController.abort()
}
window.once("closed", onWindowClosed)
```

```typescript
// ✅ 修复后
const onWindowClosed = (): void => {
  console.log("[Agent] Window closed, aborting stream for thread:", threadId)
  abortController.abort()
}
window.once("closed", onWindowClosed)

try {
  // ... 执行逻辑 ...
} finally {
  window.removeListener("closed", onWindowClosed)
  activeRuns.delete(threadId)
}
```

---

## BUG-003: 工具调用去重逻辑不完整

**严重程度**: 🟡 中等

**问题描述**:
`messages` 模式和 `values` 模式各有一套去重集合 (`_countedAiMsgIds` 和 `_countedModelMsgIds`)，可能导致同一工具调用被重复计数。

### 修复方案

```typescript
// ❌ 修复前
const _countedAiMsgIds = new Set<string>()
const _countedModelMsgIds = new Set<string>()
const _countedToolResultMsgIds = new Set<string>()
```

```typescript
// ✅ 修复后
// 统一的消息 ID 去重集合
const _countedMessageIds = new Set<string>()
const _countedToolResultMsgIds = new Set<string>()
const _countedToolCallIds = new Set<string>()

// 辅助函数：检查并标记消息已处理
const markMessageProcessed = (msgId: string): boolean => {
  if (_countedMessageIds.has(msgId)) return false
  _countedMessageIds.add(msgId)
  return true
}

// 在两种模式中都使用统一的去重检查
// messages 模式:
if (msgId && !markMessageProcessed(msgId)) continue

// values 模式:
if (aiMsgId && !markMessageProcessed(aiMsgId)) continue
```

---

## BUG-004: read_file 工具参数名不一致

**严重程度**: 🔵 轻微

**问题描述**:
代码同时检查 `path` 和 `file_path` 两个参数名，说明接口设计不统一。

### 修复方案

```typescript
// ❌ 修复前
const readPathRaw =
  (typeof tc.args?.path === "string" && tc.args.path) ||
  (typeof tc.args?.file_path === "string" && tc.args.file_path) ||
  ""
```

```typescript
// ✅ 修复后
const readPathRaw = ((): string => {
  const filePath = typeof tc.args?.file_path === "string" ? tc.args.file_path : null
  const oldPath = typeof tc.args?.path === "string" ? tc.args.path : null

  // 兼容旧参数，但记录警告
  if (oldPath && !filePath) {
    console.warn(
      `[Agent] Tool 'read_file' 使用了旧参数 'path'，请迁移到 'file_path'. toolCallId=${tc?.id}`
    )
    return oldPath
  }
  return filePath ?? ""
})()
```

---

## BUG-005: interrupt 处理器缺少 Trace 收集

**严重程度**: 🟡 中等

**问题描述**:
当用户批准/拒绝中断后恢复执行时，没有追踪这个恢复过程，导致 Trace 数据不完整。

### 修复方案

```typescript
// ❌ 修复前 - agent.ts:1097
// 直接执行 agent.stream() 而没有追踪
const stream = await agent.stream(null, config)
```

```typescript
// ✅ 修复后
// 重新创建 tracer 来追踪恢复过程
const tracer = new TraceCollector(
  threadId,
  `[Resume after ${decision.type}]`,
  modelId ?? "unknown"
)

// 添加恢复节点到 trace
tracer.beginLlmNode({
  messageId: `interrupt-resume-${Date.now()}`,
  startedAt: new Date().toISOString(),
  input: [{ role: "system", content: `User decision: ${decision.type}` }],
  metadata: { type: "interrupt_resume", decision: decision.type }
})

// ... 执行流 ...

await tracer.finish("success")
```

---

## BUG-006: resume 处理器缺少工具调用追踪

**严重程度**: 🟡 中等

**问题描述**:
`resume` 流程中不会提取和记录工具调用，导致 Skill Evolution 和工具使用统计不准确。

### 修复方案

```typescript
// ❌ 修复前 - agent.ts:1023-1033
for await (const chunk of stream) {
  // 只做了简单的数据转发
  window.webContents.send(channel, { type: "stream", mode, data })
}
```

```typescript
// ✅ 修复后
// 在 resume 处理器中复用相同的工具追踪逻辑
const resumeTracer = new TraceCollector(threadId, "[Resume]", modelId ?? "unknown")
const skillUsageDetector = new SkillUsageDetector()
const toolCallCounter = new ToolCallCounter()

for await (const chunk of stream) {
  if (abortController.signal.aborted) break

  const [mode, data] = chunk as [unknown, unknown]
  const serialized = JSON.parse(JSON.stringify(data))

  // 复用 invoke 中的工具调用提取逻辑...
  // (提取 tool_calls, 记录到 tracer, 更新 skillUsageDetector)

  window.webContents.send(channel, { type: "stream", mode, data: serialized })
}

// 更新 skill evolution
if (isOnlineSkillEvolutionEnabled()) {
  // 同样触发 autoProposeSKill 检查
}
```

---

## BUG-007: 错误处理中的类型断言可能失败

**严重程度**: 🔵 轻微

**问题描述**:
用字符串匹配错误消息来判断是否中止错误不可靠，可能误判其他包含这些字符串的真实错误。

### 修复方案

```typescript
// ❌ 修复前
const isAbortError =
  error instanceof Error &&
  (error.name === "AbortError" ||
    error.message.includes("aborted") ||
    error.message.includes("Controller is already closed"))
```

```typescript
// ✅ 修复后
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  // 1. 直接检查 DOMException
  if (error instanceof DOMException && error.name === "AbortError") {
    return true
  }

  // 2. 检查错误类型名称
  if (error.name === "AbortError") return true

  // 3. 只在确定是 AbortError 类型时匹配简化字符串
  if (error.constructor.name === "AbortError") {
    return true
  }
  // 使用精确匹配而不是 includes
  const abortMessages = [
    "The operation was aborted",
    "Controller is already closed"
  ]
  return abortMessages.some(m => error.message === m)
}

// 使用
const isAbort = isAbortError(error)
```

---

## BUG-008: window 为 undefined 导致静默失败

**严重程度**: 🟡 中等

**问题描述**:
多个处理器的早期返回没有清理 `tracer` 等资源，可能导致内存泄漏或状态不一致。

### 修复方案

```typescript
// ❌ 修复前
if (!window) {
  console.error("[Agent] No window found")
  return  // ← 直接返回，没有清理资源
}
```

```typescript
// ✅ 修复后
let tracer: TraceCollector | null = null
let abortController: AbortController | null = null

// 统一清理函数
const cleanup = async (status?: string, message?: string) => {
  if (abortController) {
    const existing = activeRuns.get(threadId)
    if (existing === abortController) {
      activeRuns.delete(threadId)
    }
  }
  if (tracer) {
    await tracer.finish(status ?? "cancelled", message)
  }
}

try {
  tracer = new TraceCollector(threadId, message, modelId ?? "unknown")
  abortController = new AbortController()
  activeRuns.set(threadId, abortController)

  // 提前检查 window
  if (!window) {
    console.error("[Agent] No window found")
    await cleanup("error", "No window found")
    return
  }

  // ... 业务逻辑 ...
} finally {
  // 最终保护性清理
  await cleanup()
}
```

---

## 修复优先级总结

| Bug ID | 严重程度 | 问题 | 修复复杂度 |
|--------|----------|------|------------|
| BUG-001 | 🔴 严重 | 并发竞态条件 | 中等 |
| BUG-005 | 🟡 中等 | interrupt 缺少 Trace | 中等 |
| BUG-006 | 🟡 中等 | resume 缺少工具追踪 | 中等 |
| BUG-008 | 🟡 中等 | 资源未清理 | 简单 |
| BUG-002 | 🟡 中等 | 事件监听器管理 | 简单 |
| BUG-003 | 🟡 中等 | 去重逻辑不完整 | 简单 |
| BUG-004 | 🔵 轻微 | 参数名不一致 | 简单 |
| BUG-007 | 🔵 轻微 | 错误检测不可靠 | 简单 |

---

**报告生成于 2026-03-21 · CMB Cowork Agent**
