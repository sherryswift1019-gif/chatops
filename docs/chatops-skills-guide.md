# ChatOps Skills 使用指南

> 面向产品经理 / 研发 / 设计 / QA —— 团队内部 Claude Code 技能市场 `chatops-skills`，提供结构化 PRD 评审等 AI 协作能力。
>
> **目标读者**：团队成员（使用者）。若你是想贡献新 skill 的开发者，请看 [chatops-skills/README.md](../chatops-skills/README.md)。

---

## 一、这是什么

`chatops-skills` 是 ChatOps 团队内部共享的 Claude Code 插件市场，装上后 Claude 就具备团队预设的专业能力。目前提供：

| Plugin | 适用场景 | 典型一句话触发 |
|--------|---------|---------------|
| `prd-review` | PRD / 产品需求文档 / 产品方案评审 | "帮我 review 这份 PRD" |

> **后续会持续新增**（需求拆解、竞品分析、用户故事生成、测试用例评审等），已装成员 `git pull` + `/plugin marketplace update` 即可获得。

---

## 二、前置条件

1. 安装 Claude Code（任选其一即可）
   - CLI：`npm i -g @anthropic-ai/claude-code`
   - VS Code 扩展：在扩展市场搜 "Claude Code"
   - 桌面版（Mac / Windows）：<https://claude.com/claude-code>
2. 已 clone `chatops` 仓库到本地任意目录
3. 有公司分配的 Claude 账号并已完成 `claude /login`

---

## 三、安装（3 行命令）

打开 Claude Code（任意目录均可），依次输入：

```
/plugin marketplace add <本地 chatops 仓库路径>/chatops-skills
/plugin install prd-review@chatops-skills
```

示例（仓库在 `~/code/chatops`）：
```
/plugin marketplace add ~/code/chatops/chatops-skills
/plugin install prd-review@chatops-skills
```

装好后 **新开一个 Claude Code 会话**（或重启），输入 `/plugin list` 应该能看到 `prd-review@chatops-skills  enabled`。

---

## 四、使用 prd-review

### 4.1 最简用法

在 Claude Code 里直接说：

```
帮我 review 这份 PRD： @docs/prds/ux-design-agent.md
```

（`@` 后面跟文件路径，Claude Code 会自动附带文件内容）

### 4.2 带参考规范

如果团队有统一 PRD 模板（比如 `docs/templates/prd-template.md`），告诉 Claude 按它评分：

```
按 @docs/templates/prd-template.md 规范 review 这份 PRD： @docs/prds/xxx.md
```

### 4.3 批量 review 一个目录

```
review 一下 docs/prds/ 下最近 3 份 PRD，先列清单再逐份打分
```

### 4.4 让 Claude 直接改进文档

默认只给建议不改文档。报告输出后，如果你同意改，回复：

```
直接改 P0 和 P1
```
或
```
直接改，但第 2 条先不动
```

Claude 会用 Edit 工具按建议改写，每改一处都会告诉你改了什么。

---

## 五、输出长什么样

以评审 `docs/prds/ux-design-agent.md` 为例，Claude 会输出：

```markdown
# PRD Review 报告

**文件**：docs/prds/ux-design-agent.md
**总分**：72 / 100（等级：B）
**一句话总评**：整体框架完整，但验收标准可测性不足，且缺少成功指标定义。

## 维度评分

| # | 维度 | 得分 | 等级 |
|---|------|------|------|
| 1 | 完整性 | 20 / 25 | B |
| 2 | 清晰度与可测性 | 15 / 25 | C |
| 3 | 用户价值与业务指标 | 11 / 20 | C |
| 4 | 边界条件与异常流 | 12 / 15 | B |
| 5 | 规范符合度 | 14 / 15 | A |

## 详细扣分项

### 1. 完整性 (20/25)
- ❌ 缺少「非目标」章节 —— 未明确哪些不做
- ✅ 背景、目标、范围、用户故事已完备

### 2. 清晰度与可测性 (15/25)
- ❌ ux-design-agent.md:L88「系统应快速响应」—— 改为具体 SLA
- ⚠️  ux-design-agent.md:L102 验收标准未采用 Given/When/Then

（以此类推）

## 修改建议（按优先级）

### 🔴 P0（必须改）
1. [完整性] 补「非目标」章节
   - 建议写法：> 非目标：本期不支持 XX；不处理 YY 场景（下一期）
2. [清晰度] L88「快速响应」改为 `API 响应 P95 < 200ms`

### 🟡 P1（强烈建议）
...

### 🟢 P2（锦上添花）
...

## 亮点
- 用户故事覆盖了 3 个典型场景
- 风险章节包含了合规维度

## 下一步
本报告只给出建议。如需直接改到文档，请回复「直接改」。
```

---

## 六、评审维度说明

| 维度 | 权重 | 核心问题 |
|------|------|---------|
| 1. 完整性 | 25 | 背景 / 目标 / 范围 / 用户故事 / 验收 / 风险 / 依赖 是否齐全 |
| 2. 清晰度与可测性 | 25 | 描述无歧义？验收标准可度量？避免「支持/完善/优化」模糊词？ |
| 3. 用户价值与业务指标 | 20 | 痛点讲清？目标用户具体？成功指标可量化？埋点口径明确？ |
| 4. 边界条件与异常流 | 15 | 空态 / 错误态 / 权限 / 并发 / 兼容性 覆盖？ |
| 5. 规范符合度 | 15 | 文档结构、术语、版本号、变更记录、交叉引用是否规范 |

总分 100。等级：A 90-100｜B 75-89｜C 60-74｜D 40-59｜F <40

---

## 七、常见问题

**Q1：为什么 Claude 没触发 prd-review？**
- 会话里输入 `/plugin list` 确认 `prd-review@chatops-skills` 是 `enabled`
- 触发词要明确：推荐说"review 这份 PRD / 产品文档 / 产品方案"
- 如果装完没重启过 Claude Code，先退出重进

**Q2：能评审 Word / 飞书文档 / 语雀吗？**
- 当前只支持本地 Markdown 文件
- 飞书 / 语雀请先用"导出 Markdown"功能下载到本地再 review
- 后续会新增飞书 MCP 直接拉取在线文档的能力（TODO）

**Q3：Claude 会把我的 PRD 内容发到外网吗？**
- Claude Code 通过公司配置的 Claude 账号调用 Anthropic API
- 请勿评审含外部保密信息的 PRD；合规问题联系法务

**Q4：评分严格程度能调吗？**
- 可以，告诉它："严格按 A 级标准扣分"或"宽松打分，只挑大问题"
- 不满意单维度分数可让它复核："第 3 维度为什么只给 11 分，展开解释"

**Q5：我的 PRD 是英文的，能 review 吗？**
- 可以。Claude 会用中文输出评审报告，但引用原文和术语保持英文

**Q6：多人写的 PRD 每次都要重新装吗？**
- 不用。装一次长期有效。仅当 chatops-skills 有更新时才需要 `/plugin marketplace update chatops-skills`

---

## 八、更新

```
/plugin marketplace update chatops-skills
/plugin update prd-review@chatops-skills
```

更新频率：跟随 chatops 仓库，`git pull` 后执行上面两行即可。

---

## 九、卸载

```
/plugin uninstall prd-review@chatops-skills
/plugin marketplace remove chatops-skills
```

---

## 十、反馈与贡献

- **评审结果不准 / 漏查维度**：在 ChatOps 群 @ 管理员，或提 MR 改 [chatops-skills/plugins/prd-review/skills/prd-review/SKILL.md](../chatops-skills/plugins/prd-review/skills/prd-review/SKILL.md)
- **想新增 skill**（如"需求拆解"、"测试用例评审"）：参考 [chatops-skills/README.md](../chatops-skills/README.md) 的"新增 plugin 流程"
- **Bug / 建议**：GitLab MR 或 ChatOps 内部群
