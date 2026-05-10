# Spec 04: Prompt 优化策略

> 主 PRD：[prd-quick-impl-roles-v2.md](../prd-quick-impl-roles-v2.md)
> 关联：[02-data-flow.md](02-data-flow.md)（manifest 实现）· [05-evaluation.md](05-evaluation.md)（A/B 对照验证）

本文定义 v2 的 prompt 工程策略，目标是**单 role 上下文不超过 ~700 行**，避免注意力稀释。

实现 Phase 2 写 role.md 时遵守 §2 风格约定；Phase 3 评测时按 §4 跑 A/B 对照。

---

## 1. 核心矛盾

V2 加了：
- standards 注入（8 篇 × ~80 行 = 640 行）
- previousRound 反馈
- 自检 checklist
- 扩展输出 JSON schema

如果一股脑全注入，单 role 上下文 ~960 行（SKILL.md ~120 + role.md ~200 + standards ~640）。LLM 注意力会散，**反而比 V1 差**（lost-in-the-middle）。

**解决思路**：不是"少加东西"，而是"按 role 精准分发 + 信息蒸馏 + 风格优化"。

---

## 2. 已采纳的 4 条策略

### S1. role-specific standards 注入（最大收益）

- **实现**：[02-data-flow.md](02-data-flow.md) §4 的 `role-manifest.json` + skill-runner 按 manifest 子集 symlink
- **效果**：spec-author 从 8 篇 → 1 篇，plan-decomposer 从 8 → 3；dev-loop / reviewer 仍全部（综合检查角色）
- **token 减幅**：spec -61% / plan -45% / dev 0% / reviewer 0%，平均 -25%

### S2. inputs.json 精准供给（蒸馏不是全文）

- dev-loop **不传 spec 全文**，只传 plan + planTasks 结构化数组
- reviewer **不传 spec/plan 散文**，只传 specAcceptanceCriteria + planTasks 结构化字段 + git diff
- **实现**：[02-data-flow.md](02-data-flow.md) §4 manifest 的 `inputs` 字段声明 + graph-builder 节点产出后蒸馏

### S3. checklist 优于叙述（写 role.md 风格约定）

- **反例**（V1 风格）：
  > "你需要审查代码的正确性和类型安全。要注意边界条件、空值处理、错误恢复路径..."
- **正例**（V2 风格）：
  ```
  检查项（每项必填 evidence）：
  □ 边界条件（空数组 / null / undefined）
  □ 错误处理（API fail / DB conflict）
  □ 命名一致性（grep 类似实现对比）
  ```
- **效果**：同样信息量 token 减 30-40%，且注意力分配更均匀

### S4. output schema 先行（让 Claude 先看到目标）

- role.md 顶部直接放完整 JSON schema 模板
- "你必须输出 acceptanceCriteria[]，每条用 Given-When-Then 格式" 比 "AC 应该清晰可测..." 强
- Schema 本身是最强约束，比段落叙述精准

### 这 4 条的写 role.md 落地约定

| 风格规则 | 说明 |
|---------|------|
| role.md 文件长度 ≤ 200 行 | 超过的拆 standards 引用 |
| 顶部放完整输出 JSON schema | 让 Claude 第一眼看到目标 |
| 任务步骤用编号列表 | 不用段落叙述 |
| 检查项 / DoD 用 □ checkbox 格式 | 视觉识别快 |
| standards 引用具体到 grep 命令 | 不要泛说"参考 standards" |
| 关键约束在开头和末尾各出现一次 | lost-in-the-middle 应对 |

---

## 3. 推迟 / 触发式策略

### S5. 按需读取（声明式 Read 调用）⚠️ 推迟

- **思路**：role.md 写"如果改动涉及 X，先读 standards/Y.md"，让 Claude 主动用 Read 拉取
- **优点**：未触发的 standards 不进上下文
- **弃用理由**：
  - 依赖 Claude 主动行为，可能"忘"读
  - 需要 reviewer 兜底（增加复杂度）
  - 效果难量化
- **后续**：Phase 3 评测后再考虑

### S6. 分层 prompt（关键约束前置 + 末尾兜底）⚠️ 写 role.md 时顺手注意

- **思路**：开头放角色定位 + output schema，中段放任务步骤，末尾重复关键约束
- **弃用单独立项的理由**：写 role.md 时的细节技巧，不必单独成策略；S4 已部分覆盖

### S7. few-shot 示例（触发式启用）

- **思路**：role.md 末尾加 1 个高质量 input → output 示例
- **收益**：prompt 工程里已知收益最大的技术之一，比 checklist 还显著
- **风险**：示例容易让 Claude 复制粘贴风格甚至变量名
- **启用条件**：Phase 3 评测分数未达 ≥30% 提升目标时启用，二次评测；不预先启用避免污染基线
- **示例素材**：spec-author 用 [docs/test-specs/login-remember-me.md](../../test-specs/login-remember-me.md) 的人工 spec 作为对照（脱敏 / 简化避免 Claude 直接抄）

---

## 4. 量化预期

| Role | V1 | V2 一股脑 | V2 + S1+S2+S3+S4 | vs V2 一股脑 | vs V1 |
|------|----|---|---|---|---|
| spec-author | ~100 行 | ~960 行 | ~280 行（SKILL+role+1 standard，checklist 风格）| -71% | +180% |
| plan-decomposer | ~100 行 | ~960 行 | ~430 行 | -55% | +330% |
| dev-loop | ~100 行 | ~960 行 | ~720 行（all standards 但 checklist 风格）| -25% | +620% |
| reviewer | ~100 行 | ~960 行 | ~720 行 | -25% | +620% |

> 注：单 role token 相对 V1 显著增加（+180%~+620%），但 V1 输出薄弱；总成本评估应看"完成同一需求所需的累计 token 和"——v2 一次通过率提升后多轮 reject 减少，总 token 可能持平或下降。最终结论由 Phase 3 评测给出，不预设具体数字。

---

## 5. 验证手段（A/B 对照）

Phase 3 评测时，对每个 role 跑两组对照：

- **A**：V2 + 一股脑全注入（所有 8 篇 standards + 完整 inputs）
- **B**：V2 + manifest 精准注入（按 02-data-flow.md §4 的子集）

判定规则：
- B 的 5 项主观打分 ≥ A 的打分（不输）
- B 的 token 显著少于 A
- 同时满足 → 优化策略有效

### 失败时的回退路径

如果 B 在某个 role 上输给 A（例如 spec-author 真的需要更多 standards 上下文）：
1. 把 manifest 里该 role 的 standards 加大（如 1 篇 → 3 篇 → 全部）
2. 再次评测找出最优子集
3. 极端情况：直接退化为"全 symlink + checklist 风格"，至少保住 S3+S4 的收益

manifest 是配置文件，调整成本低（改 JSON + 重跑评测）。

---

## 6. 为什么不用其他常见 prompt 技巧

| 技巧 | 为什么不用 |
|------|----------|
| Chain-of-thought "step by step" | Claude 已经 think，显式引导边际收益小，且占 token |
| 角色扮演（"你是一位资深架构师..."）| 项目已有 role.md 内置职责，再加扮演冗余 |
| 大量反例（"不要这么写：xxx"）| S3 checklist 已隐含；过多反例反而让 Claude 分心 |
| Self-critique（生成后再让 Claude 自己 critique）| 已通过 evidence.selfCheck 引入；额外 critique pass 翻倍 token |
| Temperature 调整 | role 输出本就要稳定，已用 default temperature；调整属 ClaudeRunner 范围 |
