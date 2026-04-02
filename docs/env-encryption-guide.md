# `.env` 加密命令速查

核心只看这 4 个命令：

```bash
# 开启加密过滤器（当前仓库）
npm run env:filter:setup

# 关闭加密过滤器（当前仓库）
npm run env:filter:disable

# 快速加密（把 .env 重新按规则入索引）
npm run env:encrypt:quick

# 快速解密（把本地 .env 刷新为明文）
npm run env:decrypt:quick
```

---

## 推荐日常流程

1. 首次进入仓库：

```bash
npm run env:filter:setup
```

2. 配置密钥（联系 `qyang` 获取）  
推荐 key 文件方式（WebStorm/终端都稳定）：

```bash
mkdir -p ~/.cmbdevclaw
printf '%s\n' '你的密钥' > ~/.cmbdevclaw/env.key
chmod 600 ~/.cmbdevclaw/env.key
```

3. 本地若看到密文 `.env`：

```bash
npm run env:decrypt:quick
```

4. 修改 `.env` 后准备提交：

```bash
npm run env:encrypt:quick
git commit -m "..."
git push
```

---

## 常见问题（按命令处理）

### 1) 切分支/merge/rebase/rollback 报错 `Missing encryption key`

先配密钥，再执行：

```bash
npm run env:decrypt:quick
```

然后重试 Git 操作。

### 2) 当前分支没有加密脚本，导致 `Cannot find module scripts/env-crypt.mjs`

先临时关闭：

```bash
npm run env:filter:disable
```

完成 `pull/merge` 后再恢复：

```bash
npm run env:filter:setup
npm run env:decrypt:quick
```

### 3) WebStorm 里报错但终端正常

通常是 IDE 读不到环境变量。  
用 key 文件方式（上面步骤）后，再执行：

```bash
npm run env:decrypt:quick
```

---

## CI 必要配置

GitHub Actions 必须配置：

- Secret 名称：`ENV_ENCRYPTION_KEY`
- 值：与本地相同密钥

