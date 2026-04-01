# `.env` 加密与使用完整指南

本文档用于指导团队成员在本项目中安全使用 `.env`：

- 远端仓库中 `.env` 永远是加密内容
- 本地工作区中的 `.env` 可以自动解密为明文，不影响运行
- GitHub Actions 打包前自动解密，不影响构建

---

## 1. 先理解目标（必须读）

我们用 Git filter 做“透明加解密”：

1. `git add .env` 时：自动执行 `clean` 过滤器，把明文加密后再写入 Git 索引（最终推到远端的是密文）
2. `git checkout/pull` 时：自动执行 `smudge` 过滤器，把仓库里的密文解密到工作区（本地文件是明文）

所以：

- Git 历史与远端仓库：密文
- 本地运行时文件：明文（前提是你配置了密钥）

---

## 2. 一次性准备（每个开发者都要做）

### 2.1 获取密钥

联系 `qyang` 获取同一个 `ENV_ENCRYPTION_KEY`（不要在群里明文发）。

格式支持二选一：

- 64位 hex（推荐）
- 32-byte base64

密钥属于敏感信息，本文档不提供示例值。

---

### 2.2 配置本地 Git filter（只需一次）

在项目根目录执行：

```bash
npm run env:filter:setup
```

该命令会在你的本地仓库 `.git/config` 写入：

- `filter.envcrypt.clean = node scripts/env-crypt.mjs clean`
- `filter.envcrypt.smudge = node scripts/env-crypt.mjs smudge`
- `filter.envcrypt.required = true`

验证是否配置成功：

```bash
git config --get filter.envcrypt.clean
git config --get filter.envcrypt.smudge
git config --get filter.envcrypt.required
```

---

### 2.3 配置密钥（两种方式，任选其一）

#### 方式 A：环境变量（推荐给个人开发环境）

临时生效（当前终端）：

```bash
export ENV_ENCRYPTION_KEY=你的密钥
```

永久生效（zsh）：

```bash
echo 'export ENV_ENCRYPTION_KEY=你的密钥' >> ~/.zshrc
source ~/.zshrc
```

验证：

```bash
echo $ENV_ENCRYPTION_KEY
```

---

#### 方式 B：密钥文件（推荐给共享机器/CI风格环境）

```bash
mkdir -p ~/.cmbdevclaw
printf '%s\n' '你的密钥' > ~/.cmbdevclaw/env.key
chmod 600 ~/.cmbdevclaw/env.key
```

脚本默认读取：

`~/.cmbdevclaw/env.key`

你也可自定义：

```bash
export ENV_ENCRYPTION_KEY_FILE=/custom/path/env.key
```

---

## 3. 首次拉代码后的正确流程（新同事必做）

按顺序执行：

1. `git clone ...`
2. `cd 项目目录`
3. `npm run env:filter:setup`
4. 配置 `ENV_ENCRYPTION_KEY`（或 `~/.cmbdevclaw/env.key`）
5. 执行一次检出刷新：

```bash
git checkout -- .env
```

如果成功，你本地 `.env` 应该是可读明文。

---

## 4. 现有仓库从“明文提交”迁移到“密文提交”的步骤（维护者执行）

如果仓库已经在追踪 `.env`，执行以下步骤让后续提交都变密文：

1. 确保本地已完成第 2 节配置
2. 在项目根目录执行：

```bash
git add --renormalize .env
```

3. 查看暂存差异：

```bash
git diff --cached .env
```

你应看到 `.env` 内容变成类似 `CMBENV1:...` 的密文格式

4. 提交并推送：

```bash
git commit -m "chore: store encrypted .env via git filter"
git push
```

---

## 5. 日常开发流程（开发者）

### 5.1 修改 `.env`

直接改本地 `.env` 明文即可，像平常一样运行项目。

### 5.2 提交

直接 `git add .env` + `git commit`。

Git 会自动加密后再写入索引与远端。

### 5.3 自检（可选但推荐）

检查 Git 索引里的 `.env` 是否密文：

```bash
git show :.env | head -n 1
```

如果输出以 `CMBENV1:` 开头，说明将提交的是密文。

---

## 6. GitHub Actions 配置（必须）

本项目工作流会在打包前执行：

```bash
node scripts/env-crypt.mjs decrypt-file .env
```

所以你必须在 GitHub 仓库里配置 Secret：

- 名称：`ENV_ENCRYPTION_KEY`
- 值：与团队本地一致的同一个密钥

配置路径：

1. GitHub 仓库页面
2. `Settings`
3. `Secrets and variables`
4. `Actions`
5. `New repository secret`

---

## 7. 如何确认“远端一定是密文”

方法一：看 PR 的 `.env` diff，不应出现明文键值对。  
方法二：拉取到一个没有密钥的新环境中，仓库里的原始 `.env` 应是 `CMBENV1:...` 格式。  
方法三：本地查看索引：

```bash
git show :.env | head -n 1
```

---

## 8. 常见问题排查

### 8.1 报错：`Missing encryption key...`

原因：当前 shell 没有密钥。

处理：

1. `echo $ENV_ENCRYPTION_KEY` 检查是否为空
2. 为空就重新 `export ENV_ENCRYPTION_KEY=...`
3. 或写入 `~/.cmbdevclaw/env.key`

---

### 8.2 报错：`clean filter 'envcrypt' failed`

通常是上面的密钥缺失导致。  
也可能是没执行 `npm run env:filter:setup`。

处理顺序：

1. `npm run env:filter:setup`
2. 配好密钥
3. 重新执行 `git add --renormalize .env`

---

### 8.3 拉代码后 `.env` 还是密文

说明 `smudge` 没生效，检查：

1. 是否执行过 `npm run env:filter:setup`
2. 密钥是否可读（环境变量或 key 文件）
3. 执行：

```bash
git checkout -- .env
```

---

### 8.4 CI 里接口地址变成 `undefined/...`

通常是 CI 未成功解密 `.env` 或缺失 `ENV_ENCRYPTION_KEY` Secret。

检查：

1. Workflow 是否有 `Decrypt .env for build` 步骤
2. GitHub Secret `ENV_ENCRYPTION_KEY` 是否存在且正确

---

## 9. 安全注意事项（务必遵守）

1. 不要把密钥提交到仓库
2. 不要把密钥写到公开文档/截图/日志
3. 新人离职或密钥泄露时，立即轮换密钥
4. 密钥轮换后，需要重新加密并提交 `.env`

---

## 10. 关键命令速查

```bash
# 1) 配置 git filter（一次性）
npm run env:filter:setup

# 2) 设置密钥（当前终端）
export ENV_ENCRYPTION_KEY=你的密钥

# 3) 将 .env 重新规范化为密文提交内容
git add --renormalize .env

# 4) 查看索引中的 .env 是否已加密
git show :.env | head -n 1
```
