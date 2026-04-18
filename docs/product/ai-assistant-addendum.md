# 研发 AI 助手 - 补充参考和设计增量

> 本文档汇总头脑风暴和主需求文档之后的**补充思考和参考资料**，供后续 PRD、架构设计、Epic/Story 拆分时参考。
> 
> **定位**：这是增量文档，主需求文档 `ai-assistant-requirements.md` 是主干。本文档的内容可能还在讨论中，有的会被确认后合入主文档，有的是参考资料不合入。
>
> **更新规则**：有新的补充思考/参考，直接追加到对应章节末尾。跨章节的新主题，新增章节。

---

## 1. systematic-debugging 方法论内化

> 来源：Superpowers 的 `systematic-debugging` skill，可以把方法论写进 `analyze_bug` capability 的 systemPrompt。

### 核心原则

**先找根因，后改代码。** "快速补丁掩盖根本问题"是大忌。

### 四阶段流程

| 阶段 | 做什么 | 对应你产品的哪部分 |
|------|--------|-----------------|
| **Phase 1 - 根因调查** | 读错误信息、复现问题、追踪最近改动、多组件系统中逐层采集诊断数据、追踪数据流溯源 | 置信度标签的依据（Phase 1 数据不全 → 低置信度） |
| **Phase 2 - 模式分析** | 找相似工作代码、对比参考实现、识别差异、理解依赖 | 知识库命中 + 跨模块对比 |
| **Phase 3 - 假设测试** | 形成单一假设、最小化变更验证、一变一测 | "方案先行"——输出排序后的假设，而不是并列 |
| **Phase 4 - 实现修复** | 写失败测试 → 单次修复 → 验证 → 若≥3 次失败需质疑架构 | 修复 Agent 的重试机制 + 3 次失败降级 |

### 红旗检测（触发时回到 Phase 1）

- 多次快速补丁
- 不理解就猜测
- 跳过取证
- 修改堆积

### 可以写进 analyze_bug capability 的 systemPrompt

这是一个具体可执行的改进。写进 systemPrompt 后，AI 分析的结构化程度和准确率会显著提升。

---

## 2. 业界开源工具和方法论参考

> 来源：2025 开源生态调研。不能闭门造车，借鉴已有的最佳实践。

### 2.1 产品级开源代理（可以抄架构）

| 工具 | 核心思想 | 能借鉴什么 |
|------|---------|-----------|
| **OpenHands**（前 OpenDevin） | 事件流架构：Agent → Actions → Environment → Observations → Agent | 分析/修复 Agent 用事件循环模式，而不是一次性调用 |
| **Aider** | 每次 AI 改动 = 一次 Git commit，带描述性 commit message | **直接对标修复 Agent 提交到 fix 分支**，commit 规范可以抄 |
| **SWE-agent**（Princeton） | Agent-Computer Interface（ACI）：为 AI 设计专门的工具接口 | MCP 工具设计思路就是 ACI |
| **Open SWE**（LangChain） | **多 Agent 架构**：Planner 先做代码研究制定策略，Reviewer 在 PR 前检查 | **完全对应"分析 Agent + 修复 Agent + AI Review Agent"设计** |

**强烈推荐阅读**：
- [OpenHands 论文](https://arxiv.org/abs/2407.16741)
- [Open SWE 博客](https://blog.langchain.com/introducing-open-swe-an-open-source-asynchronous-coding-agent/)
- [Aider 的 Git 集成文档](https://aider.chat)

### 2.2 代码库检索和索引（解决 AI 读不准代码）

分析准确率的核心瓶颈就是代码检索。

| 方法 | 说明 | 用在哪 |
|------|------|-------|
| **Tree-sitter 智能切分** | 按语法结构切分代码，而不是按行数 | 生成 AI 摘要时，每个类/函数独立索引 |
| **RAG + LLM 重排序** | 向量检索出 Top 50，再用 LLM 重排序选 Top 5 | 知识库查询：先向量粗排，再 LLM 精排 |
| **自然语言描述嵌入** | 给每个代码块生成自然语言描述，描述和代码一起嵌入 | AI 摘要的生成方式 |
| **增量索引流水线** | 代码变更时只增量更新索引 | AI 摘要自动更新机制 |

**推荐阅读**：[Qodo 的 10k 代码库 RAG 实践](https://www.qodo.ai/blog/rag-for-large-scale-code-repos/)

### 2.3 工程方法论（写进 systemPrompt）

| 方法论 | 核心思想 | 写到哪里 |
|-------|---------|---------|
| **Google SRE 无责事后分析** | 不追责人，追系统和流程漏洞 | Bug 根因归因机制的基础 |
| **5 Whys** | 连问五个"为什么"找根因 | 分析 Agent 的 Phase 1 流程 |
| **Fishbone/Ishikawa 图** | 从多个维度（代码/配置/数据/环境）列出可能原因 | 分析报告的结构化输出 |
| **Fault Tree Analysis** | 自顶向下逻辑推演 | 复杂 Bug 的分析流程 |
| **Scientific Method** | 假设→最小验证→结论 | systematic-debugging 的 Phase 3 |

**核心原则（Google SRE 版）**：
> "You can't 'fix' people, but you can fix systems and processes."

跟头脑风暴时的洞察一致：Bug 根因可能是 prompt 问题或需求没说清楚，不是某个人的错。

### 2.4 最推荐的三个"去抄"对象

| # | 对象 | 原因 |
|---|------|------|
| 1 | **Open SWE** | 它的 Planner/Reviewer 架构和你的"分析 Agent + 修复 Agent + Review Agent"基本一样，偷学细节 |
| 2 | **Aider 的 commit 规范和 Git 集成** | 修复 Agent 必须做好 Git 提交体验，Aider 已经踩完坑了 |
| 3 | **Qodo 的 RAG 方案** | 直接解决 AI 分析准确率的瓶颈 |

### 2.5 差异化定位（为什么还值得做）

业界有大量开源代理在做同样的事情。本产品的差异化在于：

- **垂直领域**（PAM 产品知识）
- **私有化部署**（Open SWE 和 OpenHands 都没专门做这个）
- **多产品、多产线管理**（开源项目都是单仓库场景）
- **与 ChatOps 平台整合**（IM + 审批 + RBAC 一体化）

**Sources**:
- [OpenHands: An Open Platform for AI Software Developers as Generalist Agents](https://arxiv.org/abs/2407.16741)
- [Introducing Open SWE](https://blog.langchain.com/introducing-open-swe-an-open-source-asynchronous-coding-agent/)
- [RAG for a Codebase with 10k Repos](https://www.qodo.ai/blog/rag-for-large-scale-code-repos/)
- [Google SRE Book - Postmortem Culture](https://sre.google/sre-book/postmortem-culture/)
- [Can LLMs find bugs in large codebases?](https://hamming.ai/blog/bug-in-the-codestack)

---

## 3. 待决策事项（TODO）

> 本节列出需求讨论中已识别但未最终拍板的决策点。进入 Epic/Story 之前需要收敛。

### 3.1 知识库存储方案

**当前临时选择**：独立 Git 仓库 + index.json 元数据匹配版本

**替代方案**：ChatOps PostgreSQL 数据库 + CRUD 页面 + MCP 工具查询

**取舍**：

| 维度 | Git 仓库方案 | 数据库方案 |
|------|:----------:|:---------:|
| 人写文档入口 | Web 编辑器 + Git 集成（要做） | Web 编辑器 + SQL CRUD（简单） |
| 版本匹配 | index.json 手动维护 | SQL WHERE 过滤 |
| Agent 读取 | clone 知识库仓库 | MCP 工具查库 |
| 历史版本 | Git 天然有 | 需要额外表 |
| 开发工作量 | 大 | 小 |
| AI 写入 | Git 提交（有冲突） | 调工具写库（简单） |
| 离线可用 | ✅ | ❌ |
| 适合场景 | 严谨 review 流程 | 快速迭代 |

**需要在里程碑 1 实施前最终决策。**

### 3.2 文档编辑入口的目标用户

**影响是否需要做 Web 编辑器**：

- A) 只给研发 → 直接 Git 提交够了，MVP 省掉 Web 编辑器
- B) 研发 + 非技术人员（交付/售前）→ 必须做 Web 编辑器
- C) MVP 阶段 A，后续加 B

当前**倾向 C**，但未明确。

### 3.3 AI 摘要和业务说明的目录结构

**当前选择**：放在代码仓库的 `docs/` 下

```
pas-6.0/
  └── docs/
      ├── ai/       ← AI 摘要（AI 生成 + 人校对）
      └── guide/    ← 业务逻辑说明（人写）← guide 这个名字待定
```

**待决策**：`guide/` 名字是否合适？还是叫 `logic/` / `notes/` 等。

---

## 4. 补充章节占位

> 后续有新的补充内容，直接在这里新增章节。格式保持一致：章节标题、来源说明、核心内容、对应产品的哪部分。

---

*最后更新：2026-04-15*  
*可持续追加*
