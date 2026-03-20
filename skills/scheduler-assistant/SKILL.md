---
name: scheduler-assistant
description: 定时任务与心跳管理技能。当用户涉及提醒、定时任务、周期检查、心跳触发时使用此技能。支持一次性提醒和周期性任务的创建、查询、修改、删除。
---

# 定时任务与心跳管理

让 AI 帮用户在对话中设置、管理定时任务和心跳，无需离开对话去 UI 面板操作。

---

## AI 决策指南

### 时间确认规则

> 设置提醒前，先确认当前系统时间（查看上下文中的时间信息，或通过 execute 执行 `date` 命令）。
> 纯相对时间（"5分钟后"、"1小时后"）可以跳过确认，直接用当前时间 + 延迟计算 ISO 时间戳。
> 涉及具体日期或模糊时间（"明天下午"、"下周一"）时，先确认当前日期再计算。

### 用户意图识别

> **最重要的判断**：用户是想让 agent **做事**（执行型），还是只想被**提醒**（提醒型）？
> - 这决定了 `taskType` 字段的值：`"action"` 或 `"reminder"`
> - "提醒我喝水" → `taskType="reminder"`
> - "帮我修复明文密码" / "检查代码中的安全问题" / "扫描项目依赖" → `taskType="action"`
> - 判断标准：如果用户的请求包含"修复/检查/扫描/重构/部署/运行/构建/清理/替换/分析"等**动作动词**，就是 `"action"`
> - **拿不准时默认用 `"action"`**

| 用户说法 | 意图 | taskType | 关键参数 |
|----------|------|----------|----------|
| "5分钟后提醒我喝水" | 一次性提醒 | `"reminder"` | frequency=once, runAt=ISO时间戳 |
| "每天早上9点提醒我看邮件" | 周期提醒 | `"reminder"` | frequency=daily, runAtTime="09:00" |
| "帮我修复工作区的明文密码" | **执行型任务** | `"action"` | frequency=once/manual |
| "每天检查项目有没有安全漏洞" | **周期执行型** | `"action"` | frequency=daily, runAtTime |
| "每5分钟检查服务状态" | **高频执行型** | `"action"` | frequency=interval, intervalMinutes=5 |
| "每小时提醒我活动一下" | 周期提醒 | `"reminder"` | frequency=hourly |
| "工作日下午6点提醒我写日报" | 工作日提醒 | `"reminder"` | frequency=weekdays, runAtTime="18:00" |
| "扫描代码中的TODO并汇总" | **执行型任务** | `"action"` | frequency=once/manual |
| "每周一生成项目进度报告" | **周期执行型** | `"action"` | frequency=weekly, weekday=1 |
| "我有哪些定时任务" | 查询 | - | action=list |
| "取消/删除xx提醒" | 删除 | - | action=delete, 先 list 找 taskId |
| "暂停xx任务" | 禁用 | - | action=disable, taskId |
| "恢复xx任务" | 启用 | - | action=enable, taskId |
| "立即执行xx任务" | 手动触发 | - | action=run, taskId |
| "看看xx任务的执行记录" | 查看历史 | - | action=runs, taskId |
| "检查一下心跳" | 触发心跳 | - | action=wake |
| "看看调度器状态" | 查看状态 | - | action=status |
| "修改xx提醒的时间" | 更新 | - | action=update, taskId + 修改字段 |

### 必须追问的情况

1. **没有时间**："提醒我喝水" -> "请问什么时候提醒你？比如5分钟后、每天早上9点等"
2. **时间模糊**："晚点提醒我" -> "具体几点呢？或者多久之后？"
3. **周期不明**："定期提醒我" -> "多久一次？每天？每周？每小时？"
4. **提醒内容不明**：只说了时间没说做什么 -> "需要提醒你什么事情？"

---

## manage_scheduler 工具调用模板

> ⚠️ **`taskType` 字段是必填的**——它决定 prompt 如何处理：
> - `taskType="action"`：prompt 原样发给 agent 执行
> - `taskType="reminder"`：prompt 只需填提醒内容，系统自动包装暖心模板

### 执行型任务示例（taskType="action"）

**一次性执行——修复明文密码**：
```json
{
  "action": "create",
  "taskType": "action",
  "name": "明文密码修复",
  "description": "扫描并修复工作区中的明文密码",
  "prompt": "请扫描 D:\\git\\lf39.031\\LF39.18_WE 目录下所有源码文件，找出硬编码的明文密码（如数据库连接字符串中的 password=xxx、配置文件中的密钥等）。对于每个发现的明文密码：\n1. 将其替换为环境变量引用或加密配置\n2. 记录修改的文件和行号\n3. 最后输出修改摘要",
  "frequency": "once",
  "runAt": "2026-03-08T23:35:00+08:00"
}
```

**每日执行——安全检查**：
```json
{
  "action": "create",
  "taskType": "action",
  "name": "每日安全检查",
  "description": "每天早上9点检查项目安全问题",
  "prompt": "请对 ~/projects/myapp 执行安全检查：\n1. 扫描源码中是否有硬编码的密钥、token 或密码\n2. 检查是否有不安全的 HTTP 调用\n3. 输出安全检查报告，列出发现的问题和建议修复方案",
  "frequency": "daily",
  "runAtTime": "09:00"
}
```

**分钟级执行——每5分钟检查服务**：
```json
{
  "action": "create",
  "taskType": "action",
  "name": "服务状态检查",
  "description": "每5分钟检查服务是否正常运行",
  "prompt": "请检查 ~/projects/myapp 的服务状态：\n1. 执行 curl http://localhost:3000/health 检查健康接口\n2. 如果服务未响应或返回错误，输出详细错误信息\n3. 输出检查结果摘要",
  "frequency": "interval",
  "intervalMinutes": 5
}
```

**每周执行——项目报告**：
```json
{
  "action": "create",
  "taskType": "action",
  "name": "周报生成",
  "description": "每周一生成项目进度报告",
  "prompt": "请分析 ~/projects/myapp 目录下最近一周的 git log，生成项目进度报告：\n1. 本周新增的 commit 数量和主要变更\n2. 活跃的开发分支\n3. TODO.md 中的待办事项完成情况\n以 markdown 格式输出报告。",
  "frequency": "weekly",
  "runAtTime": "10:00",
  "weekday": 1
}
```

---

### 提醒型任务示例（taskType="reminder"）

> 仅用于"提醒我去做X"场景，用户自己会去做这件事。
> prompt 只需填**提醒内容**，系统自动包装暖心模板。

**一次性提醒（N分钟/小时后）**：

> runAt 必须是带时区偏移的 ISO-8601 时间戳（如 `+08:00`），**禁止使用 Z（UTC）**，需自行计算。

```json
{
  "action": "create",
  "taskType": "reminder",
  "name": "喝水提醒",
  "description": "5分钟后提醒喝水",
  "prompt": "该喝水了",
  "frequency": "once",
  "runAt": "2026-03-08T23:35:00+08:00"
}
```

**时间计算方式**：
| 用户说法 | 计算方式 |
|----------|----------|
| 5分钟后 | 当前本地时间 + 5分钟，带上时区偏移（如 `+08:00`） |
| 半小时后 | 当前本地时间 + 30分钟 |
| 1小时后 | 当前本地时间 + 60分钟 |
| 明天早上8点 | 确认当前日期，计算明天的目标时间，带时区偏移 |

> **重要**：runAt 始终使用本地时间 + 时区偏移格式，例如 `2026-03-09T01:32:00+08:00`，绝不使用 `Z` 后缀。

**每日提醒**：
```json
{
  "action": "create",
  "taskType": "reminder",
  "name": "邮件检查提醒",
  "description": "每天早上9点检查邮件",
  "prompt": "该检查今天的邮件了，别让紧急事项溜走",
  "frequency": "daily",
  "runAtTime": "09:00"
}
```

**每周提醒**（weekday: 0=周日, 1=周一, ..., 6=周六）：
```json
{
  "action": "create",
  "taskType": "reminder",
  "name": "周会提醒",
  "description": "每周一早上10点开周会",
  "prompt": "周会马上开始了，准备好本周的工作汇报",
  "frequency": "weekly",
  "runAtTime": "10:00",
  "weekday": 1
}
```

---

### 带对话上下文的任务（contextMessages）

> 当用户在讨论中说"提醒我这件事"，用 contextMessages 自动把当前对话内容附加到 prompt 中，
> 让触发时的 agent 知道"在聊什么"。

```json
{
  "action": "create",
  "taskType": "reminder",
  "name": "方案跟进提醒",
  "description": "30分钟后提醒跟进刚才讨论的方案",
  "prompt": "该跟进刚才讨论的方案了，检查是否有遗漏的细节",
  "frequency": "once",
  "runAt": "2026-03-09T00:00:00+08:00",
  "contextMessages": 5
}
```

**contextMessages 使用原则**：
- 值为 1-10，表示从当前对话取最近 N 条消息
- 适用场景：用户在讨论某事时说"提醒我这个"，需要保留上下文
- 不适用场景：通用提醒（如"每天喝水"），不需要上下文
- 上下文会自动截断，每条消息最多 220 字符，总共最多 700 字符
- 若返回结果中 `contextAttached` 为 `false` 且你传了 `contextMessages`，应向用户说明：对话上下文获取失败，本次任务未附带最近对话

---

### 查看任务执行历史（runs）

```json
{
  "action": "runs",
  "taskId": "任务ID",
  "limit": 5
}
```

返回最近 N 次执行记录，包含：开始时间、结束时间、状态（ok/error）、错误信息、耗时。

---

## prompt 编写指南

> **核心机制**：定时任务触发时，一个独立的 agent 在后台 thread 中执行 prompt。
> 该 agent **拥有完整的工具能力**（读写文件、执行命令、搜索代码等），可以执行真正的操作。
> 执行完成后系统会自动发送桌面通知（显示 agent 输出的前 200 字符），同时完整输出写入后台 thread。
>
> **`taskType` 决定 prompt 处理方式**：
> - `taskType="action"`：prompt 原样发给 agent，agent 会调用工具执行实际操作
> - `taskType="reminder"`：prompt 只需填提醒内容（如"该喝水了"），系统自动包装暖心模板
> - **不要写"提醒用户xxx"或"通知用户"**——agent 无法主动推送，只能把内容输出到 thread

### taskType="action" 的 prompt 编写

> agent 会拿到 prompt 原文并调用工具执行。写清楚要做什么、在哪做。

**编写要求**：
1. 写清楚要做什么操作
2. 包含工作目录的绝对路径
3. 说明具体的操作步骤和预期结果

**示例**：
```
请扫描 D:\git\lf39.031\LF39.18_WE 目录下所有源码文件，找出硬编码的明文密码。
对于每个发现的明文密码：
1. 将其替换为环境变量引用或加密配置
2. 记录修改的文件和行号
3. 最后输出修改摘要
```

### taskType="reminder" 的 prompt 编写

> 只需填提醒内容，系统自动包装暖心模板。不需要手动写模板。

**示例**：prompt 填 `该喝水了`，系统自动生成完整 prompt，agent 可能输出：
`💧 嘿，键盘侠！手指敲了这么久，嘴巴也该动动啦～喝口水，让身体也刷新一下吧！`

### 编写原则

1. **先选 taskType**：操作动词 → `"action"`；"提醒我" → `"reminder"`。**选错 = 任务无效**
2. **自包含**：prompt 触发时 agent 没有原始对话的上下文，所有必要信息都要写在 prompt 里
3. **善用 contextMessages**：如果任务与当前对话内容相关，设置 contextMessages=3~5 自动附加上下文
4. **包含路径**：`"action"` 类型涉及文件操作时，写明绝对路径（从当前 workDir 获取）
5. **具体明确**：避免模糊的指令，写清楚具体操作步骤
6. **不要写"通知用户"或"提醒用户"**：agent 只能把内容输出到后台 thread，系统会自动发桌面通知

---

## 用户交互模板

### 创建成功反馈

**一次性提醒**：
```
好的，{时间}后提醒你{提醒内容}。
```

**周期提醒**：
```
已设置{周期描述}提醒你{提醒内容}，下次执行时间：{nextRunAt}。
```

### 查询结果反馈

```
当前定时任务：

1. {name} - {frequency}{时间} - {enabled状态}
2. {name} - {frequency}{时间} - {enabled状态}

可以说"取消xx"删除任务，或"暂停xx"禁用任务。
```

### 无任务时反馈

```
目前没有定时任务。你可以说"5分钟后提醒我xxx"或"每天9点提醒我xxx"来创建任务。
```

### 删除成功反馈

```
已删除"{任务名称}"。
```

### 执行历史反馈

```
"{任务名称}"的最近{N}次执行记录：

| 时间 | 状态 | 耗时 |
|------|------|------|
| {startedAt} | {status} | {durationMs}ms |

{如果有错误，展示错误信息}
```

### 禁用/启用反馈

```
已暂停"{任务名称}"，不会继续执行。说"恢复{任务名称}"可重新启用。
```

```
已恢复"{任务名称}"，下次执行时间：{nextRunAt}。
```

---

## 定时任务 vs 心跳：何时用哪个

| 场景 | 推荐方式 | 原因 |
|------|---------|------|
| "5分钟后提醒我开会" | 定时任务 (once) | 精确时间，一次性 |
| "每天9点检查邮件" | 定时任务 (daily) | 精确时间，周期性 |
| "每5分钟检查服务状态" | 定时任务 (interval) | 分钟级精确间隔 |
| "定期检查项目状态" | 心跳 (HEARTBEAT.md) | 可以和其他检查合并，不需要精确时间 |
| "持续监控服务是否正常" | 定时任务 (interval) 或心跳 | 需要精确间隔用 interval，否则用心跳 |
| "每周一出项目报告" | 定时任务 (weekly) | 精确时间，独立任务 |

**简单规则**：
- 需要精确时间 -> 定时任务
- 需要分钟级间隔 -> 定时任务 (interval)
- 周期性检查、可以批量处理 -> 心跳（在 HEARTBEAT.md 中添加检查项）
- 一次性提醒 -> 定时任务 (once)

当用户需求适合心跳时，建议用户去 Heartbeat 设置面板配置 HEARTBEAT.md，或直接帮用户通过 edit_file 修改 `~/.cmbcoworkagent/HEARTBEAT.md`。

---

## 操作流程

### 创建任务

1. 识别用户意图（提醒/定时任务）
2. 确认时间（必要时追问）
3. 获取当前时间（相对时间需计算绝对时间戳）
4. 调用 manage_scheduler(action="create", ...)
5. 反馈创建结果（包含下次执行时间）

### 修改任务

1. 用户说要修改 -> 先 list 找到 taskId
2. 调用 manage_scheduler(action="update", taskId=..., 修改的字段)
3. 反馈修改结果

### 删除任务

1. 用户说要取消/删除 -> 先 list 找到 taskId
2. 如果有多个相似任务，向用户确认
3. 调用 manage_scheduler(action="delete", taskId=...)
4. 反馈删除结果

### 查看执行历史

1. 用户说要看某任务的执行记录 -> 先 list 找到 taskId
2. 调用 manage_scheduler(action="runs", taskId=..., limit=5)
3. 以表格形式反馈执行历史

### 触发心跳

1. 用户说要检查心跳 / 触发心跳
2. 调用 manage_scheduler(action="wake")
3. 反馈心跳已触发（异步执行）
