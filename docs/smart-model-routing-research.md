# AI Agent 智能模型路由技术调研报告

> **项目**: cmbCowork 桌面 AI Agent 应用
> **目标**: 在企业级 AI 应用中通过智能模型调度降低 TCO
> **日期**: 2026-03-18
> **分支**: feature/smart-model-routing

---

## 目录

- [一、调研背景](#一调研背景)
- [二、技术路线总览与对比](#二技术路线总览与对比)
  - [2.1 规则路由](#21-规则路由rule-based-routing)
  - [2.2 复杂度路由](#22-复杂度路由complexity-based-routing)
  - [2.3 分类器路由](#23-分类器路由classifier-routing)
  - [2.4 语义路由](#24-语义路由semantic-routing)
  - [2.5 级联/降级路由](#25-级联降级路由cascadefallback-routing)
  - [2.6 成本感知路由](#26-成本感知路由cost-aware-routing)
  - [2.7 强化学习路由](#27-强化学习路由rl-routing)
  - [2.8 Cache-Aware Routing](#28-cache-aware--infra-aware-routing新兴方向)
  - [2.9 技术路线综合对比](#29-技术路线综合对比)
- [三、行业产品实践与技术路线](#三行业产品实践与技术路线)
  - [3.1 GitHub Copilot](#31-github-copilot--启发式--基础设施感知)
  - [3.2 Notion AI](#32-notion-ai--任务类别路由--llm-as-judge-评估闭环)
  - [3.3 OpenAI GPT-5](#33-openai-gpt-5--mixture-of-models)
  - [3.4 Martian](#34-martian--机制可解释性路由)
  - [3.5 Cursor IDE](#35-cursor-ide--启发式--向量检索)
  - [3.6 OpenRouter](#36-openrouter--auto-router--provider-聚合)
  - [3.7 Unify.ai](#37-unifyai--benchmark-驱动的质量-成本优化)
  - [3.8 Not Diamond](#38-not-diamond--embedding--随机森林路由)
  - [3.9 云厂商托管路由](#39-云厂商托管路由)
  - [3.10 产品实践对比总结](#310-产品实践对比总结)
- [四、开源框架技术分析](#四开源框架技术分析)
  - [4.1 LiteLLM](#41-litellm)
  - [4.2 Portkey AI Gateway](#42-portkey-ai-gateway)
  - [4.3 RouteLLM (LMSYS)](#43-routellm-lmsys)
  - [4.4 Semantic Router](#44-semantic-router)
  - [4.5 开源框架对比](#45-开源框架对比)
- [五、项目落地可行性分析](#五项目落地可行性分析)
  - [5.1 当前代码现状](#51-当前代码现状)
  - [5.2 桌面 Agent 场景特殊性](#52-桌面-agent-场景特殊性)
  - [5.3 技术路线适配性评估](#53-技术路线适配性评估)
  - [5.4 向量/Embedding 路由技术深度辨析](#54-向量embedding-路由技术深度辨析)
  - [5.5 推荐方案与架构](#55-推荐方案与架构)
  - [5.6 分阶段路线图](#56-分阶段路线图)
  - [5.7 预期 TCO 影响](#57-预期-tco-影响)
  - [5.8 风险与挑战](#58-风险与挑战)
  - [5.9 路由质量评估维度](#59-路由质量评估维度补充)
  - [5.10 路由发布流程建议](#510-路由发布流程建议)
- [六、参考资料](#六参考资料)

---

## 一、调研背景

### 1.1 问题定义

企业级 AI 应用的 LLM 推理成本持续增长。

> **数据时效性说明**：以下市场规模、估值、价格类数字时效性极强，均为截至 2026-03 的快照数据，仅供量级参考。

据行业数据（2025 H1），企业 LLM 支出约 84 亿美元，近 40% 的企业每年 LLM 支出超过 25 万美元。

不同模型之间存在巨大的成本差异（截至 2026-03 的近似价格）：

| 模型层级 | 代表模型 | 输入价格（/百万 token） | 输出价格（/百万 token） |
|---------|---------|----------------------|----------------------|
| Premium | GPT-4, Claude Opus | $30-60 | $60-120 |
| Standard | GPT-4 Turbo, Claude Sonnet | $10-15 | $30-60 |
| Economy | GPT-3.5, Claude Haiku | $0.50-2 | $1-4 |

核心矛盾：**并非所有任务都需要 Premium 模型**。行业数据显示 30-60% 的查询可以由 Economy 模型高质量完成。

### 1.2 调研范围

1. 智能模型路由的技术路线分类与对比
2. 行业标杆产品的具体技术实现
3. 主流开源框架的技术分析
4. 本项目（cmbCowork 桌面 AI Agent）的落地可行性评估

---

## 二、技术路线总览与对比

### 2.1 规则路由（Rule-Based Routing）

**原理**：基于预定义规则（关键词、模式匹配、任务类型标签）做路由决策。

**技术实现**：
- If/Then 条件分支
- 正则表达式匹配
- 任务类型枚举映射
- 上下文长度阈值判断

**优势**：
- 零延迟开销（无额外模型调用）
- 完全确定性，可审计
- 实现简单，调试方便
- 无额外基础设施依赖

**劣势**：
- 无法处理语义模糊的请求
- 规则维护成本随复杂度指数增长
- 容易漏覆盖边缘情况

**适用场景**：任务模式可预测、分类边界清晰的场景。

**成本节约**：30-50%（视规则覆盖率）

---

### 2.2 复杂度路由（Complexity-Based Routing）

**原理**：评估用户请求的复杂度，简单任务路由到便宜模型，复杂任务路由到贵模型。

**技术实现**：
- **特征工程**：提取 prompt 长度、词汇复杂度、句法结构、领域术语密度等
- **轻量分类器**：训练二分类或多分类模型（如 Logistic Regression, XGBoost）判断复杂度
- **kNN 路由**：研究表明简单的 kNN 即可达到接近最优的路由准确率

**代表项目**：RouteLLM (LMSYS), NVIDIA LLM Router Blueprint

**成本节约**：
- RouteLLM 官方论文表述为"reduce costs by over 2x without sacrificing response quality"
- 具体数据（需注意 benchmark 设置与模型对）：MT-Bench ~85%、MMLU ~45% 成本节约
- 在特定配置下达到 GPT-4 约 95% 的性能

**学术支撑**：
- ICLR 2025 论文表明简单非参数方法（kNN）在样本复杂度较低时即可达到强路由效果
- RAG 场景中复杂度路由可实现 27-55% 成本降低

---

### 2.3 分类器路由（Classifier Routing）

**原理**：使用小型 ML 模型作为路由分类器，分析 query 内容后决定路由。

**技术实现**：

| 分类器类型 | 模型 | 延迟 | 准确率 | 适用场景 |
|-----------|------|------|--------|---------|
| BERT-based | BERT-Base (110M) | 5-20ms | 高 | 通用文本分类 |
| Causal LLM | Llama3-8B fine-tuned | 50-100ms | 最高 | 需要理解推理意图 |
| Matrix Factorization | 低秩矩阵分解 | <5ms | 中 | 已知模型-query 偏好矩阵 |
| Linear Probe | 线性分类器 on embeddings | <5ms | 中-高 | 需极低延迟 |

**RouteLLM 的 4 种路由器**：
1. **sw_ranking**：基于 Chatbot Arena 人类偏好数据训练的排序模型
2. **bert**：BERT 分类器，预测 query 是否需要强模型
3. **causal_llm**：用 Llama3-8B 微调，上下文学习做路由判断
4. **mf (Matrix Factorization)**：低秩分解模型-query 交互矩阵

**NVIDIA LLM Router Blueprint**：
- 使用意图路由器（Qwen 1.75B）匹配用户意图
- CLIP embedding + 训练的神经网络做 auto-routing
- 支持自定义训练数据集

**关键发现**：LLM-based 分类器总体表现最好，但延迟也最高。生产中通常用 BERT 级别做平衡。

---

### 2.4 语义路由（Semantic Routing）

**原理**：将 query 转换为 embedding 向量，通过语义相似度匹配到预定义的路由路径。

**技术实现**：
1. 预定义每个路由的示例 utterances（如 "编程相关" → 10 条示例）
2. 将 utterances 和 query 都转为 embedding
3. 计算 cosine 相似度
4. 相似度 > 阈值 → 路由到对应模型

**Embedding 模型选择**：
- `text-embedding-ada-002`（OpenAI）
- `all-MiniLM-L6-v2`（开源，384 维）
- `ModernBERT`（vLLM Semantic Router 使用）

**vLLM Semantic Router (Iris) 性能数据**：
- 复杂任务准确率提升 10.2%
- 延迟降低 47.1%
- Token 使用减少 48.5%
- 声称路由速度提升 98x（使用 Flash Attention）

**优势**：
- 能捕获语义意图（非精确关键词匹配）
- 查询速度快（单次 embedding + 向量检索）
- 可扩展（新增路由只需添加示例）

**劣势**：
- 需要足够覆盖所有任务类型的参考 prompt 集
- 引入 embedding 模型依赖
- 维护参考集有持续成本

---

### 2.5 级联/降级路由（Cascade/Fallback Routing）

**原理**：从最便宜的模型开始尝试，如果输出质量不达标，逐级升级到更贵的模型。

**技术实现**：

```
请求 → Economy 模型 → 质量评估 → 达标? → 返回
                                    ↓ 不达标
                              Standard 模型 → 质量评估 → 达标? → 返回
                                                          ↓ 不达标
                                                    Premium 模型 → 返回
```

**质量评估方法**：
- 模型输出置信度（logprobs）
- LLM-as-Judge（用另一个模型判断质量）
- 规则校验（格式、长度、关键词检查）
- 人类反馈信号

**代表项目**：FrugalGPT (Stanford)

**FrugalGPT 三大策略**：
1. **Prompt Adaptation**：修改 prompt 适配便宜模型
2. **LLM Approximation**：用小模型近似大模型输出
3. **LLM Cascade**：渐进式升级

**成本节约**：最高 98%，同时匹配最佳单模型性能，甚至在同成本下准确率提升 4%

**劣势**：
- 延迟增加（可能多次调用）
- 质量评估本身有成本
- 对有副作用的操作不安全（如文件写入后不能重试）

---

### 2.6 成本感知路由（Cost-Aware Routing）

**原理**：在满足质量约束的前提下，选择成本最低的模型。

**技术实现**：
- 维护模型成本表（input/output token 单价）
- 设定质量约束（最低可接受的 benchmark 分数）
- 在约束下求解最优模型

**高级变体**：
- **CSCR (Cost-Aware Semantic Contrastive Routing)**：将成本约束嵌入语义对比学习，准确率-成本权衡提升 25%
- **Quality-Latency Aware Routing**：同时优化质量、延迟、成本三个维度

**实际应用**：
- 用户设定预算上限（如每月 $100）
- 路由器动态调整模型选择以控制在预算内
- 实时追踪累计成本并触发降级

---

### 2.7 强化学习路由（RL Routing）

**原理**：将路由决策建模为序列决策问题，用强化学习优化路由策略。

**代表项目**：

| 项目 | 方法 | 特点 |
|------|------|------|
| **HierRouter** | PPO-based RL agent | 分层路由，迭代选择模型组装推理流水线 |
| **xRouter** | RL with economic constraints | 显式经济约束，异构难度输入 + 异构模型能力/价格 |
| **DiSRouter** | 分布式自路由 | 每个 LLM 学习本地"自评估"策略，决定回答还是转发 |

**优势**：
- 适应变化的成本/性能格局
- 可处理复杂约束
- 长期优化

**劣势**：
- 需要大量标注数据和稳定的反馈信号
- 训练成本高
- 冷启动问题严重
- **不适合起步阶段**

---

### 2.8 Cache-Aware / Infra-Aware Routing（新兴方向）

**原理**：路由决策不仅考虑模型能力和成本，还考虑底层推理基础设施的状态——特别是 KV-cache 命中率、prefix cache locality、prefill/decode 调度。

**为什么重要**：
- 模型单价表上的价格不等于**真实推理成本**
- Prefix cache 命中可将实际成本降低 50-90%（Anthropic 官方数据）
- 如果路由决策频繁切换模型，会破坏 prefix cache 连续性，反而增加成本
- 对 Agent 场景尤其关键：多轮对话的 system prompt + 工具描述前缀通常是稳定的

**技术实现**：
- 路由器在决策时考虑：当前 session 正在使用哪个模型（cache affinity）
- 除非有明确的质量/成本收益，否则倾向于保持同一模型（减少 cache miss）
- llm-d Inference Scheduler 等项目正在探索推理层的智能调度

**对本项目的启示**：
- Phase 1 的"Run 级模型冻结"天然符合 cache-aware 原则
- 频繁切换模型的路由策略可能适得其反
- 评估 TCO 时需考虑 cache 命中率，而非仅看 token 单价

---

### 2.9 技术路线综合对比

| 维度 | 规则路由 | 复杂度路由 | 分类器路由 | 语义路由 | 级联路由 | 成本感知 | RL 路由 |
|------|---------|-----------|-----------|---------|---------|---------|--------|
| **路由延迟** | ~0ms | 5-20ms | 5-100ms | 5-20ms | N/A（多次调用） | ~0ms | 5-20ms |
| **实现复杂度** | 低 | 中 | 中-高 | 中 | 中 | 低-中 | 高 |
| **成本节约** | 30-50% | 45-85% | 35-85% | ~48% | 最高 98% | 30-70% | 研究中 |
| **质量保障** | 依赖规则质量 | 依赖分类准确率 | 依赖训练数据 | 依赖 utterance 覆盖 | 内建质量检查 | 显式约束 | 学习优化 |
| **冷启动** | 即用 | 需标注数据 | 需训练数据 | 需示例集 | 即用 | 需成本数据 | 需大量数据 |
| **维护成本** | 规则膨胀 | 模型迭代 | 数据集更新 | utterance 维护 | 质量评估维护 | 价格表更新 | 持续训练 |
| **适合阶段** | MVP | 中期 | 中期 | 中期 | 成熟期 | 全程（横切） | 成熟期 |

**关键结论**：实际生产系统**几乎都采用混合策略**，而非单一路线。典型组合是 "规则路由 fast path + 分类器/语义路由处理模糊样本 + 成本感知做横切约束 + fallback 保可靠性"。

---

## 三、行业产品实践与技术路线

### 3.1 GitHub Copilot — 启发式 + 基础设施感知

**产品定位**：代码 AI 助手，集成在 VS Code / JetBrains 等 IDE 中

**路由技术**：**混合启发式路由**（非 ML 分类器）

**路由信号**：

| 信号类型 | 具体内容 |
|---------|---------|
| 请求来源 | 内联编辑器 / 聊天窗口 / PR Review |
| 内容类型 | 代码片段 / 指令 / 错误日志 / 自然语言 |
| 输入规模 | Token 数 / Prompt 长度 |
| 模态 | 纯文本 / 代码 / 图片 / 文件 |
| 工具钩子 | 测试 / 终端 / 文档引用 |
| 基础设施状态 | 模型可用性 / 负载 / 延迟 |

**技术本质**：轻量路由器问一系列启发式问题 —— "这是快速补全？" "需要多步推理？" "需要更宽上下文？" —— 匹配到模型能力级别。

**模型池**（随时间变化）：GitHub 官方文档示例包含 GPT-4.1, GPT-5.2-Codex, GPT-5.3-Codex, Claude Haiku 4.5, Claude Sonnet 4.5, Grok Code Fast 1, Raptor mini 等。具体可用模型取决于用户 plan 和 workspace 策略。

**当前状态**：GitHub 官方文档明确说明，Auto 当前**主要按模型可用性选择**，任务类型感知是 "coming soon" 的能力。

**Fallback**：模型过重 / 受限 / 超出 plan → 自动降级到轻量模型。付费用户选择 auto 享受 10% 折扣。

**评价**：
- 优势：简单可靠，基础设施感知提高可用性
- 不足：当前不是 task-aware 的 ML 分类，对任务语义理解有限
- task-aware 路由仍在路线图中，尚未完全落地

---

### 3.2 Notion AI — 任务类别路由 + LLM-as-Judge 评估闭环

**产品定位**：协作知识管理平台的 AI 功能

**路由技术**：**显式任务类别路由 + Fine-tuned 专用模型 + Trace 驱动评估闭环**

**任务分类与模型匹配**：

| 任务类型 | 路由目标 | 选型依据 |
|---------|---------|---------|
| 写作（产品规格书等） | 高推理模型（GPT-4.1, Claude Opus 4） | 流畅性、结构一致性、语音统一 |
| 搜索 / QA | 大上下文窗口模型 | 穷举推理、来源引用能力 |
| 自动填充 / 字段补全 | **自研 fine-tuned 小模型** | 延迟减半、质量提升、成本极低 |

**核心技术亮点**：

1. **Fine-tuned 专用模型**：对高频低复杂度任务（如表单自动填充）训练专用小模型，不使用通用大模型。延迟减半，质量反而提升。
2. **Block 结构化上下文**：Notion 中每个段落、任务、数据库条目都是带元数据的 Block。路由器理解工作区结构关系，而非仅做关键词匹配。
3. **LLM-as-Judge 持续评估**：新模型发布后数小时内完成评估并部署上线。
4. **Braintrust Trace 驱动闭环**：

```
生产 Trace → 数据集提取 → 自动化评估 → 质量评分 → 反馈路由策略
```

- AI 团队 80% 的工作基于 trace 驱动评估
- 团队每天处理 30 个 issue（10x 效率提升）
- 使用 Brainstore 数据库做 trace 搜索

**评价**：
- **这是所有标杆中最成熟的反馈闭环**
- Fine-tuned 专用模型是降本利器，但需要有足够的任务量支撑微调
- Block 结构化上下文是 Notion 特有优势，其他产品难以直接复制

---

### 3.3 OpenAI GPT-5 — 统一系统 + 内部路由（公开信息有限）

**产品定位**：通用 AI 助手

**路由技术**：**内部路由（公开信息有限，以下含推断成分）**

> **信息来源说明**：OpenAI 官方公开说法是 GPT-5 是一个"知道何时快速回答、何时花更多时间思考的统一系统"。以下部分内容基于公开行为和二手分析的推断，并非 OpenAI 完整披露的系统架构。

**可观察到的行为模式**：

```
用户请求 → 内部路由 → 快速响应路径（常规任务）
                    → 深度推理路径 GPT-5-thinking（复杂问题）
```

**推断的路由信号**：
- 对话类型（日常聊天 / 专业分析 / 代码编写）
- 复杂度信号
- 工具需求
- 用户显式意图

**训练方式（基于公开信息推断）**：
- 用户手动切换模型的行为 → 作为路由偏好训练信号
- 回答偏好率（A/B 测试）
- Holdout 集上的准确度测量

**安全路由系统**：
- OpenAI 已公开说明会对高风险/情绪脆弱类对话做额外安全处理
- 有二手分析称存在多个自动对话分类器，覆盖孤独感、脆弱性等维度，但具体数量和分类体系不宜写成确定事实
- 逐消息路由（非逐对话）

**行业意义**：
- 从 MoE（模型内部专家路由）到"Mixture of Models"（模型间路由）被认为是行业趋势
- 持续从用户行为学习路由策略是闭环最短的方式
- 安全路由对企业 Agent 有参考价值（如代码安全审查触发升级）

---

### 3.4 Martian — 机制可解释性路由

**产品定位**：AI 路由平台，300+ 企业客户（Amazon, Zapier 等）

**路由技术**：**基于模型内部机制的可解释性分析**

**Model Mapping 技术核心**：
- 将不透明 LLM 黑盒转换为可解释形式
- 神经网络 → 人类可读程序 / 可执行代码
- 目的：深度理解模型能力后构建精准路由器

**具体 ML 技术栈**：

| 技术 | 作用 |
|------|------|
| **Sparse Autoencoders (SAEs)** | 从模型激活中提取可解释的单义特征 |
| **Circuit Analysis** | 找到对应特定行为/能力的稀疏子图 |
| **Activation Analysis** | 分析内部层激活来判断信息存在性 |
| **RouteSAE** | 动态分配跨层激活权重 |
| **Probe Networks** | 在内部激活上训练线性分类器，测试特定信息 |

**工作原理**：不需要实际运行目标模型即可预测其在特定 query 上的表现——通过分析模型内部结构做路由决策。

**RouterBench 开源基准**：
- 覆盖 11 个代表性 LLM
- 405K+ 推理结果数据集
- 领域：常识推理、QA、对话、数学、编程、RAG
- 提供 AIQ 评估指标

**Embedding 路由层**（面向企业客户的实用路由）：
- 对每个请求做 embedding
- 匹配历史请求中"哪个模型性价比最好"的经验数据
- 宣称可降低 40-70% 成本，质量损失 < 2%
- 核心卖点：同样质量，自动选最便宜的模型

**成本节约**：20-96%（官方声称），典型场景 40-70%

**商业信息**：
- 融资 $9M
- 300+ 企业客户（Amazon, Zapier 等）
- Accenture 战略投资
- VP of Research 来自 Google DeepMind + Anthropic 可解释性团队

**评价**：
- 拥有两层技术：底层 SAE/Circuit Analysis（学术前沿）+ 上层 Embedding 路由（实用落地）
- 底层技术实施门槛极高，但上层 Embedding 路由思路可参考
- RouterBench 作为评估基准有直接参考价值

---

### 3.5 Cursor IDE — 启发式 + 向量检索

**产品定位**：AI 代码编辑器

**路由技术**：**启发式 + 质量检测自动切换**

**Auto 模式机制**：
- 选择"最适合当前任务的 premium 模型"
- 检测到输出质量下降 → **逐消息自动切换模型**
- 优化可靠性而非一致性
- 部分请求（如摘要）无论用户选择什么都路由到 OpenAI
- 明确声明**非 task-aware**（非基于任务类型的 ML 分类）

**关键基础设施 — Turbopuffer 向量引擎**：

| 指标 | 数据 |
|------|------|
| 向量规模 | 100B+ |
| P99 延迟 | 200ms |
| 成本降低 | 20x（vs 传统向量 DB） |
| QPS | 1M+（主要是小型自动补全请求） |
| 成本下降 | 95%（2023.11 迁移后） |

- Cursor 自研 embedding 模型做代码 chunk + embedding
- 只存混淆后的向量表示，代码从不持久存储
- Serverless 架构，对象存储冷层

**社区反馈**：
- 用户持续请求 "LLM routing 替代 heuristic-based auto"
- 有提案建议轻量 LLM 评估器先判断任务复杂度
- 当前测试显示 Auto 模式与手动选 Sonnet 表现接近

**评价**：
- 路由策略相对简单，核心竞争力在 embedding 检索和代码上下文理解
- 逐消息质量检测切换是实用但粗糙的 fallback 策略
- 社区对更智能路由有明确需求

---

### 3.6 OpenRouter — Auto Router + Provider 聚合

**产品定位**：LLM API 聚合平台，提供 500+ 模型的统一访问入口

**路由技术**：**黑盒 Auto Router + Provider 负载均衡 + Fallback**

**Auto Router 机制**：
- OpenRouter 官方称使用 "meta-model" 对 prompt 做分析并路由到候选模型
- 具体路由算法和信号**实现细节未公开**
- 路由延迟约 25-40ms

> **注**：部分二手资料称 OpenRouter 的 Auto Router 由 Not Diamond 驱动，但在 OpenRouter 官方文档中未找到一手确认。此处将其表述为实现细节未公开的黑盒路由。

**Provider 负载均衡**（自建）：
- 优先选择最近 30 秒无故障的 Provider
- 按价格倒数平方做权重随机化
- 支持两种分区策略：按模型分组（默认） / 全局排序
- Fallback 触发条件：上下文长度超限、限速、内容审查、Provider 宕机

**特色能力**：
- `:nitro` 后缀 — 最高吞吐路由变体
- `:floor` 后缀 — 最低价格路由变体
- `exacto` 端点 — 工具调用成功率更高的子集
- 响应 metadata 中透出实际选用的模型

**商业信息**：
- 创始人 Alex Atallah（OpenSea 联合创始人/前 CTO）
- 融资 $40M（a16z $12.5M seed + Menlo Ventures $28M Series A）
- 估值 $5 亿
- 推理支出从 2024 年底 $19M/年 → 2025.5 突破 $100M/年

**评价**：
- 本质是 Provider 聚合层 + Not Diamond 路由能力的组合
- 路由算法不透明，无法定制
- 优势在于 500+ 模型覆盖和零加价透明定价
- 适合不想深入路由细节、只想"接入即用"的团队

---

### 3.7 Unify.ai — Benchmark 驱动的质量-成本优化

**产品定位**：基于实时 benchmark 数据做模型路由优化的平台

**路由技术**：**神经网络质量预测 + 实时 benchmark 数据 + 用户可配权重**

**核心技术创新 — 实时 benchmark 驱动路由**：

传统 benchmark 是静态的一次性评测。Unify 的关键洞察是：**静态基准测试不可靠，需要时序视角**。

| 维度 | 传统 benchmark | Unify 实时 benchmark |
|------|---------------|---------------------|
| 更新频率 | 一次性 | 每 10 分钟 |
| 测试维度 | 能力评分 | 能力 + 延迟 + 成本 + 稳定性 |
| 地域感知 | 无 | 亚洲/美国/欧洲分别测试 |
| 并发测试 | 无 | 不同并发级别 |
| 序列长度 | 固定 | 多种序列长度 |

**路由流程**：
1. 神经网络在 benchmark 数据集上训练质量预测模型
2. 结合实时 Provider 指标（速度、成本、延迟）
3. 用户设定 quality / cost / latency 三维权重
4. 对每个请求单独评估，路由到当前最优端点

**自定义路由器**：
- 用户可上传私有 prompt 数据集训练专用路由器
- 路由器学习在用户特定任务分布上的最优模型选择
- 支持企业本地部署（fine-tune 小模型 + 自定义路由器分发流量）

**性能数据**（MT-Bench 对比）：
- Unify AI：8.76 分（45.6% GPT-4 调用量）
- 对比 Martian：8.31 分（~50% GPT-4 调用量）
- Unify 在更少 GPT-4 调用下达到更高分数

**模型池**：21+ 模型，来自 Anyscale, Perplexity, Replicate, Together AI, OctoAI, Mistral, OpenAI

**商业信息**：
- 2024 年收入估计 $4.5M+，32 人团队
- 月增长率 17%（2025.6）
- 客户：Lattice, Justworks, OpenPhone
- 定价：免费 / $1,000/月（全额抵扣用量）/ 企业定制

**评价**：
- **实时 benchmark 是最核心的差异化**——解决了静态评测与实际表现脱节的问题
- 用户可设权重的三维优化（quality/cost/latency）非常实用
- 自定义路由器训练是企业级特性
- 适合有特定任务分布、需要精细控制路由策略的团队

---

### 3.8 Not Diamond — Embedding + 随机森林路由

**产品定位**：AI 模型路由器，自称 "meta-LLM"

**路由技术**：**Prompt Embedding + 随机森林分类器 (RoRF) + 专有 Meta-Model**

**开源组件 — RoRF（Routing on Random Forests）**：

| 维度 | 详情 |
|------|------|
| 算法 | Random Forest 分类器（默认 100 棵树，最大深度 20） |
| 输入特征 | Prompt embedding 向量 |
| 输出 | 四分类：A 对 B 错 / 两者都对 / 两者都错 / A 错 B 对 |
| 路由策略 | 概率性软路由（阈值可调），非硬二分 |
| Embedding 选择 | Jina v3（开源）或 Voyage Large 2（商用） |
| 预训练路由器 | 12 个（6 Jina + 6 Voyage），覆盖常见模型组合 |

**工作原理**：
```
用户 Prompt → Embedding 模型 → 向量 → Random Forest → 每个模型的胜率预测 → 选概率最高的
```

**专有 Meta-Model**：
- 超越 RoRF 的商用路由引擎
- 支持多模型（不限二选一）
- 可配置优化目标：quality（默认）/ cost / latency
- 支持自定义 cost/latency 属性
- 自定义训练：上传 prompt + 各模型响应 + 评分 → 训练专属路由器（最长 60 分钟）

**隐私设计**：Prompt 和 API Key 不经过 Not Diamond 服务器，仅传输路由上下文

**性能声称**：
- 路由延迟 60ms
- 准确率提升最高 25%（企业 Prompt Adaptation 场景）
- 在多个 benchmark 上声称超越单一最强模型（通过组合多模型优势）

**商业信息**：
- 早期融资 $2.3M（defy.vc 领投，2024.7）
- 投资人：Jeff Dean (Google), Julien Chaumond (HuggingFace), Ion Stoica (Anyscale/Databricks), Tom Preston-Werner (GitHub), Scott Belsky (Adobe)
- IBM Ventures 投资，Accenture 合作
- SAP Sapphire 2025 发布企业级 Prompt Adaptation
- SOC-2 合规，支持零数据留存，VPC 部署

**开源贡献**：
- [RoRF](https://github.com/Not-Diamond/RoRF) — 随机森林路由器实现
- [awesome-ai-model-routing](https://github.com/Not-Diamond/awesome-ai-model-routing) — 路由资源汇总（10 个平台 + 19 篇论文）
- [notdiamond-python SDK](https://github.com/Not-Diamond/notdiamond-python)
- [Meta-Router 论文](https://arxiv.org/abs/2509.25535)

**评价**：
- **RoRF 开源是最大亮点**——完整展示了 embedding + 分类器路由的工业实现
- 概率性软路由优于硬二分，允许渐进式流量调配
- 60ms 路由延迟对实时场景可接受
- 对 cmbCowork 有直接参考价值：可复用 RoRF 的设计思路（embedding + 轻量分类器）

---

### 3.9 云厂商托管路由

> 注：以下为云平台内建的路由服务，属于**托管路由**范畴，与自建路由内核属于不同层次的选择，不宜直接横向对比。

| 平台 | 路由能力 | 核心特点 | 对本调研的价值 |
|------|---------|---------|--------------|
| **Amazon Bedrock Intelligent Prompt Routing** | 同模型家族内按 prompt 做路由 | AWS 官方称可在不明显损失准确率下降本最高 30% | 企业 build-vs-buy 的直接对照组 |
| **Azure AI Foundry `model-router`** | 统一端点从多个基础模型中智能选择 | 集成在 Azure AI 平台中，企业治理/合规友好 | 体现企业治理场景下的托管路由路线 |
| **Google Vertex AI AutoRouting** | `RoutingConfig` 支持 balanced / quality / cost 偏好 | 与 Vertex AI 生态深度集成 | 说明"云平台内建路由"已成为主流能力 |

**关键观察**：三大云厂商均已在 2025 年将模型路由作为平台级能力提供。这意味着**模型路由正从"高级优化"变成"基础设施标配"**。对于已深度绑定某云平台的企业，托管路由可能是 TCO 最低的起步方式。

---

### 3.10 产品实践对比总结

| 产品 | 路由技术 | 分类方式 | 反馈闭环 | 开源程度 | 成熟度 |
|------|---------|---------|---------|---------|--------|
| **GitHub Copilot** | 启发式 + 基础设施信号 | 规则 | 未公开 | 闭源 | 中 |
| **Notion AI** | 任务类别 + fine-tuned | 显式分类 | **Braintrust trace-driven** | 闭源 | **高** |
| **OpenAI GPT-5** | Mixture of Models | 25+ 分类器 | 用户行为持续训练 | 闭源 | 高 |
| **Martian** | 机制可解释性（SAE） | ML（模型内部分析） | RouterBench 开源 | **RouterBench 开源** | 研究级 |
| **Cursor** | 启发式 + 质量检测 | 规则 | 用户反馈 | 闭源 | 中 |
| **OpenRouter** | Not Diamond 路由 + Provider 均衡 | 黑盒（Not Diamond） | 无公开 | 闭源 | 中-高 |
| **Unify.ai** | 神经网络 + 实时 benchmark | **实时 benchmark 驱动** | benchmark 数据闭环 | SDK 开源 | 中 |
| **Not Diamond** | Embedding + 随机森林 | **RoRF（开源）** | 自定义训练 | **RoRF 开源** | 中-高 |

**路由技术维度对比**：

| 产品 | 路由延迟 | 自定义训练 | 多维优化 | 模型池规模 |
|------|---------|-----------|---------|-----------|
| GitHub Copilot | ~0ms（规则） | 否 | 否 | ~5 个 |
| Notion AI | ~0ms（分类） | 是（fine-tuned） | 否（按任务类型固定） | ~5 个 |
| OpenAI GPT-5 | 未公开 | 是（内部持续训练） | 是 | 内部模型族 |
| Martian | 未公开 | 否 | 是（quality/cost） | 任意 |
| Cursor | ~0ms（规则） | 否 | 否 | ~10 个 |
| OpenRouter | 25-40ms | 否 | 有限（:nitro/:floor） | **500+** |
| Unify.ai | ~0ms（预计算） | **是（自定义路由器）** | **是（q/c/l 三维可调）** | 21+ |
| Not Diamond | 60ms | **是（自定义训练）** | **是（quality/cost/latency）** | 任意 |

**关键洞察**：
1. **没有统一的"标准路由器"**——每家公司根据自身约束采用完全不同的架构
2. **共同趋势**：规则/启发式做 fast path + 质量评估做反馈闭环
3. **Fine-tuned 专用模型**是降本利器（Notion 实践验证）
4. **Mixture of Models**（模型间路由）是行业公认的下一代范式
5. **Embedding + 分类器**是最主流的可复制技术路线（Martian / Not Diamond / RouteLLM 都采用）
6. **实时 benchmark 数据**比静态评测更可靠（Unify.ai 的核心洞察）
7. **路由即服务（RaaS）** 正在成为独立赛道——OpenRouter $5亿估值、Not Diamond 获 IBM/Accenture 投资

---

## 四、开源框架技术分析

### 4.1 LiteLLM

| 维度 | 详情 |
|------|------|
| **定位** | Python SDK + Proxy Server，统一 100+ LLM Provider 调用接口 |
| **语言** | Python (FastAPI + Uvicorn) |
| **GitHub** | 33K stars, MIT License |
| **部署** | Docker / K8s / Helm / 裸 Python |

**路由算法（6 种）**：

| 算法 | 原理 | 数据依赖 |
|------|------|---------|
| `simple-shuffle` | 随机分发，尊重 RPM/权重限制 | 无 |
| `least-busy` | 最少并发请求，Redis 跨实例同步 | 实时并发数 |
| `usage-based` | 按 TPM 消耗最低分配 | 实时 token 计数 |
| `latency-based` | 按历史 p50/p99 延迟选最快 | 滚动延迟窗口 |
| `cost-based` | 选最便宜（需 Redis） | 价格表 + 实时消费 |
| `usage-based-v2` | 增强版，更好处理突发容量 | 实时 + 历史数据 |

**Auto-routing（内容感知路由）**：
- 基于 **Embedding 相似度**实现
- 默认使用 `text-embedding-ada-002`
- 将 query 与预设的 route utterances 做 cosine 相似度
- 超过可配阈值（0-1）→ 路由到对应模型

**Fallback 机制**：
- 指数退避 + Cooldown（故障后 60s 冷却，重复故障指数延长）
- 按异常类型配重试次数（AuthError=0, RateLimitError=5, TimeoutError=3）
- 三级 fallback：`context_window_fallbacks` / `content_policy_fallbacks` / `custom_fallback_paths`
- 可组合嵌套

**缓存（7 种后端）**：In-Memory / Disk / Redis / S3 / GCS / Qdrant 语义缓存 / Redis 语义缓存

**已知问题**：
- **500 RPS 瓶颈**——P99 延迟飙到 90s+，架构限制
- **import 耗时 3-4s**——加载所有 provider SDK，影响冷启动
- **内存 300-400MB**——对"薄代理"偏重
- **文档-代码不一致**——常见投诉
- **版本不稳定**——每天多次发版，小版本可能 break

---

### 4.2 Portkey AI Gateway

| 维度 | 详情 |
|------|------|
| **定位** | TypeScript AI Gateway，企业级可靠性 + 边缘部署 |
| **语言** | TypeScript（Cloudflare Workers 兼容） |
| **GitHub** | 10.8K stars, MIT License |
| **部署** | Cloudflare Workers（全球边缘）/ Docker / K8s / SaaS |
| **性能** | <1ms 延迟，122KB 核心体积 |

**路由策略**：
- `loadbalance`——加权负载均衡，权重归一化，实时健康调整
- `conditional`——条件路由（user tier / region / prompt 内容），可组合
- `fallback`——级联降级链 Primary → Backup-1 → Backup-2
- **可组合嵌套**——fallback 内嵌 loadbalancer + conditional

**语义缓存**：内置，embedding cosine 相似度，无需外部 Redis/Qdrant

**Guardrails（60+ 内置）**：
- 输入：Prompt 注入检测、PII 检测、格式校验
- 输出：数据泄露防护、格式合规、质量验证
- 触发动作：Block / Log / Eval / Fallback / Retry / Webhook

**多租户**：Organization → Workspace → API Key 三层隔离

**可观测性**：请求级 tracing、成本归因、延迟百分位、自定义 tag、告警

---

### 4.3 RouteLLM (LMSYS)

| 维度 | 详情 |
|------|------|
| **定位** | 开源 LLM 路由框架，专注成本-质量权衡 |
| **语言** | Python (PyTorch) |
| **论文** | "RouteLLM: Learning to Route LLMs with Preference Data", ICLR 2025 |
| **GitHub** | [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM) |
| **特点** | 5 种路由器，可跨模型对泛化，OpenAI 兼容 Server |

#### 4.3.1 核心路由决策机制

整个路由系统的核心**极其简洁**——一个抽象方法 + 一次比较：

```python
class Router(abc.ABC):
    @abc.abstractmethod
    def calculate_strong_win_rate(self, prompt) -> float:
        """返回 0-1 之间的值：强模型优于弱模型的概率"""
        pass

    def route(self, prompt, threshold, routed_pair):
        if self.calculate_strong_win_rate(prompt) >= threshold:
            return routed_pair.strong   # 路由到强模型
        else:
            return routed_pair.weak     # 路由到弱模型
```

**所有路由器的决策归结为一个标量**：`calculate_strong_win_rate` 返回一个 float，与用户指定的 `threshold` 比较。高于阈值选强模型，低于选弱模型。`threshold` 是控制质量-成本权衡的唯一旋钮。

#### 4.3.2 Controller 工作流程

1. **模型名解析**：模型名 `"router-mf-0.7"` 被解析为 `(router="mf", threshold=0.7)`
2. **路由决策**：`_get_routed_model_for_completion()` 提取最后一条消息内容，调用 `router.route(prompt, threshold, model_pair)`
3. **请求转发**：将解析出的模型名替换 `kwargs["model"]`，通过 `litellm.completion()` 或 `litellm.acompletion()` 转发
4. **计数追踪**：`self.model_counts[router][routed_model] += 1` 统计每个模型被选中的频率

**关键设计约束**：
- 只看**最后一条消息**做路由决策（`prompt = messages[-1]["content"]`），不看完整对话历史
- `model_pair` 在 Controller 初始化时固定——路由器只在**恰好 2 个模型**之间选择，不支持多模型
- 路由决策零状态——不记忆历史决策，每次独立判断

#### 4.3.3 五种路由器源码分析

##### (1) MatrixFactorizationRouter (`mf`) — 性能最佳

**模型架构**（PyTorch）：
```python
class MFModel(nn.Module):
    def __init__(self, num_models=64, embedding_dim=128, text_dim=1536):
        self.P = nn.Embedding(num_models, embedding_dim)    # 64个模型的 learned embedding
        self.text_proj = nn.Linear(text_dim, embedding_dim)  # 将 OpenAI embedding 投影到 128 维
        self.classifier = nn.Linear(embedding_dim, 1)        # 最终打分层
```

**前向推理流程**：
```
用户输入 "帮我重构这个函数，拆成三个服务层"
    ↓
OpenAI text-embedding-3-small → [0.12, 0.85, ...] (1536维)
    ↓
text_proj: Linear(1536 → 128) → prompt_embed
    ↓
P[strong_model_id] → strong_embed (128维，预训练好的)
P[weak_model_id]   → weak_embed
    ↓
logit_strong = classifier(normalize(strong_embed) * prompt_embed)   # element-wise 乘法
logit_weak   = classifier(normalize(weak_embed) * prompt_embed)
    ↓
win_rate = sigmoid(logit_strong - logit_weak)  // 如 0.82
    ↓
0.82 >= threshold(0.7) → 路由到强模型
```

**关键约束**：
- 使用硬编码的 `MODEL_IDS` 字典，映射 64 个 Chatbot Arena 模型名到整数索引
- 推理时调用 OpenAI embedding API（`text-embedding-3-small`），增加网络延迟和成本
- 预训练权重来自 HuggingFace（`routellm/mf_gpt4_augmented`）

##### (2) SWRankingRouter (`sw_ranking`) — 相似度加权 Elo

**初始化**：加载 Arena 对战数据集及其预计算 embedding，通过 `compute_elo_mle_with_tie()` 计算全局 Elo 评分，用 `compute_tiers()` 分配模型层级。

**推理流程**：
1. 用 `text-embedding-3-small` 对 prompt 做 embedding
2. 计算 prompt embedding 与所有历史对战 embedding 的 cosine 相似度
3. 将相似度转换为权重：`weight = 10 × 10^(similarity / max_similarity)` — 指数加权，偏好相似对战
4. 用加权逻辑回归重新求解 Elo 系统（`compute_elo_mle_with_tie` with `sample_weight`）
5. 查询重计算后的 Elo 中强/弱模型得分差
6. 返回 `strong_winrate = 1 - 1/(1 + 10^((strong_score - weak_score)/400))`

**特点**：每次推理都**重新求解一次 Elo 系统**——计算量最大的路由器。

##### (3) CausalLLMRouter (`causal_llm`) — 需 GPU

- 加载微调的 Llama-3-8B 模型（HuggingFace）
- 模型被训练预测 `[[1]]` ~ `[[5]]` 的难度评分
- 推理：生成一个 token，提取特殊 token 的 logits
- `binary_prob = sum(softmax_scores[threshold-1:])` — 评分 >= 阈值的概率
- 返回 `1 - binary_prob`（评分越高 = 弱模型越能处理 = 强模型 win rate 越低）
- 标记 `@no_parallel` — 需要 GPU 独占

##### (4) BERTRouter (`bert`)

- 加载微调的 BERT 序列分类器（3 类标签）
- Tokenize prompt → 推理 → softmax
- `binary_prob = sum(softmax_scores[-2:])` — 最后两个标签的概率
- 返回 `1 - binary_prob`

##### (5) RandomRouter (`random`) — 基线

- 返回 `random.uniform(0, 1)` — 纯随机路由基线

#### 4.3.4 阈值校准机制

`calibrate_threshold.py` 提供阈值设定方法：
1. **生成模式**：对 Arena 数据集所有 prompt 运行 `calculate_strong_win_rate`，保存所有分数
2. **校准模式**：给定期望的 `strong_model_pct`（如 0.5 = 50% 请求走强模型），计算 `threshold = scores.quantile(1 - strong_model_pct)`

示例：若想让 50% 请求走强模型，threshold 就是所有 win rate 分数的中位数。

#### 4.3.5 OpenAI 兼容 Server

`openai_server.py` 提供 FastAPI 服务：
- `POST /v1/chat/completions` — 标准 OpenAI 请求格式
- 模型名编码路由信息：`"router-mf-0.7"` = MF 路由器 + 阈值 0.7
- 支持 SSE streaming
- 默认模型对：`gpt-4-1106-preview`（强）/ `anyscale/mistralai/Mixtral-8x7B-Instruct-v0.1`（弱）

#### 4.3.6 核心结果

| Benchmark | 成本节约 | 质量保持 |
|-----------|---------|---------|
| MT Bench | **~85%** | GPT-4 的 95% |
| MMLU | ~45% | 高 |
| GSM8K | ~35% | 高 |

- MF 路由器用 **26% GPT-4 调用量**就达到 95% 质量水平（约 48% 便宜于随机路由）
- **跨模型泛化**：在 GPT-4/Mixtral 上训练，直接迁移到 Claude Opus/Haiku、Llama 70B/8B 仍然有效
- 效果优于 Martian 和 Unify.ai 商业方案

#### 4.3.7 关键设计观察（对本项目的启示）

| 观察 | 对 cmbCowork 的影响 |
|------|-------------------|
| 所有路由基于**单个标量**（win_rate vs threshold） | 设计极简，可直接借鉴 |
| 只看**最后一条消息** | 对多轮对话场景不足，需补充上下文长度等信号 |
| MF/SW 路由器依赖 **OpenAI embedding API** | 桌面端增加网络延迟，需替换为本地 embedding |
| MF 模型绑定 **64 个特定 Arena 模型 ID** | 自定义模型无法使用预训练权重 |
| **二分路由**（仅 strong/weak） | 需扩展为多模型候选 |
| Python/PyTorch 实现 | 无法直接用于 Electron/Node.js |
| 路由器学到的是**查询难度特征**而非模型特定知识 | 这是泛化能力的来源 |

#### 4.3.8 为什么不能直接移植 RouteLLM

1. **预训练权重不可复用**：MF 的 `nn.Embedding(64, 128)` 中每个模型的 latent vector 是从 Arena 偏好数据学出来的，新模型没有对应向量。不是从模型名推出来的，而是从训练数据学出来的。
2. **Python/PyTorch 打包问题**：Electron 桌面应用不适合捆绑 Python runtime 和 PyTorch
3. **OpenAI embedding 依赖**：每次路由增加一次网络调用，延迟和成本均增加
4. **二分路由限制**：只支持 strong/weak 两个候选，无法覆盖多模型池

**正确做法**：保留 RouteLLM 的思想（embedding + 小模型打分 + 阈值比较），重做成适配自定义模型池的多候选路由层。

---

### 4.4 Semantic Router

| 维度 | 详情 |
|------|------|
| **定位** | 基于 embedding 的语义路由库 |
| **主要实现** | Aurelio Labs / vLLM Semantic Router (Iris) |

**Aurelio Labs Semantic Router**：
- 定义 Route 对象 + 示例 utterances
- 支持多种 encoder（Cohere / OpenAI / local）
- 轻量级，适合嵌入应用

**vLLM Semantic Router (Iris)**：
- 使用 ModernBERT 分类器
- 信号捕获：意图识别、复杂度评估、Jailbreak 检测、PII 过滤、语义缓存
- LoRA 共享基础计算
- 性能：准确率 +10.2%，延迟 -47.1%，token -48.5%

---

### 4.5 开源框架对比

| 维度 | LiteLLM | Portkey | RouteLLM | Semantic Router |
|------|---------|---------|----------|----------------|
| **语言** | Python | TypeScript | Python | Python |
| **路由智能度** | Embedding auto-routing | 条件规则 | ML 分类器 | Embedding 语义 |
| **延迟开销** | 20-40ms/请求 | <1ms | 5-100ms（视路由器） | 5-20ms |
| **核心体积** | 300-400MB | 122KB | 轻量 | 轻量 |
| **Provider 支持** | 100+ | 200+ | 2（强/弱对） | N/A（路由层） |
| **缓存** | 7 种后端 | 内置语义缓存 | 无 | 语义缓存可选 |
| **Fallback** | 完善（可组合） | 完善（可组合） | 无 | 无 |
| **Guardrails** | 基础 | 60+ 内置 | 无 | 部分 |
| **Node.js 集成** | 需 Python 子进程 | **原生 npm 包** | 需 Python | 需 Python |
| **生产稳定性** | 500 RPS 瓶颈 | 企业级 | 研究工具 | 库级 |
| **适合场景** | Python 后端 | Node.js/TS 项目 | 研究/评估 | 嵌入应用 |

---

## 五、项目落地可行性分析

### 5.1 当前代码现状

通过对 cmbCowork 代码库的分析，发现以下关键现状：

| 发现 | 详情 | 影响 |
|------|------|------|
| **单模型绑定** | `createAgentRuntime()` 只接收一个 `modelId`，整条 LangGraph 执行链绑定同一 `ChatOpenAI` 实例 | 路由只能在调用前进行 |
| **当前是 OpenAI-compatible 传输层** | 所有模型通过 `ChatOpenAI` 实例化 | 无法利用 Anthropic 等 Provider 的原生能力（如 prompt cache） |
| **后台任务尚无自动分层策略** | Heartbeat/定时任务已有独立 `modelId` 配置入口，但仍依赖人工指定；Memory Summarize 沿用当前线程或默认模型 | **自动路由仍有明显优化空间** |
| **工具全量注入** | MCP、memory、scheduler、git 工具几乎全部注入 agent | 上下文 token 开销大，可裁剪 |
| **缓存中间件已挂但未生效** | `anthropicPromptCachingMiddleware` 已挂载，但配合 `ChatOpenAI` 无法生效 | 需切换到原生 Provider SDK |
| **已有可观测出口** | stream events 中有 `cache_read/cache_creation` token 指标 | 可复用做成本追踪 |

**关键文件清单**：

| 文件 | 作用 | 路由改造相关性 |
|------|------|--------------|
| `src/main/agent/runtime.ts` | 模型实例化、agent 图构建、工具注册 | **核心改造点** |
| `src/main/ipc/agent.ts` | Agent 调用入口 | 路由插入点 |
| `src/main/ipc/models.ts` | 模型 CRUD IPC | 需扩展元数据 |
| `src/main/storage.ts` | 配置持久化 | 需扩展路由配置 |
| `src/main/services/scheduler.ts` | 定时任务执行 | 路由插入点 |
| `src/main/services/heartbeat.ts` | 心跳检测 | 路由插入点 |
| `src/main/memory/` | 内存摘要 | 路由插入点 |
| `src/renderer/src/components/chat/ModelSwitcher.tsx` | 模型选择 UI | 需增加 Auto 模式 |

---

### 5.2 桌面 Agent 场景特殊性

cmbCowork 作为桌面 AI Agent 应用，与云端高并发场景有本质差异：

| 特性 | 云端服务 | 桌面 Agent（cmbCowork） | 对路由设计的影响 |
|------|---------|----------------------|----------------|
| 并发量 | 高（千-万 RPS） | 低（单用户，1-5 并发） | 不需要复杂负载均衡 |
| 延迟敏感度 | 中 | 高（用户直接感知） | 路由决策需极快 |
| 副作用操作 | 少（主要读） | 多（文件写入、git、shell） | **质量升级不能重跑已执行操作** |
| 上下文变化 | 稳定（同 API） | 动态（workspace 持续变化） | 缓存策略需考虑 workspace 指纹 |
| 成本归属 | 按用户/租户 | 单一用户 | 不需要多租户成本归因 |
| 任务多样性 | 通常单一类型 | 高度多样（对话/编码/调度/心跳） | 路由规则需覆盖多种任务类型 |
| 部署约束 | 服务端，自由选技术栈 | **Node.js 主进程，打包分发** | 排除 Python 依赖重的方案 |

**桌面 Agent 的独特风险——副作用安全**：

这是与云端场景最大的区别。桌面 Agent 可以执行文件写入、git 操作、shell 命令等有副作用的操作。如果在已执行副作用后触发"质量不够，升级到更强模型重跑"，可能导致：
- 文件被重复修改
- Git commit 重复
- Shell 命令重复执行

因此，质量升级**只能在安全时机触发**：
1. 工具调用前，基于任务风险预判直接升级
2. 从 checkpoint 边界恢复，且仅对只读/规划阶段重试

---

### 5.3 技术路线适配性评估

基于上述特殊性，对各技术路线的适配性打分：

| 技术路线 | 适配性 | 理由 |
|---------|--------|------|
| **规则路由** | ★★★★★ | 零延迟、零依赖、可覆盖 cmbCowork 的明确任务类型（Heartbeat/定时/对话） |
| **成本感知路由（横切）** | ★★★★★ | 预算控制对降 TCO 直接有效，与规则路由天然互补 |
| **分类器路由（LLM）** | ★★★★☆ | 处理规则无法判断的模糊样本，但注意控制分类器本身的成本和延迟 |
| **级联/Fallback** | ★★★★☆ | Availability fallback 必须有；Quality escalation 需受限于安全时机 |
| **语义路由（Embedding）** | ★★★☆☆ | 可行但非必要——cmbCowork 任务类型有限，规则+分类器足以覆盖 |
| **RL 路由** | ★☆☆☆☆ | 数据量不足，单用户桌面场景无法提供足够的训练信号 |
| **Fine-tuned 专用模型** | ★★☆☆☆ | 需要大量训练数据和持续维护，对桌面应用团队投入过大 |

**开源框架 / 路由平台适配性**：

| 框架/平台 | 适配性 | 理由 |
|----------|--------|------|
| **Portkey** | ★★★★☆ | TypeScript 原生、轻量（122KB）、Node.js 直接集成。但引入外部依赖需评估 |
| **Not Diamond RoRF** | ★★★★☆ | 开源 Random Forest 路由器设计思路可直接借鉴，但原实现为 Python |
| **RouteLLM** | ★★★☆☆ | 分类器路由器可参考实现思路，但 Python 依赖限制直接使用 |
| **OpenRouter** | ★★★☆☆ | API 即用，但路由黑盒不可定制，且增加网络跳转 |
| **Unify.ai** | ★★★☆☆ | 实时 benchmark 思路有价值，但作为云服务引入增加依赖 |
| **LiteLLM** | ★★☆☆☆ | Python 依赖、体积大（300-400MB）、桌面分发困难 |
| **Semantic Router** | ★★☆☆☆ | Python 依赖，且语义路由在此场景非必要 |

---

### 5.4 向量/Embedding 路由技术深度辨析

> 本节基于对 RouteLLM 源码的深度分析和项目讨论，辨析向量匹配在路由中的不同应用方式，以及对本项目的适配建议。

#### 5.4.1 Embedding 在路由中的三种用法

Embedding（向量化）在路由中并非单一技术，而是有三种截然不同的应用模式：

| | 方案 A：历史相似度匹配 | 方案 B：Matrix Factorization | 方案 C：特征向量 + 线性打分 |
|---|---|---|---|
| **代表** | RouteLLM SW Router, Martian | RouteLLM MF Router | 本项目推荐的简化方案 |
| **Embedding 的作用** | 匹配历史请求 | 与 learned model vector 交互 | 理解 prompt 语义复杂度 |
| **model_vector 来源** | 不需要 | **从偏好数据训练** | **手动设定 / 从反馈学习** |
| **冷启动** | 不能工作（无历史数据） | 不能工作（无训练数据） | **可以工作**（靠规则特征 + bias） |
| **新模型接入** | 需积累数据 | 需重新训练 | **只需设 tier + 权重** |
| **精度上限** | 高（数据够多时） | **最高** | 中等 |

##### 方案 A — 历史相似度匹配（KNN 投票）

```
离线: 历史请求 → embedding → 存入向量库，标注"哪个模型效果最好"

在线:
新请求 → embedding → 在向量库中找 Top-K 相似历史请求
                         ↓
              统计这些相似请求的最佳模型
              "5条相似请求中4条用 GPT-4 更好" → 路由到 GPT-4
```

**本质**：KNN 投票。优点是直觉简单、数据越多越准；缺点是**冷启动问题严重**。

##### 方案 B — Matrix Factorization（RouteLLM 最佳方案）

```
离线: 训练一个小模型，学习 (prompt_embedding, model_id) → quality_score

在线:
新请求 → embedding → 分别和每个模型的 learned vector 做运算
                         ↓
              score_i = sigmoid(dot(proj(embedding), model_vector_i))
              按成本升序，选第一个 score >= threshold 的模型
```

**本质**：学到了"什么类型的 prompt 适合什么模型"的压缩表示。

**方案 B 的核心约束**：`model_vector` 是从训练数据学出来的，不是从模型名推出来的。MF 的 `nn.Embedding(64, 128)` 编码了"遇到数学推理类 prompt，GPT-4 比 Mixtral 强很多"、"遇到简单翻译类 prompt，两者差不多"这些知识。**没有训练数据的新模型没有对应向量，无法参与路由。**

##### 方案 C — 特征向量 + 线性打分（推荐的过渡方案）

```
score = sigmoid(dot(embedding, semanticWeights) + dot(features, featureWeights) + bias)
                 ↑                                  ↑                              ↑
              语义维度                              规则维度                        模型偏置
```

**关键认知**：方案 C 中的 `semanticWeights` 在冷启动时**无法手动设定**——384 维的 embedding 向量对人来说是不可解释的随机数，无法手工指定有意义的权重。

**因此冷启动时方案 C 实际退化为规则引擎**：

```
冷启动:
  semanticWeights = 零向量 (384个0)  ← 不起作用
  featureWeights  = 手动设定         ← 实际生效
  bias            = 按 tier 设定     ← 实际生效

  score = sigmoid(0 + 0.3*hasCodeBlock + 0.2*tokenRatio + ... + bias_per_tier)
```

**进化路径**：方案 C 不是独立方案，而是**方案 B 在没有训练数据时的过渡形态**。

```
Phase 1:  纯规则 (if/else)
    ↓ 加 embedding 基础设施
Phase 3:  方案 C 冷启动 → embedding 算了但权重为零，只靠规则特征和 bias
    ↓ 收集用户反馈数据（采纳/重试/编辑/停止）
Phase 5:  从反馈数据训练 semanticWeights → 方案 C 自然进化为方案 B
```

等 `semanticWeights` 从数据中学出来，方案 C 就变成了方案 B，代码结构不用改。

#### 5.4.2 判定"历史请求的最佳模型"的方法

无论方案 A 还是方案 B，都需要标注"哪个模型对这个请求表现最好"。有三种判定方法：

##### (1) 多模型竞赛（最准，最贵）

同一请求同时发给 N 个模型，评估谁最好。成本是 N 倍，**只适合离线建库阶段**。

##### (2) LLM-as-Judge（主流方法）

用一个裁判模型对"请求 + 模型输出"打分。RouteLLM 和 Martian、Not Diamond 都用类似方法。

##### (3) 隐式信号收集（最便宜，可持续）

从用户行为推断，不需要显式评估：

| 信号 | 含义 | 权重 |
|------|------|------|
| 用户直接采纳输出 | 质量足够好 | 高正分 |
| 用户手动编辑了输出 | 不够好但可用 | 中 |
| 用户重新发送 / 换模型重试 | 质量不达标 | 负分 |
| 用户点了"停止生成" | 方向完全错 | 强负分 |
| 对话继续且无纠正 | 隐式满意 | 中正分 |

**对本项目的建议**：Phase 1-2 使用规则路由（无需标注数据），Phase 3+ 同时收集隐式信号，Phase 5 用隐式信号训练语义权重。

#### 5.4.3 本项目的推荐路径

```
阶段 1 — 冷启动（无数据）
  └→ 纯规则路由兜底，同时搭建 embedding 基础设施和遥测管道
      对 5-10% 的请求可选做多模型对比采样

阶段 2 — 数据积累（有隐式反馈数据）
  └→ embedding + 线性打分上线（方案 C），权重从隐式信号训练
      用户行为不断修正"最佳模型"标签

阶段 3 — 自进化（数据充足）
  └→ 方案 C 自然升级为方案 B
      定期用 LLM-as-Judge 校准评分偏差
```

**核心认知**：没有"客观最佳模型"，只有在特定质量/速度/成本权重下的最优选择。判定方法本质上是在定义优化目标。

#### 5.4.4 向量匹配 vs 路由的关系澄清

在 Cursor IDE 等产品中，向量引擎（Turbopuffer）**不是用于模型路由**，而是用于**上下文检索**：

| 系统 | 作用 | 技术 |
|------|------|------|
| **路由器** | 决定用哪个模型 | 启发式规则 |
| **向量引擎** | 决定给模型看哪些代码 | embedding + 相似度检索 |

向量引擎解决的是"模型该看什么代码"，路由器解决的是"该用哪个模型"。二者是独立系统。

#### 5.4.5 启发式、ML 分类器与 Task-aware 的关系

这三个概念处于不同维度：

| 概念 | 维度 | 说明 |
|------|------|------|
| **启发式** | 判断方法 | 人写规则（if/else），快且可解释，但粗糙 |
| **ML 分类器** | 判断方法 | 训练模型做分类，可精准也可粗糙，取决于训练目标 |
| **Task-aware** | 能力等级 | 能理解"这是重构"vs"这是 debug"的任务语义 |

ML 分类器可以是 task-aware，也可以不是：

| ML 分类器训练目标 | 是否 task-aware |
|---|---|
| 输入长度 + token 数 → 选模型 | 否（只看表面特征） |
| "这是重构/debug/生成/解释" → 选模型 | **是**（理解任务意图） |

**Task-aware 是一种能力等级，ML 分类器是实现手段之一。** Cursor 明确声明自己的 Auto 模式"非 task-aware"，即承认只看表面信号不理解任务语义。

---

### 5.5 推荐方案与架构

**推荐方案**：自建统一路由内核（规则优先 + 分类器兜底 + 成本横切 + Fallback 保可靠性）

**不推荐直接引入外部框架的理由**：
1. cmbCowork 的路由需求相对集中（任务类型有限），自建规则引擎即可覆盖主要场景
2. 桌面应用对体积和启动速度敏感，外部框架引入需审慎
3. 需要深度集成 LangGraph 的 checkpoint/state 机制（外部框架无此能力）
4. 副作用安全约束需要定制化处理（外部框架不考虑此场景）

**但可参考 Portkey 的设计理念**：条件路由 + 可组合 fallback + 可观测性

**架构图**：

```
                    ┌─────────────────────────┐
                    │   Routing Request        │
                    │  (taskType, context,     │
                    │   threadId, toolHints)   │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │    Mode Check            │
                    │  pinned? → 使用固定模型   │
                    │  auto?   → 进入路由引擎   │
                    └────────────┬────────────┘
                                 │ auto
                    ┌────────────▼────────────┐
                    │   Rule Engine            │
                    │  · 任务类型分类           │
                    │  · 上下文长度评估         │
                    │  · 工具调用模式识别       │
                    │                          │
                    │  置信度 >= 阈值?          │
                    └───┬─────────────┬───────┘
                    yes │             │ no
           ┌────────────▼──┐  ┌──────▼──────────┐
           │ Direct Route  │  │ LLM Classifier   │
           │ (zero cost)   │  │ (economy 模型)   │
           └────────────┬──┘  └──────┬───────────┘
                        │            │
                    ┌───▼────────────▼────────┐
                    │  Cost Constraint Check   │
                    │  · 预算限额检查           │
                    │  · Tier 限制             │
                    │  · Rate limit 检查       │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  Execution Plan          │
                    │  · resolvedModelId       │
                    │  · reason（路由原因）      │
                    │  · fallbackChain         │
                    │  · toolProfile（工具裁剪） │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  createAgentRuntime()    │
                    │  (现有代码，最小改动)      │
                    └─────────────────────────┘
```

**设计原则**：
1. **调用前路由，不做图内切换**——兼容现有单模型 runtime，最小改动
2. **保留手动选择**——`固定模型 / 自动路由` 双模式，不替换用户习惯
3. **后台任务优先**——Heartbeat/定时任务/Memory Summarize 是最快见效的优化点
4. **Run 级冻结**——一次执行中模型不变，避免副作用场景的行为漂移
5. **可观测先行**——没有数据就没有优化依据

**模块设计与文件组织**：

```
src/main/routing/
├── types.ts                  # RoutingMode, ExecutionPlan, ModelCapability, RoutingPolicy 等类型定义
├── resolve-execution-plan.ts # 核心入口: resolveExecutionPlan(ctx) → ExecutionPlan
├── model-catalog.ts          # 模型元数据管理: tier, cost, capabilities, health, latency
├── feature-extractor.ts      # 从消息提取特征: 长度, 代码检测, 任务来源, 工具关键词
├── rules.ts                  # Layer 2 规则引擎: 任务类型 → 模型 tier 映射
├── scorer.ts                 # Layer 3 语义打分: embedding + 线性打分 (Phase 3+)
├── fallback.ts               # 429/timeout/context overflow 降级逻辑
├── cache.ts                  # 路由决策缓存: messageHash + candidateSetVersion + policy + taskSource
├── telemetry.ts              # 路由决策日志: 记录每次路由的输入/输出/原因
└── embedding-worker.ts       # Worker thread 中运行本地 embedding (Phase 3+)
```

**关键改动文件**：

| 文件 | 改动内容 |
|------|---------|
| `src/main/ipc/agent.ts` (L27, L150, L191) | invoke/resume 前调用 `resolveExecutionPlan()`；resume 强制复用已锁定的 `resolvedModelId` |
| `src/main/agent/runtime.ts` (L392) | `getModelInstance()` 接收 `resolvedModelId` 而非原始 `modelId` |
| `src/main/storage.ts` (L340) | `CustomModelConfig` 扩展 tier/cost/capabilities/routingEnabled |
| `src/main/services/heartbeat.ts` (L202) | 支持 `routingMode: auto`，不再在无 modelId 时报错 |
| `src/main/ipc/agent.ts` (L150) | memory summarize 复用统一路由接口 |
| `src/renderer/src/components/chat/ModelSwitcher.tsx` | 新增 Auto 模式 + routingPolicy 选择 |

**前端交互设计**：

不把 "Auto" 伪装成一个普通模型（会与 `models:list` 校验冲突），而是采用双控件：
- `routingMode: pinned | auto` — 选择固定模型或自动路由
- `routingPolicy: cheap | balanced | quality` — Auto 模式下的策略偏好
- `pinnedModelId` — pinned 模式下的指定模型

---

### 5.6 分阶段路线图

| Phase | 内容 | 预估周期 | 核心产出 |
|-------|------|---------|---------|
| **Phase 0** | 数据基建与模型元数据 | 1 周 | 模型 tier/成本/能力 元数据；调用追踪表；路由配置结构 |
| **Phase 1** | 调用前规则路由器 | 1-2 周 | `resolveExecutionPlan()` 路由入口；后台任务默认降级；UI Auto 模式 |
| **Phase 2** | Availability Fallback + 成本监控 | 1 周 | 429/超时自动降级；成本监控面板 |
| **Phase 3** | 智能分类器 + Quality Escalation | 2 周 | LLM 分类器（仅规则低置信时触发）；安全升级机制 |
| **Phase 4** | 工具集裁剪 + 路由缓存 | 1-2 周 | 按任务类型裁剪工具注入；路由决策缓存 |
| **Phase 5** | 数据驱动优化 | 长期 | 基于真实数据调整规则阈值；评估是否需要语义路由/RL |

**Phase 0 — 数据基建**（为后续所有优化奠基）：
- 扩展 `CustomModelConfig`：增加 `tier`、`costPerInputToken/OutputToken`、`capabilities`、`maxContextWindow`
- 新增路由配置：Thread 级 `routingMode: 'auto' | 'pinned'`，全局默认策略
- 新增调用追踪：每次调用记录 `threadId, taskType, selectedModelId, routeReason, tokenUsage, latency, fallbackTriggered, userOverride`

**Phase 1 — 规则路由器**（最快见效）：

| 任务类型 | 默认路由 | 依据 |
|---------|---------|------|
| Heartbeat | economy tier | 周期性检查，无需高推理能力 |
| Memory Summarize | economy tier | 文本摘要，economy 模型足够 |
| 定时任务（无工具） | economy tier | 简单执行 |
| 定时任务（有工具） | standard tier | 需要工具调用能力 |
| 用户对话（短消息/简单问答） | standard tier | 平衡成本与体验 |
| 用户对话（代码编辑/多工具） | premium tier | 需要强推理和工具协调 |
| 用户对话（长上下文 > 50K） | 支持长上下文的模型 | 上下文窗口匹配 |

---

### 5.7 预期 TCO 影响

| 优化项 | 预期节约 | 依据 |
|--------|----------|------|
| 后台任务降级（Heartbeat/Scheduler/Memory） | 40-60% 后台成本 | 这些任务无需 premium 模型 |
| 前台对话路由（简单问答→economy） | 20-30% 前台成本 | 行业数据 30-50% 查询可降级 |
| 工具集裁剪 | 10-15% token 成本 | 减少 system prompt 中的工具描述 |
| Prompt 缓存（未来阶段） | 20-50%（视命中率） | Anthropic 官方数据 90%，实际取决于命中率 |
| **综合预估** | **30-50% 总体 TCO 降低** | 保守估计 |

行业参考数据：
- RouteLLM 在 MT-Bench 上实现 85% 成本节约
- FrugalGPT 最高 98% 成本降低
- 客服平台月度 LLM 支出从 $42,000 降至 $18,000（级联路由）
- 有企业从 £100,000/月降至 £8,000-£12,000/月（路由 + 本地化）

---

### 5.8 风险与挑战

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| **路由错误导致用户体验下降** | 简单任务用了弱模型，结果质量差 | 保留手动 pinned 模式作为兜底；Quality Escalation 信号检测 |
| **副作用操作后的质量升级** | 文件/git 被重复操作 | Run 级模型冻结；仅在安全 checkpoint 触发升级 |
| **分类器本身的成本** | 每次路由都调一次 LLM 做分类 | 仅在规则低置信时触发；分类结果缓存 |
| **模型 Provider 变更/涨价** | 路由规则和成本数据需更新 | 模型元数据与路由逻辑解耦；成本数据可配置 |
| **用户对 Auto 模式不信任** | 用户始终选 pinned，路由系统闲置 | UI 透出路由原因（"routed to: xxx because..."）；成本面板展示节省金额 |
| **频繁切模型破坏 Cache** | prefix cache 命中率下降，实际 TCO 反而上升 | Run 级模型冻结；cache affinity 优先 |

### 5.9 路由质量评估维度（补充）

> Codex 审阅建议：对 Agent 场景，MT-Bench/MMLU 等通用 benchmark 不够，需要更贴合实际的评估维度。

| 评估维度 | 说明 | 对 Agent 的重要性 |
|---------|------|-----------------|
| **Tool-call success rate** | 工具调用的成功率（参数格式正确、调用目标准确） | ★★★★★ Agent 核心能力 |
| **JSON/Schema adherence** | 结构化输出的格式合规率 | ★★★★☆ 影响下游解析 |
| **Side-effect safety** | 有副作用操作的安全执行率 | ★★★★★ 桌面 Agent 关键风险 |
| **Prompt cache hit rate** | Prefix cache 命中率 | ★★★★☆ 直接影响实际 TCO |
| **User override rate** | 用户覆盖 auto 路由选择的频率 | ★★★★☆ 衡量路由准确度 |
| **Fallback trigger rate** | Fallback 被触发的频率 | ★★★☆☆ 衡量主路由可靠性 |
| **Data residency compliance** | 数据是否流向允许的 Provider/Region | ★★★☆☆ 企业合规需求 |

### 5.10 路由发布流程建议

```
Offline Replay → Shadow Routing → Canary (5% 流量) → Full Rollout
     ↑                                                    │
     └──────── User Override / Quality Signal ────────────┘
```

- **Offline Replay**：在历史 trace 上回放新路由策略，对比成本和质量
- **Shadow Routing**：新策略与当前策略并行运行，但只记录不执行
- **Canary**：新策略对小比例流量生效，监控关键指标
- **Full Rollout**：确认无回归后全量发布
- 全程保留 `user override` 和 `route reason` 透出

---

## 六、参考资料

### 学术论文

- [RouteLLM: Learning to Route LLMs with Preference Data](https://github.com/lm-sys/RouteLLM) — LMSYS, ICLR 2025
- [FrugalGPT: How to Use Large Language Models While Reducing Cost](https://arxiv.org/abs/2305.05176) — Stanford, 2023
- [RouterBench: A Benchmark for Multi-LLM Routing System](https://arxiv.org/abs/2403.12031) — Martian, 2024
- [A Unified Approach to Routing and Cascading for LLMs](https://openreview.net/forum?id=AAl89VNNy1) — 2024
- [HierRouter: Coordinated Routing via RL](https://arxiv.org/html/2511.09873) — 2025
- [xRouter: Cost-Aware LLM Orchestration via RL](https://arxiv.org/html/2510.08439v1) — 2025
- [ICLR 2025: Complexity-based Routing](https://proceedings.iclr.cc/paper_files/paper/2025/file/5503a7c69d48a2f86fc00b3dc09de686-Paper.Conference.pdf)
- [IPR: Intelligent Prompt Routing with User-Controlled Quality-Cost Trade-offs](https://aclanthology.org/2025.emnlp-industry.170/) — EMNLP Industry 2025
- [RouterEval: A Comprehensive Benchmark for Routing LLMs](https://aclanthology.org/2025.findings-emnlp.208/) — Findings of EMNLP 2025
- [Select-then-Route: Taxonomy guided Routing for LLMs](https://aclanthology.org/2025.emnlp-industry.28/) — EMNLP Industry 2025
- [SkewRoute: Training-Free LLM Routing for KG-RAG](https://aclanthology.org/2025.findings-emnlp.606/) — Findings of EMNLP 2025
- [MasRouter: Learning to Route LLMs for Multi-Agent Systems](https://aclanthology.org/2025.acl-long.757/) — ACL 2025
- [Meta-Router: Bridging Gold-Standard and Preference-Based Evaluations](https://arxiv.org/abs/2509.25535) — Not Diamond
- [LLMRouterBench: Massive Benchmark & Unified Framework](https://arxiv.org/html/2601.07206v1)

### 产品文档

- [GitHub Copilot: Auto Model Selection](https://docs.github.com/en/copilot/concepts/auto-model-selection)
- [Notion Blog: Speed, Structure, and Smarts](https://www.notion.com/blog/speed-structure-and-smarts-the-notion-ai-way)
- [OpenAI: Introducing GPT-5](https://openai.com/index/introducing-gpt-5/)
- [Braintrust: How Notion Evaluates AI at Scale](https://www.braintrust.dev/customers/notion)
- [Cursor: Selecting Models](https://docs.cursor.com/guides/selecting-models)

### 开源项目

- [LiteLLM](https://github.com/BerriAI/litellm) — 33K stars, MIT
- [Portkey AI Gateway](https://github.com/Portkey-AI/gateway) — 10.8K stars, MIT
- [RouteLLM](https://github.com/lm-sys/RouteLLM) — LMSYS
- [Semantic Router](https://github.com/aurelio-labs/semantic-router) — Aurelio Labs
- [NVIDIA LLM Router Blueprint](https://github.com/NVIDIA-AI-Blueprints/llm-router)
- [RouterBench](https://github.com/withmartian/routerbench) — Martian
- [RoRF (Routing on Random Forests)](https://github.com/Not-Diamond/RoRF) — Not Diamond
- [awesome-ai-model-routing](https://github.com/Not-Diamond/awesome-ai-model-routing) — Not Diamond 整理的路由资源汇总
- [notdiamond-python SDK](https://github.com/Not-Diamond/notdiamond-python) — Not Diamond Python SDK

### 产品文档（路由平台）

- [OpenRouter: Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router)
- [OpenRouter: Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)
- [Unify.ai: LLM Hub Technical Blog](https://unify.ai/blog/model-hub)
- [Not Diamond: Quickstart](https://docs.notdiamond.ai/docs/quickstart-routing)
- [Not Diamond: RoRF Blog](https://www.notdiamond.ai/blog/rorf)
- [Martian: Model Router](https://route.withmartian.com/)

### 技术文章

- [LiteLLM Routing Documentation](https://docs.litellm.ai/docs/routing)
- [Portkey Load Balancing](https://portkey.ai/docs/product/ai-gateway/load-balancing)
- [Latent Space: GPT-5's Router](https://www.latent.space/p/gpt5-router)
- [Red Hat: LLM Semantic Router](https://developers.redhat.com/articles/2025/05/20/llm-semantic-router-intelligent-request-routing)
- [Anyscale: Building LLM Routers](https://www.anyscale.com/blog/building-an-llm-router-for-high-quality-and-cost-effective-responses)
- [AWS: Multi-LLM Routing Strategies](https://aws.amazon.com/blogs/machine-learning/multi-llm-routing-strategies-for-generative-ai-applications-on-aws/)
- [IBM: Why IBM Invested in Not Diamond](https://www.ibm.com/think/insights/why-ibm-invested-in-not-diamond)
- [VentureBeat: Accenture and Martian on Model Routing](https://venturebeat.com/ai/why-accenture-and-martian-see-model-routing-as-key-to-enterprise-ai-success/)
- [Meta-Router Paper (Not Diamond)](https://arxiv.org/abs/2509.25535)
- [LLMRouterBench: Unified Framework](https://arxiv.org/html/2601.07206v1)

### 云厂商托管路由

- [Amazon Bedrock Intelligent Prompt Routing](https://aws.amazon.com/bedrock/intelligent-prompt-routing/)
- [Azure AI Foundry model-router](https://learn.microsoft.com/en-us/azure/ai-foundry/model-inference/concepts/models)
- [Google Vertex AI RoutingConfig / AutoRouting](https://docs.cloud.google.com/python/docs/reference/vertexai/latest/vertexai.generative_models.GenerationConfig.RoutingConfig)

### 基础设施层

- [llm-d Inference Scheduler](https://llm-d.ai/docs/guide/Installation/inference-scheduler) — Cache-aware / infra-aware routing
