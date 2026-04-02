# `.env` 加密/解密与故障处理手册

本文档按“场景化”组织，优先解决你在日常开发中最常见的问题。

目标：

- 远端仓库中的 `.env` 永远是密文
- 本地工作区中的 `.env` 可自动解密为明文，不影响运行
- CI 打包前自动解密，不影响构建

---

## 1. 基本原理（先看 1 分钟）

我们使用 Git filter：

1. `git add .env` 时触发 `clean`，将明文加密后再写入索引
2. `git checkout/pull/merge/rebase` 时触发 `smudge`，将密文解密到工作区

结论：

- Git 历史与远端：密文
- 本地运行文件：明文（前提是密钥可用）

---

## 2. 一次性初始化（每个开发者）

### 2.1 获取密钥

联系 `qyang` 获取 `ENV_ENCRYPTION_KEY`（不要在群里明文发送）。

支持格式：

- 64 位 hex
- 32-byte base64

---

### 2.2 配置 filter

在仓库根目录执行：

```bash
npm run env:filter:setup
```

它会写入本仓库 `.git/config`：

- `filter.envcrypt.clean = node scripts/env-crypt.mjs clean`
- `filter.envcrypt.smudge = node scripts/env-crypt.mjs smudge`
- `filter.envcrypt.required = true`

验证：

```bash
git config --get filter.envcrypt.clean
git config --get filter.envcrypt.smudge
git config --get filter.envcrypt.required
```

---

### 2.3 配置密钥（推荐用文件，IDE 更稳定）

```bash
mkdir -p ~/.cmbdevclaw
printf '%s\n' '你的密钥' > ~/.cmbdevclaw/env.key
chmod 600 ~/.cmbdevclaw/env.key
```

说明：使用 key 文件后，WebStorm/命令行都能读到密钥，最不容易出问题。

---

## 3. 常用操作

### 3.1 修改 `.env` 后怎么提交流程

```bash
git add .env
git commit -m "..."
git push
```

可选验证（确认暂存的是密文）：

```bash
git show :.env | head -n 1
```

若输出以 `CMBENV1:` 开头，说明提交的是密文。

---

### 3.2 本地看到密文，如何恢复成明文

```bash
rm -f .env
git checkout -- .env
```

这是当前最稳的“强制刷新解密”方式。

---

## 4. 场景化问题与解决方案

### 场景 A：切分支/rollback/rebase/merge 报错 `Missing encryption key`

典型报错：

- `[env-crypt] Missing encryption key...`
- `.env: smudge filter envcrypt failed`

原因：

- Git 在检出 `.env` 时要执行解密，但当前进程拿不到密钥

立即处理：

```bash
mkdir -p ~/.cmbdevclaw
printf '%s\n' '你的密钥' > ~/.cmbdevclaw/env.key
chmod 600 ~/.cmbdevclaw/env.key
git checkout -- .env
```

然后重试原操作（切分支/rollback/rebase/merge）。

---

### 场景 B：WebStorm 里能报错，终端里正常

原因：

- IDE 的 Git 进程不一定继承你 shell 的 `ENV_ENCRYPTION_KEY`

建议：

- 优先使用 `~/.cmbdevclaw/env.key` 文件方式，不依赖 shell 环境变量

若已配 key 文件，仍失败：

```bash
git checkout -- .env
```

然后回到 WebStorm 再操作。

---

### 场景 C：当前分支没有加密脚本，合并 main（有加密逻辑）时失败

典型报错：

- `Cannot find module .../scripts/env-crypt.mjs`

原因：

- 本地 `.git/config` 已启用 filter
- 但当前分支尚无 `scripts/env-crypt.mjs`
- Git 在真正 merge 前就先执行了 smudge，导致中断

处理步骤（先解锁再合并）：

```bash
git merge --abort || true
git rebase --abort || true

git config --local --unset filter.envcrypt.clean
git config --local --unset filter.envcrypt.smudge
git config --local --unset filter.envcrypt.required

git fetch origin
git merge origin/main
```

合并成功后恢复：

```bash
npm run env:filter:setup
git checkout -- .env
```

---

### 场景 D：`git add .env` 时报 `clean filter 'envcrypt' failed`

原因：

- 99% 是密钥缺失或 filter 未初始化

排查顺序：

```bash
git config --get filter.envcrypt.clean
git config --get filter.envcrypt.smudge
git config --get filter.envcrypt.required
```

如果为空，先执行：

```bash
npm run env:filter:setup
```

然后确保密钥可用，再重试：

```bash
git add --renormalize .env
```

---

### 场景 E：我没改 `.env`，为什么密文变化了？

当前项目已改为确定性加密：相同明文 + 相同密钥应得到相同密文。  
如果你仍看到变化，常见原因：

1. `.env` 实际内容有细微变化（空格、换行、文件末尾换行）
2. 使用了不同密钥
3. 你正在不同分支/旧脚本版本之间切换

可直接重置并验证：

```bash
rm -f .env
git checkout -- .env
git add --renormalize .env
git diff --cached .env
```

`git diff --cached .env` 为空，说明已稳定。

---

### 场景 F：CI 打包后请求 URL 变成 `file://.../undefined/...`

原因：

- 打包前没解密 `.env`，导致 `VITE_API_BASE_URL` 缺失

检查：

1. workflow 是否有 `Decrypt .env for build` 步骤
2. GitHub Secret 是否设置 `ENV_ENCRYPTION_KEY`

---

## 5. GitHub Actions 必做项

仓库必须配置 Secret：

- Key：`ENV_ENCRYPTION_KEY`
- Value：与本地相同密钥

并在构建前执行：

```bash
node scripts/env-crypt.mjs decrypt-file .env
```

---

## 6. 紧急解锁流程（“我现在完全不能 Git 操作”）

当你被 filter 卡住且手头没有密钥时，先临时关 filter：

```bash
git config --local --unset filter.envcrypt.clean
git config --local --unset filter.envcrypt.smudge
git config --local --unset filter.envcrypt.required
```

完成紧急操作（pull/merge/rebase/rollback）后，马上恢复：

```bash
npm run env:filter:setup
```

然后配置密钥并刷新 `.env`：

```bash
rm -f .env
git checkout -- .env
```

---

## 7. 安全要求

1. 密钥不要提交到仓库
2. 密钥不要写到公开文档、截图、日志
3. 新人离职或密钥泄露后立即轮换
4. 轮换后需重新加密并提交 `.env`

---

## 8. 命令速查

```bash
# 初始化 filter
npm run env:filter:setup

# 本地强制解密刷新
rm -f .env
git checkout -- .env

# 提交前重新规范化
git add --renormalize .env

# 检查暂存是否密文
git show :.env | head -n 1

# 临时关闭 filter（紧急）
git config --local --unset filter.envcrypt.clean
git config --local --unset filter.envcrypt.smudge
git config --local --unset filter.envcrypt.required
```

