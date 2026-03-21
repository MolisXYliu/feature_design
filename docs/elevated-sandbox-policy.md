# Elevated 沙箱模式安全策略说明

> 文档版本：v1.3
> 更新日期：2026-03-19
> 适用范围：CmbCoworkAgent Windows 客户端
> 文档性质：安全策略与风险评估报告

## 概述

Elevated 模式是 CmbCoworkAgent 最严格的沙箱模式。它通过以下多层机制保护系统安全：

1. **命令安全评估** — 三级分类体系（safe/needs_approval/forbidden），Windows使用PowerShell AST解析器精确检测
2. **沙箱用户隔离** — 使用独立的低权限 Windows 用户（`CodexSandboxOffline`）执行命令
3. **文件工具路径保护** — Agent 的文件操作工具也受敏感目录限制
4. **审批通道安全加固** — 多层校验防止跨窗口代审批、伪造审批和重放攻击
5. **持久化审批规则** — 支持构建工具命令的永久批准（如`npm install`），提升开发体验
6. **首次启动强制引导** — NUX 流程默认仅允许 Elevated 模式，降低配置风险
7. **网络访问策略** — 网络访问取决于机器和公司网络策略，不再由本地沙箱额外阻断

---

## 一、Shell 命令分类

> 代码路径：`src/main/agent/exec-policy.ts`（安全评估引擎）
> 代码路径：`src/main/agent/windows-safe-commands.ts`（Windows PowerShell AST 安全检测）
> 编排器路径：`src/main/agent/tool-orchestrator.ts`

安全评估与 codex-rs 的 `is_known_safe_command()` 和 `command_might_be_dangerous()` 对齐，采用**结构化命令解析**而非简单的前缀匹配。

### 1. 安全命令（自动执行，无需审批）

安全命令的判定分为两个层面：

#### 1.1 通用安全可执行文件（跨平台）

以下可执行文件被视为无副作用的只读命令，直接放行：

```
base64, cat, cd, cut, dir, echo, expr, false, file, grep, head, hostname, id,
ls, nl, paste, pwd, printf, rev, seq, sort, stat, tail, tr, tree, true, uname,
uniq, wc, where, which, whoami, type, awk, comm, date, diff, env, printenv
```

#### 1.2 需参数校验的安全命令

以下命令需逐参数检查后才视为安全：

| 命令 | 安全条件 | 不安全参数 |
|------|----------|-----------|
| **`find`** | 不含执行/删除参数 | `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fls`, `-fprint*` |
| **`rg`** (ripgrep) | 不含特殊标志 | `--search-zip`/`-z`, `--pre`, `--hostname-bin` |
| **`git`** | 子命令为只读 + 无危险标志 | `--output`, `--ext-diff`, `--textconv`, `--exec`, `--paginate` |
| — `git status/log/diff/show/cat-file` | 无危险标志 | `-c`（config override）会导致不安全 |
| — `git branch` | 仅含只读标志 | 必须有 `--list`/`-l`/`--show-current`/`-a`/`-r`/`-v`/`--format=` 等 |
| **`sed`** | 仅 `sed -n <range>p` | 非 `-n` 模式（写入模式） |
| **`base64`** | 不含输出文件参数 | `-o`, `--output` |

#### 1.3 Windows PowerShell 安全检测

> 代码路径：`src/main/agent/windows-safe-commands.ts`

在 Windows 平台且沙箱模式非 `none` 时，额外启用 **PowerShell AST 解析器**进行精确的命令安全检测。此实现与 codex 完全一致。

**检测机制**：

1. **优先使用系统 PowerShell AST 解析**：通过 `spawnSync` 调用 PowerShell，使用 `[System.Management.Automation.Language.Parser]::ParseInput()` 将命令解析为完整的 AST 树，精确提取每个管道、链式命令中的各个命令及其参数
2. **保守解析 Fallback**：当 PowerShell 不可用时，使用纯 TypeScript 的保守解析器：拆分管道/链式运算符、解析引号、检测变量替换（`$(`、`${`、`` ` ``）和重定向

**安全的 PowerShell 命令白名单**：

| 类型 | 命令/别名 |
|------|-----------|
| **输出** | `echo`, `Write-Output`, `Write-Host` |
| **目录列表** | `dir`, `ls`, `Get-ChildItem`, `gci` |
| **文件读取** | `cat`, `type`, `gc`, `Get-Content` |
| **搜索** | `Select-String`, `sls`, `findstr` |
| **度量** | `Measure-Object`, `measure` |
| **路径导航** | `Get-Location`/`gl`/`pwd`, `Set-Location`/`sl`/`cd`/`chdir`, `Push-Location`/`pushd`, `Pop-Location`/`popd`, `Test-Path`/`tp`, `Resolve-Path`/`rvpa` |
| **对象/管道处理** | `Select-Object`/`select`, `Where-Object`/`where`/`?`, `ForEach-Object`/`foreach`/`%`, `Sort-Object`/`sort`, `Group-Object`/`group`, `Format-Table`/`ft`, `Format-List`/`fl`, `Out-String`/`oss`, `Out-Null` |
| **信息查询** | `Get-Item`/`gi`, `Get-ItemProperty`/`gp`, `Get-Member`/`gm`, `Get-Process`/`gps`/`ps`, `Get-Command`/`gcm`, `Get-Help`/`help`/`man`, `Get-Alias`/`gal`, `Get-Variable`/`gv` |
| **Git 只读** | `git status`, `git log`, `git show`, `git diff`, `git cat-file`, `git branch`（同上参数校验） |
| **ripgrep** | `rg`（同上参数校验） |
| **构建工具** | 见下方 §1.4 构建工具安全白名单 |

**副作用 cmdlet 黑名单**（任何管道中出现即判定为不安全）：

```
Set-Content, Add-Content, Out-File, New-Item, Remove-Item,
Move-Item, Copy-Item, Rename-Item, Start-Process, Stop-Process
```

**PowerShell 调用层解析**：当检测到 `powershell -Command "..."` 或 `pwsh -c "..."` 模式时，会递归解析内部脚本内容。支持的标志：`-NoLogo`, `-NoProfile`, `-NonInteractive`, `-MTA`, `-STA`。不安全的标志（直接判定需审批）：`-EncodedCommand`, `-File`, `-WindowStyle`, `-ExecutionPolicy`, `-WorkingDirectory`。

**流合并重定向支持**：PowerShell AST 解析器和保守解析器均支持 `2>&1` 等流合并重定向（`MergingRedirectionAst`），不会将其误判为文件重定向。例如 `mvn compile 2>&1 | Select-Object -Last 50` 可以被正确解析为安全命令。文件重定向（如 `> file.txt`）仍然会触发审批。

#### 1.4 构建工具安全白名单

> 代码路径：`src/main/agent/exec-policy.ts`（`isSafeBuildTool`）
> 代码路径：`src/main/agent/windows-safe-commands.ts`（`isSafeMvnCommand` 等）

为提升开发体验，常见的编译、测试、打包命令被识别为安全命令，无需审批。但涉及**远程发布、部署、外部包执行**的子命令仍需审批。

| 构建工具 | 自动放行（示例） | 需要审批（黑名单） |
|----------|------------------|-------------------|
| **Maven** (`mvn`/`mvnw`) | `clean`, `compile`, `test`, `package`, `install`, `verify`, `spring-boot:run` | `deploy`, `site-deploy`, `exec:*`, `release:*`, `deploy:*`, `wagon:*`, `scm:*` |
| **Gradle** (`gradle`/`gradlew`) | `build`, `clean`, `test`, `assemble`, `run`, `classes` | `publish`, `publishToMavenLocal`, `uploadArchives` |
| **npm/pnpm/yarn/bun** | `install`, `run`, `test`, `build`, `ci`, `start`, `dev` | `publish`, `unpublish`, `deprecate`, `dist-tag`, `access`, `exec`, `x` |
| **Cargo** | `build`, `test`, `run`, `check`, `fmt`, `clippy` | `publish`, `yank`, `login`, `logout` |
| **Go** | `build`, `run`, `test`, `fmt`, `vet`, `mod`, `generate`（白名单） | 其他所有子命令 |
| **dotnet** | `build`, `run`, `test`, `restore`, `clean` | `nuget`, `publish` |
| **make/cmake** | 所有目标（构建系统，由 Makefile 定义） | — |
| **javac** | Java 编译器（仅编译，无执行能力） | — |

> 注：`java`/`javaw` **不在安全白名单中**，因其可执行任意代码。执行 `java -jar xxx.jar` 仍需用户审批。

#### 1.5 Shell 元字符防护

当命令中包含以下 shell 元字符时，即使首个命令在安全白名单中，也**不会自动放行**，而是归类为"需要审批"：

```
&&  ||  |  &  ;  `  <  >  $(  换行符
```

这防止了 `echo ok && git push --force`、`ls | rm -rf /`、`echo $(dangerous)` 等绕过手法。

### 2. 需要审批的命令（弹出审批对话框）

以下命令有潜在风险，Agent 执行前会弹出审批栏，用户可以选择：
- **运行** — 仅本次允许
- **本会话允许** — 当前会话内相同命令自动放行
- **始终允许** — 永久允许此命令前缀（持久化存储，仅限构建工具类命令）
- **拒绝** — 拒绝执行

#### 已知危险命令（有明确风险提示）

| 命令模式 | 风险说明 |
|----------|----------|
| `rm -r...` | 递归删除文件 |
| `rm -f...` | 强制删除文件 |
| `git push --force` / `git push -f` | 强制推送可能覆盖远程历史 |
| `git reset --hard` | 硬重置会丢失未提交的修改 |
| `git clean -f...` | 清除未跟踪的文件 |
| `npm publish` | 发布包到 npm 注册表 |
| `curl -X DELETE/PUT/POST` | 变更型 HTTP 请求 |
| `chmod 777` | 过度开放的文件权限 |
| `chown` | 修改文件所有者 |
| `net user` | Windows 用户管理 |
| `reg add` / `reg delete` | Windows 注册表修改 |
| `icacls ... /grant` | 修改文件 ACL 权限 |
| `takeown` | 夺取文件所有权 |
| `sudo` | 提权执行 |
| `kill -9` | 强制终止进程 |
| `docker rm` | 删除 Docker 容器 |
| `docker rmi` | 删除 Docker 镜像 |
| `> /dev/sd*` | 直接写入块设备 |
| `DROP TABLE/DATABASE` | SQL 破坏性操作 |
| `Remove-Item -Recurse` | PowerShell 递归删除 |
| `Remove-Item -Force` | PowerShell 强制删除 |
| `Stop-Process -Force` | PowerShell 强制终止进程 |
| `Set-ExecutionPolicy` | 修改 PowerShell 脚本执行策略 |
| `New-LocalUser` / `Remove-LocalUser` | PowerShell 用户管理 |
| `Set-Acl` | PowerShell 修改文件 ACL |
| `Invoke-Expression` / `iex` | PowerShell 动态代码执行 |
| `Invoke-WebRequest -Method Post/Put/Delete` | PowerShell 变更型 HTTP 请求 |
| `node -e` / `node --eval` | Node.js 内联代码执行（可含任意危险操作） |
| `python -c` / `python3 -c` | Python 内联代码执行（可含任意危险操作） |

#### 未知命令

**不在安全白名单中的所有其他命令**均默认归类为"需要审批"，提示："unknown command — requires review"。

常见需要审批的命令示例：
- `git add`, `git commit`, `git push`, `git checkout`
- `mkdir`, `touch`, `cp`, `mv`, `ln`
- `pip install`
- `java -jar xxx.jar`（可执行任意代码）
- `docker build`, `docker run`
- `curl` (GET)、`wget` (下载)
- `sed` (非 `-n` 模式，即写入模式)
- `npm publish`, `mvn deploy`, `gradle publish`（远程发布操作）
- `npm exec`, `npx`（下载并运行外部包）
- 任何自定义脚本、可执行文件

> 注：`npm install`、`npm run build`、`mvn compile`、`cargo build` 等常见构建命令已移入安全白名单（见 §1.4），不再需要审批。

### 3. 禁止命令（直接拒绝，不可执行）

这些命令极端危险，Agent **不会执行也不会弹出审批**，直接返回错误：

| 命令模式 | 风险说明 |
|----------|----------|
| `rm -rf /` | 删除根目录 |
| `mkfs` | 格式化磁盘分区 |
| `dd ... of=/dev/` | 直接写入设备，可能摧毁数据 |
| `format X:` | Windows 格式化磁盘 |
| `shutdown` / `reboot` / `halt` / `poweroff` | 系统电源控制 |
| `del /s /q X:\` | Windows 递归删除驱动器根目录 |
| `rmdir /s /q X:\` | Windows 递归删除驱动器根目录 |
| `curl ... \| sh` / `curl ... \| bash` | 从远程下载并直接执行脚本 |
| `wget ... \| sh` / `wget ... \| bash` | 从远程下载并直接执行脚本 |
| `:(){ :\|:& };:` | Fork 炸弹 |
| `Remove-Item -Recurse ... C:\*` | PowerShell 递归删除驱动器根目录 |
| `Format-Volume` / `Clear-Disk` | PowerShell 格式化/清除磁盘 |
| `iex (iwr ...)` / `Invoke-Expression (Invoke-WebRequest ...)` | PowerShell 下载并执行远程脚本 |
| `Stop-Computer` / `Restart-Computer` | PowerShell 关机/重启 |

---

## 二、沙箱用户隔离

> 代码路径：`src/main/ipc/sandbox.ts`（elevated setup）
> 二进制文件：`resources/bin/win32/codex.exe`, `codex-command-runner.exe`, `codex-windows-sandbox-setup.exe`

### 执行机制

Elevated 模式下，所有 shell 命令通过 `codex.exe` 以 **`CodexSandboxOffline`** 用户身份运行：

```
Agent → ToolOrchestrator → LocalSandbox → codex.exe → CodexSandboxOffline 用户执行
```

### 隔离特性

| 特性 | 说明 |
|------|------|
| **用户隔离** | 命令以 `CodexSandboxOffline` 用户运行，而非当前用户 |
| **网络访问** | 网络访问取决于机器和公司网络策略，不再由本地沙箱额外阻断 |
| **文件写入限制** | 仅允许写入 `%TEMP%` 和当前工作目录 |
| **文件读取限制** | 可读取用户目录下的大部分子目录和系统目录（见下方排除列表） |
| **敏感目录 DENY ACE** | 通过 icacls 对敏感目录设置 DENY 权限，沙箱用户无法读取 |

### 进程权限

沙箱用户的进程相关权限如下：

| 操作 | 是否允许 | 说明 |
|------|:--------:|------|
| **创建进程** | ✅ 允许 | 沙箱的核心功能；子进程继承沙箱用户的受限令牌（无网络、有限写入） |
| **创建子进程链** | ✅ 允许 | 子进程可再创建子进程，所有后代进程均继承相同的受限权限，无法提权 |
| **运行系统可执行文件** | ✅ 允许 | 可运行可读目录中的任何可执行文件（`powershell.exe`、`cmd.exe`、`python.exe` 等） |
| **枚举系统进程** | ✅ 允许 | 可通过 `tasklist`、`Get-Process` 查看其他用户的进程列表 |
| **终止自身进程** | ✅ 允许 | 可终止自己启动的进程 |
| **终止其他用户进程** | ❌ 拒绝 | Windows 安全模型限制，低权限用户无法终止其他用户的进程 |
| **系统电源控制** | ❌ 禁止 | `shutdown`、`reboot`、`Stop-Computer` 等在 exec-policy 中被归类为禁止命令 |
| **进程间通信（IPC）** | ⚠️ 受限 | 大多数系统服务的 IPC 端点（命名管道、COM 等）对低权限用户设置了严格 ACL |

> 注：沙箱未实施可执行文件白名单。Agent 工作需要调用多种工具（node、python、git、npm 等），白名单机制不现实且会阻断正常工作流。安全边界依赖沙箱用户的受限令牌，而非限制可运行的程序。

### 初始化流程

1. 首次启动应用 → 弹出 NUX 引导弹窗
   - **默认仅允许选择 "默认沙箱（Elevated）"**，其他模式（Unelevated / 关闭）置灰不可选
   - 提示"如需选择请联系开发人员"（开发人员可通过密码解锁其他选项）
   - NUX 完成状态持久化到 `sandbox-settings.json`，跨应用重启生效
2. UAC 提权 → 执行 `codex-windows-sandbox-setup.exe`：
   - 创建 `CodexSandboxOffline` / `CodexSandboxOnline` 用户
   - 创建 `CodexSandboxUsers` 用户组
   - 设置 NTFS ACL 权限（读/写目录）
   - 配置网络访问策略（取决于 codex 配置）
3. 追加执行 icacls 命令对敏感目录设置 DENY ACE
4. 写入 `~/.codex/.sandbox/setup_marker.json` 标记配置完成
5. 若 UAC 配置失败 → 仅显示"重试"按钮（不提供降级选项，除非开发人员解锁）

### Elevated Setup 路径校验

`runElevatedSetupForPaths()` 接收渲染层传入的工作区路径，写入沙箱的 `write_roots`。为防止路径注入攻击，实施以下校验：

| 校验项 | 说明 |
|--------|------|
| **绝对路径归一化** | 使用 `path.resolve()` 将相对路径（如 `../../`）解析为绝对路径 |
| **UNC 路径拦截** | 拒绝 `\\server\share` 和 `//server/share` 格式的网络路径 |
| **驱动器根目录拦截** | 拒绝 `C:\`、`D:\` 等驱动器根目录 |
| **系统目录黑名单** | 拒绝 `C:\Windows`、`C:\Program Files`、`C:\ProgramData`、`C:\Users\Public` 等 |
| **敏感用户目录拦截** | 拒绝 `~/.ssh`、`~/.aws`、`~/.config` 等敏感子目录 |
| **目录存在性验证** | 使用 `statSync` 验证路径存在且为目录 |
| **command_cwd 使用校验后路径** | `command_cwd` 使用校验通过的路径，而非原始输入 |

### 运行时刷新

每次执行命令时，`codex.exe` 内部会自动执行 ACL refresh（非管理员权限）。若 refresh 失败（如工作目录未授权），CmbCoworkAgent 会弹出 UAC 对话框重新进行 elevated setup，然后重试命令。

---

## 三、敏感目录保护

> 代码路径：`src/main/agent/local-sandbox.ts`（文件工具拦截）
> 代码路径：`src/main/ipc/sandbox.ts`（NTFS ACL DENY）

### 受保护目录列表

以下用户主目录下的子目录被双重保护：

| 目录 | 包含内容 |
|------|----------|
| `~/.ssh` | SSH 密钥、known_hosts |
| `~/.gnupg` | GPG 密钥 |
| `~/.aws` | AWS 凭据、配置 |
| `~/.azure` | Azure 凭据 |
| `~/.kube` | Kubernetes 配置、凭据 |
| `~/.docker` | Docker 配置、凭据 |
| `~/.config` | 应用配置（可能含 token） |
| `~/.npm` | npm 配置（可能含 token） |
| `~/.pki` | PKI 证书、私钥 |
| `~/.terraform.d` | Terraform 凭据 |

### 双重保护机制

#### 第一层：NTFS ACL（Shell 命令级别）

通过 icacls 对上述目录设置 `CodexSandboxUsers` 组的 DENY ACE，沙箱用户在 shell 中无法读取：

```
icacls "C:\Users\xxx\.ssh" /deny "CodexSandboxUsers:(OI)(CI)(R)" /T /C /Q
```

效果：`cat ~/.ssh/id_rsa` → **Access is denied.**

#### 第二层：文件工具路径拦截（Agent 工具级别）

Agent 的文件操作工具（`read`, `write`, `edit`, `ls`, `glob`, `grep`）直接在 Electron 主进程中运行，不经过 `codex.exe` 沙箱。因此在代码层面增加了路径检查：

| 工具方法 | 保护行为 |
|----------|----------|
| `read(path)` | 返回 "Access denied" 错误信息 |
| `write(path)` | 返回 `{ error: "Access denied" }` |
| `edit(path)` | 返回 `{ error: "Access denied" }` |
| `uploadFiles(files)` | 对敏感路径的文件逐个返回错误 |
| `lsInfo(path)` | 直接访问敏感目录返回错误；列出父目录时过滤敏感子项 |
| `globInfo(pattern)` | 直接 glob 敏感目录返回空；结果中过滤敏感路径条目 |
| `grepRaw(pattern, path)` | 阻止在敏感目录中 grep；结果中过滤敏感路径匹配 |

---

## 四、YOLO 模式

当开启 YOLO 模式时，**审批机制被跳过**，但仍保留底线安全：
- 安全命令和需审批命令均自动执行，不弹出审批对话框
- **禁止命令仍然被拦截**（如 `rm -rf /`、`mkfs`、`curl | sh` 等极端危险命令）
- 沙箱用户隔离仍然生效（如果 sandbox mode 为 elevated）
- 敏感目录文件工具拦截仍然生效

YOLO 模式适用于信任 Agent 日常操作但仍需防范极端危险命令的场景。

---

## 五、审批决策缓存与持久化规则

> 代码路径：`src/main/agent/approval-store.ts`
> 代码路径：`src/main/agent/exec-policy.ts`（`derivePermanentApprovalPattern` / `matchesApprovalPattern`）

### 缓存层级

| 缓存类型 | 存储位置 | 生效范围 | 失效条件 |
|----------|----------|----------|----------|
| **单次批准** | 无缓存 | 仅本次执行 | 立即失效 |
| **会话级缓存** | 内存 `Map` | 当前应用运行期间，相同命令+cwd+sandbox模式 | 应用重启 |
| **永久规则** | `~/.cmbcoworkagent/approval-rules.json` | 跨会话持久生效，前缀匹配命令 | 用户手动删除 |

缓存 key 生成规则：`sha256(command + "|" + cwd + "|" + sandboxMode)`

### 持久化审批规则（与 codex 对齐）

永久审批采用**命令前缀匹配**机制，而非精确匹配。例如批准 `npm install` 后，`npm install lodash`、`npm install --save-dev typescript` 等均自动放行。

**规则格式**：`prefix:["npm","install"]` — JSON 序列化的 token 数组前缀

**可持久化的可执行文件白名单**（`PERSISTABLE_EXECUTABLES`）：

```
bun, cargo, cmake, go, gradle, gradlew, make, mvn, npm, pnpm, poetry, pytest, uv, yarn
```

只有以上构建工具类命令才允许创建永久审批规则。这是因为构建工具命令频繁执行、行为可预测、且用户理解其副作用。

**禁止持久化的命令前缀**（`BANNED_PERSISTENT_PREFIXES`）：

即使可执行文件在白名单中，以下前缀也不允许创建永久规则（防止通过解释器执行任意代码）：

```
python3, python3 -, python3 -c, python, python -, python -c,
py, py -3, pythonw, pyw, pypy, pypy3,
git,
bash, bash -lc, sh, sh -c, sh -lc, zsh, zsh -lc,
pwsh, pwsh -command, pwsh -c,
powershell, powershell -command, powershell -c,
powershell.exe, powershell.exe -command, powershell.exe -c,
env, sudo,
node, node -e, perl, perl -e, ruby, ruby -e, php, php -r, lua, lua -e
```

**匹配流程**：
1. 用户审批时选择"始终允许" → 调用 `derivePermanentApprovalPattern(command)`
2. 检查可执行文件是否在 `PERSISTABLE_EXECUTABLES` 中
3. 检查命令前缀是否在 `BANNED_PERSISTENT_PREFIXES` 中
4. 检查命令是否包含 shell 元字符（`$(`、`${`、`@(`）
5. 全部通过 → 生成 `prefix:["token1","token2",...]` 格式的规则并持久化
6. 任一检查失败 → 降级为会话级审批，不持久化

---

## 六、审批通道安全加固

> 代码路径：`src/main/ipc/sandbox.ts`（审批决定校验）
> 代码路径：`src/main/agent/runtime.ts`（审批请求发送 + 超时）

审批请求通过 IPC 从主进程发送到渲染层，渲染层做出决定后回传。为防止跨窗口代审批、伪造审批等攻击，实施了多层校验：

### 审批决定三层校验

| 校验层 | 校验内容 | 防御目标 |
|--------|----------|----------|
| **第一层：已知窗口** | 验证 `event.sender.id` 对应一个已知的 `BrowserWindow` | 拒绝来自未知来源的审批决定 |
| **第二层：目标窗口绑定** | 验证发送者的 `webContents.id` 在该审批请求的 `targetWebContentsIds` 列表中 | 防止窗口 B 代替窗口 A 审批（跨窗口代审批） |
| **第三层：tool_call_id 匹配** | 当原始请求包含 `tool_call_id` 时，审批决定必须提供匹配的非空值 | 防止审批决定被重放到其他工具调用 |

### 其他安全措施

| 措施 | 说明 |
|------|------|
| **决定类型白名单** | 仅接受 `approve`、`approve_session`、`approve_permanent`、`reject` 四种类型 |
| **5 分钟超时自动拒绝** | 审批请求超过 5 分钟未响应，自动以 `reject` 决定关闭，防止 Promise 无限挂起 |
| **空值绕过防护** | `tool_call_id` 校验不接受空字符串或 undefined，防止通过传空值跳过比对 |

---

## 七、沙箱失败处理策略

当沙箱阻止某个操作时（如文件写入被 ACL 拒绝、网络认证凭据缺失），系统采取**拦截并提示**策略，**不提供绕过沙箱的选项**：

### 7.1 命令执行被沙箱拒绝

当命令在沙箱中执行失败（Access is denied / Permission denied / Operation not permitted / blocked by policy），编排器直接返回友好错误信息：

```
⚠️ 操作被沙箱拦截：{错误信息}
此命令在 Elevated 沙箱模式下无法执行。如需执行此类操作，请在设置中切换到 Unelevated 沙箱模式后重试。
```

**不再提供"无沙箱重试"选项**。用户如需执行被拦截的操作，必须主动到 **自定义 → 沙箱环境** 面板切换沙箱模式。

### 7.2 网络认证凭据缺失

Elevated 沙箱用户（`CodexSandboxOffline`）可能缺少企业网络认证凭据（如 Kerberos/NTLM），导致内网资源访问失败（`SEC_E_NO_CREDENTIALS`）。

**之前的策略**：自动静默回退到 Unelevated 模式重试（绕过 Elevated 隔离）。

**当前策略**：拦截并提示用户切换模式，不自动降级：

```
⚠️ 操作被沙箱拦截：Elevated 沙箱用户缺少企业网络认证凭据，无法执行此命令。
如需执行网络相关操作，请在设置中切换到 Unelevated 沙箱模式后重试。
```

### 7.3 沙箱模式切换入口

沙箱模式**仅允许在以下两个入口切换**：

| 入口 | 时机 | 说明 |
|------|------|------|
| **NUX 首次引导** | 首次启动应用 | 默认仅允许 Elevated，其他模式需开发人员密码解锁 |
| **自定义 → 沙箱环境** | 任意时刻 | 切换后在下一次对话中生效；非 Elevated 模式同样需要密码解锁 |

其他任何地方（审批弹窗、错误提示等）均不提供切换沙箱模式的操作入口。

---

## 八、完整执行流程图

```
用户发送消息 → Agent 决定执行命令
                    ↓
              评估命令安全性
              (exec-policy.ts + windows-safe-commands.ts)
           ↓              ↓           ↓
         safe       needs_approval  forbidden
           ↓              ↓           ↓
           │              │       直接拒绝（包括 YOLO 模式）
           │              ↓
           │     ┌── YOLO 模式? ──┐
           │     │ Yes             │ No
           │     ↓                 ↓
           │   直接执行      检查审批缓存
           │                   (approval-store.ts)
           │                       ↓
           │              ┌─ 缓存命中? ─┐
           │              │ Yes         │ No
           │              ↓             ↓
           │         按缓存决定    弹出审批 UI
           │              │             ↓
           │              │     ┌──── 用户决定 ────┐
           │              │     │                  │ reject
           │              │     ↓                  ↓
           │              │   缓存决定           返回错误
           │              │     ↓
           │              │   ┌─ approve ─────── 不缓存
           │              │   ├─ approve_session → 缓存到内存
           │              │   └─ approve_permanent
           │              │       ↓
           │              │   命令可持久化?
           │              │   (PERSISTABLE + 非BANNED)
           │              │     ↓ Yes      ↓ No
           │              │   存储永久规则  降级为session
           ↓              ↓
     codex.exe 沙箱执行
           ↓
    ┌─ 执行成功? ─┐
    │ Yes         │ No (沙箱拒绝)
    ↓             ↓
 返回结果     返回友好错误提示
              "请在设置中切换沙箱模式"
              （不提供无沙箱重试选项）
```

---

## 十、网络访问策略变更说明

> 更新日期：2026-03-19
> 代码路径：`src/main/agent/local-sandbox.ts`（沙箱命令参数配置）

### 策略变更

从 v1.2 版本开始，Elevated 沙箱模式的网络访问策略发生重要变更：

**之前的策略**：
- 通过 Windows Firewall 规则完全阻断 `CodexSandboxOffline` 用户的出站网络访问
- 所有需要网络的命令（`npm install`、`git clone`、`pip install` 等）在沙箱中无法执行

**当前策略**：
- 不再由本地沙箱额外配置防火墙规则阻断网络
- 网络访问取决于：
  1. 机器本身的网络连接状态
  2. 公司网络策略（防火墙、代理、VPN 等）
  3. codex 内部的网络访问配置（`sandbox_workspace_write.network_access=true`）

### 配置实现

在所有沙箱模式下，通过 `-c` 参数传递网络访问配置给 codex：

| 沙箱模式 | 配置参数 |
|----------|----------|
| **elevated** | `-c windows.sandbox="elevated"` <br> `-c sandbox_workspace_write.network_access=true` |
| **readonly (admin)** | `-c sandbox_policy={ type = "read-only", access = { type = "full-access" }, network_access = true }` <br> `-c sandbox_permissions=["disk-full-read-access","disk-write-cwd"]` |
| **readonly (non-admin)** | `-c sandbox_policy={ type = "read-only", access = { type = "full-access" }, network_access = true }` <br> `-c sandbox_permissions=["disk-full-read-access"]` |
| **unelevated** | `-c sandbox_workspace_write.network_access=true` |

### 安全影响评估

**优势**：
- ✅ 开发体验大幅提升：`npm install`、`git clone`、`pip install` 等命令可正常工作
- ✅ 符合企业环境实际需求：公司网络策略已提供统一的网络访问控制
- ✅ 减少沙箱配置复杂度：不需要额外管理防火墙规则

**风险变化**：
- ⚠️ 数据外泄风险从"完全阻止"变为"取决于环境"
- ⚠️ 恶意脚本可能通过网络下载额外的攻击载荷（如果网络可用）
- ⚠️ 沙箱用户可能访问内网资源（取决于公司网络策略）

**缓解措施**：
1. **命令安全评估仍然生效**：
   - `curl ... | sh`、`wget ... | bash` 等远程脚本执行命令仍被禁止
   - `iex (iwr ...)`、`Invoke-Expression (Invoke-WebRequest ...)` 等 PowerShell 远程脚本执行被禁止
   - 网络相关的危险命令（`curl -X DELETE/PUT/POST`）仍需审批

2. **敏感数据保护仍然生效**：
   - SSH 密钥、AWS 凭据等敏感目录仍通过 NTFS DENY ACE 保护
   - 即使有网络，沙箱用户也无法读取这些凭据进行外泄

3. **依赖公司网络策略**：
   - 企业环境通常已部署防火墙、代理、DLP 等网络安全措施
   - 这些措施在网络层面提供统一的访问控制和监控

4. **审批机制仍然生效**：
   - 未知命令仍需用户审批
   - 用户可以在审批时判断命令是否涉及网络操作

### 用户提示更新

Agent 在 Elevated 模式下的系统提示已更新：

```
**重要提示：** 你正在 Elevated 沙箱环境中运行。
- 所有 shell 命令以独立沙箱用户身份执行，与当前用户完全隔离。
- 出站网络访问不再由本地沙箱额外阻断；是否可联网取决于当前机器和公司的网络策略。
- 你可以读写工作目录内的文件，但无法访问用户的个人目录（如 .ssh、.aws）。
- 如果命令因权限不足失败，不要反复重试，向用户说明限制即可。
```

---

## 十一、间接执行与脚本绕过分析

> 这是安全模型中最重要的边界问题：Agent 能否通过生成脚本来绕过命令级别的安全检查？

### 场景描述

Agent 可能通过以下方式间接执行危险操作：

1. **生成脚本后执行**：Agent 用 `write()` 工具在工作区创建 `malicious.py`，内容包含 `shutil.rmtree('/')` 或 `os.system('curl ... | sh')`，然后执行 `python malicious.py`
2. **生成 .bat/.ps1 脚本**：同理，Agent 可以写入 `danger.bat` 包含 `del /s /q C:\`，然后执行它
3. **内联代码执行**：`python -c "import os; os.remove('/etc/passwd)"` 或 `node -e "require('fs').unlinkSync(...)"`

### 各层防护效果

| 攻击方式 | 命令安全评估 | 沙箱用户隔离（Elevated） | 文件工具拦截 |
|----------|:----------:|:-------------------:|:----------:|
| `python malicious.py` | ⚠️ 需审批（未知命令） | ✅ 受限执行 | — |
| `node -e "危险代码"` | ⚠️ 需审批（已从安全白名单移除） | ✅ 受限执行 | — |
| `python -c "危险代码"` | ⚠️ 需审批（已从安全白名单移除） | ✅ 受限执行 | — |
| `Remove-Item -Recurse C:\*` | ✅ 禁止（PowerShell 驱动器根目录递归删除） | ✅ 受限执行 | — |
| `iex (iwr http://...)` | ✅ 禁止（PowerShell 远程脚本执行） | ✅ 受限执行 | — |
| 脚本内读取 `~/.ssh` | — | ✅ NTFS DENY ACE 阻止 | — |
| 脚本内发起网络请求 | — | ⚠️ 取决于环境（网络策略） | — |
| 脚本内写入系统目录 | — | ✅ ACL 阻止 | — |
| 脚本内删除工作区文件 | — | ⚠️ 工作区可写，无法阻止 | — |
| 用 `write()` 工具写入 `~/.ssh` | — | — | ✅ 路径拦截 |
| 用 `read()` 工具读取 `~/.aws` | — | — | ✅ 路径拦截 |

### 诚实评估

**命令安全评估层的能力与局限**：

命令安全评估检查顶层命令字符串（如 `python`、`node`、`Remove-Item`），**不分析脚本文件内容**。当前防护：

- ✅ Windows 平台使用 **PowerShell AST 解析器**进行精确的结构化命令解析，与 codex 完全一致
- ✅ `node -e` 和 `python -c` 已从安全白名单移至需审批，Agent 无法通过它们静默执行任意代码
- ✅ PowerShell 危险命令（`Remove-Item -Recurse C:\*`、`iex (iwr ...)`、`Format-Volume` 等）已加入禁止/需审批列表
- ✅ 禁止命令检查在所有模式下生效（包括 YOLO 模式和无 Orchestrator 的场景）
- ✅ Shell 元字符（`&&`、`||`、`|`、`&`、`;`、换行、反引号、`$(`）不会因首个命令安全而自动放行
- ✅ Git 子命令参数校验（`git branch` 必须含只读标志，`-c` config override 导致不安全）
- ✅ 持久化审批规则仅限构建工具类命令（`npm`, `cargo` 等），解释器命令（`python`, `node`, `bash` 等）被禁止持久化
- ⚠️ `python script.py` 会触发审批（未知命令），但用户审批时只能看到命令本身，无法看到脚本内容
- ⚠️ 在 YOLO 模式下，`python script.py` 会自动执行（非禁止命令）

**沙箱用户隔离层是真正的防线**：

在 Elevated 模式下，即使 Agent 生成并执行了恶意脚本，脚本仍然以 `CodexSandboxOffline` 用户身份运行，受到以下限制：

| 危险操作 | 是否被阻止 | 阻止机制 |
|----------|:----------:|----------|
| 读取 SSH 密钥 / AWS 凭据 | ✅ 阻止 | NTFS DENY ACE |
| 发起网络请求（数据外泄） | ⚠️ 取决于环境 | 取决于机器和公司网络策略 |
| 写入系统目录 | ✅ 阻止 | NTFS ACL（无写权限） |
| 安装恶意软件 | ⚠️ 部分阻止 | 无写权限（系统目录），但网络访问取决于环境 |
| 修改注册表 | ✅ 阻止 | 沙箱用户无权限 |
| 删除/修改工作区内文件 | ❌ 无法阻止 | 工作区是沙箱的可写区域 |
| 读取工作区内文件 | ❌ 无法阻止 | 工作区是沙箱的可读区域 |
| 读取非敏感的用户目录文件 | ❌ 无法阻止 | 仅敏感目录有 DENY ACE |

### 已知风险与缓解建议

| 风险 | 严重程度 | 当前状态 | 缓解方式 |
|------|:--------:|:--------:|----------|
| `node -e` / `python -c` 绕过审批 | 中 | ✅ 已修复 | 已从安全白名单移至需审批列表 |
| PowerShell 危险命令未覆盖 | 高 | ✅ 已修复 | 已添加 `Remove-Item`、`Format-Volume`、`iex` 等禁止/需审批规则 |
| 无 Orchestrator 时跳过安全检查 | 高 | ✅ 已修复 | `execute()` 方法直接检查禁止命令，不依赖 Orchestrator |
| 链式命令绕过安全白名单 | 高 | ✅ 已修复 | 检测 `&&`、`\|\|`、`\|`、`&`、`;`、`<`、`>`、换行、反引号、`$()` 后强制审批 |
| Windows 命令安全检测不精确 | 中 | ✅ 已修复 | 使用 PowerShell AST 解析器精确解析命令结构，与 codex 对齐 |
| 永久审批被滥用 | 中 | ✅ 已修复 | 仅允许构建工具类命令持久化；解释器前缀被禁止持久化 |
| 跨窗口代审批 | 中 | ✅ 已修复 | 审批决定绑定目标窗口 `webContentsIds`，非目标窗口的决定被拒绝 |
| `tool_call_id` 空值绕过校验 | 中 | ✅ 已修复 | 当预期 ID 存在时，强制要求非空匹配值 |
| 审批请求无超时导致 Promise 挂起 | 中 | ✅ 已修复 | 5 分钟超时自动以 `reject` 关闭 |
| Elevated Setup 路径注入 | 中 | ✅ 已修复 | `resolve()` 归一化 + UNC 拦截 + 目录验证 + 系统目录黑名单 |
| PowerShell 路径转义问题 | 中 | ✅ 已修复 | 改用双引号+反引号转义，支持括号等特殊字符路径 |
| 网络访问数据外泄风险 | 中 | ⚠️ 策略变更 | 不再由本地沙箱阻断网络；依赖公司网络策略 + 敏感目录 DENY ACE + 命令审批 |
| 沙箱失败可绕过隔离执行 | 高 | ✅ 已修复 | 不再提供"无沙箱重试"选项；沙箱拒绝时直接返回错误提示切换模式 |
| 网络认证失败自动降级 | 高 | ✅ 已修复 | 不再自动回退到 Unelevated 模式；拦截并提示用户手动切换 |
| 构建工具编译需审批影响效率 | 低 | ✅ 已修复 | 常见构建命令(mvn/gradle/npm/cargo/go等)加入安全白名单；发布/部署类子命令仍拦截 |
| PowerShell 2>&1 误拦截 | 低 | ✅ 已修复 | AST 解析器和保守解析器均支持流合并重定向（MergingRedirectionAst），不再误判为文件重定向 |
| 无可执行文件白名单 | 低 | ⚠️ 已评估，接受 | 沙箱用户可运行任何可读目录中的可执行文件，但所有进程均继承受限令牌；白名单不现实（Agent 需调用多种工具） |
| IPC 攻击面 | 低 | ⚠️ 已评估，接受 | 沙箱用户理论上可通过命名管道等 IPC 与其他进程通信；实际大多数服务的 IPC ACL 对低权限用户严格限制，攻击场景极为牵强 |
| 进程枚举信息泄露 | 低 | ⚠️ 已评估，接受 | 沙箱用户可查看系统进程列表，但无法操控；Agent 本身已有工作区读取权限，进程列表信息价值更低 |
| 脚本可删除工作区文件 | 中 | ⚠️ 设计如此 | 工作区必须可写才能正常工作；依赖 Git 版本控制恢复 |
| 脚本可读取工作区源码 | 低 | ⚠️ 设计如此 | Agent 本身就需要读取源码才能工作 |
| 非 Elevated 模式无沙箱用户隔离 | 高 | ⚠️ 已知 | 仅 Elevated 模式提供完整隔离；其他模式依赖审批 |

### 结论

**Elevated 模式并非万无一失**，但提供了纵深防御：

1. 最高价值资产（密钥、凭据）受到 OS 级别的强制保护，脚本无法绕过
2. 网络访问策略已调整为依赖公司网络策略，提升开发体验的同时保持企业级安全控制
3. 工作区文件是可接受的风险区域 — Agent 需要读写工作区才能完成任务，且可通过 Git 恢复
4. 命令安全检测采用**结构化解析**（PowerShell AST + 参数级校验），与 codex 完全对齐，而非简单的字符串前缀匹配
5. 持久化审批规则仅限构建工具类命令，解释器命令被禁止持久化，平衡了开发体验与安全性
6. 禁止命令在所有模式下（包括 YOLO）都被拦截
7. 审批通道经过多层安全加固（窗口绑定、tool_call_id 匹配、超时机制），防止伪造和重放攻击
8. 首次启动强制引导用户选择 Elevated 模式，降低因配置不当导致的安全风险
9. PowerShell 路径转义已修复，支持包含括号等特殊字符的安装路径
