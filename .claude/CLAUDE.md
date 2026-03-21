# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start Electron app in development mode with hot reload
npm run build        # Build for production (output: out/)
npm run start        # Preview production build
npm run dist         # Build + package as distributable (all platforms)
npm run dist:mac     # Build + package for macOS (.dmg)
npm run dist:win     # Build + package for Windows (.exe)
npm run lint         # Run ESLint
npm run typecheck    # TypeScript check (both main + renderer)
npm run typecheck:node  # TypeScript check for main process only
npm run typecheck:web   # TypeScript check for renderer only
npm run format       # Format with Prettier
```

No test suite currently (Vitest is not yet configured). Type-check and lint before committing.

## Architecture Overview

This is a desktop AI Agent application built on **Electron 39 + electron-vite + React 19 + Zustand**.

### Process Separation

| Process | Entry | Role |
|---------|-------|------|
| Main | `src/main/index.ts` | Node.js runtime — agent execution, IPC handlers, file system, DB |
| Renderer | `src/renderer/src/main.tsx` | React UI |
| Preload | `src/preload/index.ts` | Security bridge — exposes `window.api` and `window.electron` |

The renderer communicates with main **exclusively** via IPC. The preload layer in `src/preload/index.ts` defines all available `window.api.*` methods. The TypeScript declarations live in `src/preload/index.d.ts`.

### Main Process Structure (`src/main/`)

- **`index.ts`** — Electron entry: window creation, IPC registration, app lifecycle
- **`storage.ts`** — All persistent configuration (API keys, settings, plugin metadata). App data lives in `~/.cmbcoworkagent/`. Key files: `.env` (API keys), `skill-evolution-settings.json`, `auto-propose-settings.json`
- **`types.ts`** — Shared types between main and renderer
- **`logging.ts`** — File-based logging to `~/.cmbcoworkagent/logs/`
- **`ipc/`** — IPC channel handlers (one file per domain: `agent.ts`, `threads.ts`, `models.ts`, `skills.ts`, `optimizer.ts`, `sandbox.ts`, `mcp.ts`, `plugins.ts`, `memory.ts`, `scheduled-tasks.ts`, `heartbeat.ts`, `git.ts`)
- **`agent/`** — Core agent execution
  - `runtime.ts` — LangGraph agent graph, model instantiation, tool registration
  - `system-prompt.ts` — System prompt construction
  - `stream-converter.ts` — Converts LangGraph stream events to renderer-consumable `StreamEvent`s
  - `local-sandbox.ts` — Shell command execution sandbox
  - `tools/` — Agent tools: `skill-evolution-tool.ts`, `scheduler-tool.ts`, `git-workflow-tool.ts`
  - `skill-evolution/` — Skill proposal pipeline: `skill-proposal-logic.ts`, `session-state.ts`, `tool-call-counter.ts`, `usage-detector.ts`, `proposal-window.ts`
  - `optimizer/` — Offline trace optimization: `skill-optimizer.ts`, `trace-optimizer-agent.ts`
  - `trace/` — Execution trace collection and tree building
- **`db/`** — SQLite via sql.js (`cmbcoworkagent.sqlite` for threads, `langgraph.sqlite` for LangGraph checkpoints)
- **`checkpointer/`** — Custom LangGraph checkpoint persister (SQLite-backed)
- **`memory/`** — Conversation memory management and summarization
- **`services/`** — Background services: `scheduler.ts`, `heartbeat.ts`, `workspace-watcher.ts`, `title-generator.ts`, `notify.ts`

### Renderer Structure (`src/renderer/src/`)

- **`App.tsx`** — Root layout: sidebar + main content area + overlay dialogs
- **`lib/store.ts`** — Zustand global store (threads, messages, UI state)
- **`lib/transport.ts`** — Wraps `window.api.agent.*` for streaming agent invocation
- **`components/chat/`** — Chat UI: message bubbles, tool call rendering, streaming display, HITL approval dialogs, workspace picker
- **`components/customize/`** — Settings panels mounted as tabs: `SkillsPanel`, `MarketPanel`, `PluginsPanel`, `McpPanel`, `EvolutionPanel`, `HeartbeatPanel`, `SchedulerPanel`, `MemoryPanel`
- **`components/sidebar/`** — `ThreadSidebar.tsx` — thread list with new/rename/delete, navigation to customize view
- **`components/tabs/`** — File viewer tabs: code, images, PDFs, media, binary
- **`components/ui/`** — shadcn/ui-style wrappers around Radix UI primitives

### IPC Convention

- `ipcMain.handle(channel, handler)` in `src/main/ipc/*.ts`
- `ipcRenderer.invoke(channel, ...args)` in `src/preload/index.ts`
- **Adding a new IPC method**: (1) add handler in `src/main/ipc/`, (2) register handler in `src/main/index.ts` (or the relevant IPC module's init), (3) expose via `src/preload/index.ts`, (4) add type declaration in `src/preload/index.d.ts`

### Skill Evolution System

The skill evolution pipeline auto-proposes skills from agent conversations:

1. `tool-call-counter.ts` counts tool calls per thread turn
2. When `turnToolCallCount >= getSkillEvolutionThreshold()` (default 15, stored in `skill-evolution-settings.json`):
   - **Mode A** (`autoPropose=true`): threshold reached → direct skill proposal flow, no LLM judgment
   - **Mode B** (`autoPropose=false`): threshold reached → LLM judges worthiness → proceed only if `worthy=true`
3. `skill-proposal-logic.ts` implements `shouldJudgeSkillWorthiness(mode)` and `shouldProposeSkill(mode, llmWorthy)`
4. The renderer listens for `skill:intentRequest` / `skill:confirmRequest` IPC events to show proposal UI

### Data Persistence

All user data is stored in `~/.cmbcoworkagent/`:
- `.env` — API keys
- `cmbcoworkagent.sqlite` — threads, messages
- `langgraph.sqlite` — LangGraph agent checkpoints (per-thread SQLite files in `threads/`)
- `logs/main.log`, `logs/renderer.log`
- Various JSON config files (skill evolution settings, sandbox settings, etc.)

### Technology Stack

- **Electron 39** + **electron-vite 5** (build tooling)
- **React 19** + **TypeScript 5** (renderer)
- **Zustand 5** (state management)
- **LangChain + LangGraph** (agent framework, multi-model support)
- **Radix UI** + **Tailwind CSS v4** (UI components/styling)
- **sql.js** (SQLite in Node.js)
- **electron-store** (simple key-value persistence)

### Path Aliases (renderer)

- `@/*` → `src/renderer/src/*`
- `@renderer/*` → `src/renderer/src/*`


## 编码原则

代码编写时请实现通用解法，禁止针对测试用例写死逻辑（hardcode）。代码必须对未知输入也正确，而不仅仅是通过当前测试。

## Core Instruction for CodeX MCP

在任何时刻，你必须思考当前过程可以如何与codex进行协作，如何调用Codex 为你提供的MCP工具作为你客观全面分析的保障。
其中你**务必执行**以下几个步骤：
**1** 在你对用户需求形成初步分析后，将用户需求、初始思路告知codex，并要求其完善需求分析和实施计划。
**2** 在实施具体编码任务前，**必须向codex索要代码实现原型（要求codex仅给出unified diff patch，严禁对代码做任何真实修改）**。在获取代码原型后，你**只能以此为逻辑参考，再次对代码修改进行重写**，形成企业生产级别、可读性极高、可维护性极高的代码后，才能实施具体编程修改任务。
**3** 无论何时，只要完成切实编码行为后，**必须立即使用codex review代码改动和对应需求完成程度**。
**4** codex只能给出参考，你**必须有自己的思考，甚至需要对codex的回答提出置疑**。尽信书则不如无书，你与codex的最终使命都是达成统一、全面、精准的意见，所以你们必须不断争辩已找到通向真理的唯一途径。


## Codex Tool Invocation Specification

 1. 工具概述

  codex MCP 提供了一个工具 `codex`，用于执行 AI 辅助的编码任务。该工具**通过 MCP 协议调用**，无需使用命令行。

  2. 工具参数

  **必选**参数：
  - PROMPT (string): 发送给 codex 的任务指令
  - cd (Path): codex 执行任务的工作目录根路径

  可选参数：
  - sandbox (string): 沙箱策略，可选值：
    - "read-only" (默认): 只读模式，最安全
    - "workspace-write": 允许在工作区写入
    - "danger-full-access": 完全访问权限
  - SESSION_ID (UUID | null): 用于继续之前的会话以与codex进行多轮交互，默认为 None（开启新会话）
  - skip_git_repo_check (boolean): 是否允许在非 Git 仓库中运行，默认 False
  - return_all_messages (boolean): 是否返回所有消息（包括推理、工具调用等），默认 False
  - image (List[Path] | null): 附加一个或多个图片文件到初始提示词，默认为 None
  - model (string | null): 指定使用的模型，默认为 None（使用用户默认配置）
  - yolo (boolean | null): 无需审批运行所有命令（跳过沙箱），默认 False
  - profile (string | null): 从 `~/.codex/config.toml` 加载的配置文件名称，默认为 None（使用用户默认配置）

  返回值：
  {
    "success": true,
    "SESSION_ID": "uuid-string",
    "agent_messages": "agent回复的文本内容",
    "all_messages": []  // 仅当 return_all_messages=True 时包含
  }
  或失败时：
  {
    "success": false,
    "error": "错误信息"
  }

  3. 使用方式

  开启新对话：
  - 不传 SESSION_ID 参数（或传 None）
  - 工具会返回新的 SESSION_ID 用于后续对话

  继续之前的对话：
  - 将之前返回的 SESSION_ID 作为参数传入
  - 同一会话的上下文会被保留

  4. 调用规范

  **必须遵守**：
  - 每次调用 codex 工具时，必须保存返回的 SESSION_ID，以便后续继续对话
  - cd 参数必须指向存在的目录，否则工具会静默失败
  - 严禁codex对代码进行实际修改，使用 sandbox="read-only" 以避免意外，并要求codex仅给出unified diff patch即可

  推荐用法：
  - 如需详细追踪 codex 的推理过程和工具调用，设置 return_all_messages=True
  - 对于精准定位、debug、代码原型快速编写等任务，优先使用 codex 工具

  5. 注意事项

  - 会话管理：始终追踪 SESSION_ID，避免会话混乱
  - 工作目录：确保 cd 参数指向正确且存在的目录
  - 错误处理：检查返回值的 success 字段，处理可能的错误

