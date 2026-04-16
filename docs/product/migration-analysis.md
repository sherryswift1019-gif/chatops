# pas-error-analyzer 迁移到 ChatOps 分析

> 分析 pas-error-analyzer 现有代码与 ChatOps 平台的重叠和差异，明确需要迁移的部分。

## 现有代码对比

| pas-error-analyzer 代码 | ChatOps 已有对应 | 需要迁移？ |
|------------------------|----------------|:---------:|
| `dingtalk-bot.js` 钉钉接入 | `DingTalkAdapter`（Stream 模式，更完善） | ❌ |
| 消息去重（processedMsgIds） | `DingTalkAdapter.processedMsgIds`（保留 200 条） | ❌ |
| Session 管理（30 分钟 TTL） | `SessionManager` + `ClaudeRunner` sessions（8h TTL） | ❌ |
| `reply()` sessionWebhook 回复 | `DingTalkAdapter.sendMessage()` | ❌ |
| Access Token 缓存 | `DingTalkAdapter.getAccessToken()` | ❌ |
| `analysis-engine.js:runClaude()` | `ClaudeRunner` + Porygon（更好的封装） | ❌ |
| **`parseMessage()` 图片解析** | ❌ ChatOps 没有 | **✅ 需要迁移** |
| **`downloadImage()` 图片下载** | ❌ ChatOps 没有 | **✅ 需要迁移** |
| **`buildAnalysisPrompt()` 分析 prompt** | ❌ ChatOps 没有 | **✅ 需要迁移** |
| **`skill-template.txt` 分析规范** | ❌ ChatOps 没有 | **✅ 需要迁移** |
| **`gitCheckout()` 版本切换** | ❌ | **✅ 需要迁移** |
| 并发控制（maxConcurrent=2） | `TaskQueue`（串行排队） | ❌ |

## 需要迁移的 4 块工作

### 1. 图片处理

**来源**：`dingtalk-bot.js` 的 `parseMessage()` + `downloadImage()`

**迁移目标**：扩展 `DingTalkAdapter`

**具体工作**：
- `NormalizedMessage` 接口增加 `images?: string[]` 字段
- `DingTalkAdapter.handleRobotMessage()` 中解析 richText 图片、引用回复图片、纯图片消息
- 新增 `downloadImage(downloadCode)` 方法（通过钉钉 API 下载图片到本地临时文件）
- 图片路径传入 `NormalizedMessage.images`

**参考代码**：
- `dingtalk-bot.js:253-315`（parseMessage，图片 URL 提取逻辑，含 richText、引用回复、纯图片三种格式）
- `dingtalk-bot.js:322-365`（downloadImage，支持完整 URL 和 downloadCode 两种方式）

### 2. 分析 Prompt + Skill Template

**来源**：`analysis-engine.js` 的 `buildAnalysisPrompt()` + `backend/skill-template.txt`

**迁移目标**：作为 `analyze_bug` capability 的 systemPrompt（存入 `capabilities` 表）

**具体工作**：
- 将 `skill-template.txt` 的分析规范内容写入 `capabilities.system_prompt` 字段
- systemPrompt 中需要动态插值的部分（代码仓库路径、版本号）通过 MCP 工具的上下文传入
- prompt 构建逻辑中的"先读 CLAUDE.md → 再读模块文档 → 再分析"的三步流程，写入 systemPrompt

**参考代码**：
- `analysis-engine.js:164-185`（buildAnalysisPrompt）
- `dingtalk-bot.js:170-223`（钉钉入口的 prompt 构建，含对话历史注入、工具调用约束）
- `backend/skill-template.txt`（分析报告输出规范）

### 3. Git 版本切换

**来源**：`analysis-engine.js` 的 `gitCheckout()`

**迁移目标**：新增 MCP 工具（如 `switch_version`）或在分析流程中由 Agent 自行调用 Bash

**具体工作**：
- 简单实现：systemPrompt 中告诉 Agent 可以用 Bash 执行 `git checkout`（但 ChatOps 当前禁用了 Bash）
- MCP 工具实现：新增 `switch_version` 工具，参数为 `project` + `version`，内部执行 `git checkout`

**参考代码**：
- `analysis-engine.js:14-31`（gitCheckout，简单的 spawn git checkout）

### 4. richText 消息解析

**来源**：`dingtalk-bot.js` 的 `parseMessage()` 中 richText 处理

**迁移目标**：扩展 `DingTalkAdapter.handleRobotMessage()`

**具体工作**：
- 当前 ChatOps 只处理 `msg.text.content`（纯文本）
- 需要增加 richText 格式支持（图文混排消息）
- 需要增加引用回复（repliedMsg）中的文本和图片提取

**参考代码**：
- `dingtalk-bot.js:110-120`（richText 文本提取）
- `dingtalk-bot.js:262-280`（引用回复中的图片和文本提取）

## pas-error-analyzer 关键配置

迁移时需要对应到 ChatOps 的配置体系：

| pas-error-analyzer 配置 | 值 | ChatOps 对应 |
|------------------------|---|-------------|
| `repoBasePath` | `/Users/hanff/workspace/pam/pam-smart` | 需要加入 `system_config` 或 `projects` 表 |
| `claude.allowedTools` | `Read,Glob,Grep,Bash` | MCP 工具模式替代（ChatOps 禁用内置工具） |
| `claude.timeout` | 600000（10 分钟） | Porygon `timeoutMs`（当前 300000，可能需要调大） |
| `dingtalk.clientId/Secret` | 硬编码 | ChatOps `.env`（已有，需确认是否同一个机器人） |

## 迁移后 pas-error-analyzer 的处置

迁移完成后，pas-error-analyzer 项目退役：
- 钉钉机器人切换到 ChatOps 平台（如果是同一个 clientId，只需停掉 pas-error-analyzer 进程）
- Web 入口（localhost:3001）由 ChatOps 管理后台替代
- 代码仓库保留作为参考，不再维护
