# QI E2E Playbook — NL acceptance 直通设计

> 立项日期：2026-05-10
> 范围：仅修 Quick-Impl（QI）流水线 v9 链路里 spec_author → dev-loop → qi_e2e_runner → e2e-scenario runner 的契约一致性问题
> 关联：
> - [src/e2e/pipeline-b/playbook/types.ts](../../src/e2e/pipeline-b/playbook/types.ts) — playbook zod schema
> - [src/quick-impl/role-output-schemas.ts](../../src/quick-impl/role-output-schemas.ts) — spec_author 输出 schema
> - [.claude/skills/quick-impl-artifact-author/roles/dev-loop.md](../../.claude/skills/quick-impl-artifact-author/roles/dev-loop.md) — dev-loop skill
> - [src/agent/e2e-scenario/skill/SKILL.md](../../src/agent/e2e-scenario/skill/SKILL.md) — scenario runner skill
> - [src/pipeline/node-types/qi-e2e-runner.ts](../../src/pipeline/node-types/qi-e2e-runner.ts)

---

## 0. 问题

QI v9 graph 跑到 `qi_e2e_runner` 节点时报：

```
playbook YAML invalid: schema 校验失败 (
  specPath: Invalid input: expected string, received undefined;
  scenarios.0.acceptance.0: Invalid input: expected object, received string;
  ...
)
```

整条 pipeline 因 `onFailure: 'stop'` 死掉，业务无法验收 e2e。

## 1. 根因

QI 链路里**三方契约**对不上：

| 角色 | 字段 / 格式 |
|---|---|
| `spec_author` 输出（`E2eScenarioInlineSchema`） | `acceptance: string[]`（NL 描述）；**无 `specPath`** |
| `dev-loop.md` 当前模板 | `playbook_id` / `spec_path` (**snake_case**)；`acceptance: - "{string}"` |
| `playbookSchema`（qi_e2e_runner 校验） | `specPath` (**camelCase 必填**)；`acceptance: {kind:'url_match'\|'dom_visible'\|...}[]`（discriminated union） |
| `e2e-scenario` runner SKILL.md | "**`acceptance.kind` dictates the verification tool — no downgrades**"——只接受 7 种 `kind` |

并且 spec_author 在真实 eval 输出里写出来的 acceptance（见 [docs/qi-eval-2026-05-09-spec-author-v3-A.json](../qi-eval-2026-05-09-spec-author-v3-A.json)）远超现有 7 种 `kind` 容量：

```
"通过 page.evaluate(() => localStorage.getItem('chatops_remembered_username')) 获取值等于 'admin'"
"用户名输入框的值等于 'admin'"
"密码输入框处于聚焦状态（document.activeElement 为密码输入框元素）"
"复选框元素的 Y 坐标大于密码输入框的 Y 坐标（位于密码框下方）"
```

`page.evaluate`、`input.value`（不是 textContent）、`document.activeElement` 焦点、视觉几何对比——**任意一种现有 `kind` 都装不下**。这意味着不管让 spec_author 还是 dev-loop 当翻译层，都翻译不出合法 schema：要么乱选 `kind` 让 schema 过但语义错（断言失效），要么如实写 → schema fail 死循环。

`playbookSchema` 是为 pipeline-b（PM 手写、机器可验的 e2e spec → playbook → run 链路）设计的；QI 借来用，schema 容量根本不够。

## 2. 设计：NL acceptance 直通

让 `e2e-scenario` runner 直接消费自然语言断言。runner 本来就是 LLM + Playwright MCP + Bash + psql，能跑任意 JS / curl / SQL / `page.evaluate`，比 7 种 `kind` 表达力强得多。

### 2.1 Schema 改动（`src/e2e/pipeline-b/playbook/types.ts`）

`acceptanceSchema` 改成 union，多接受一种"自由文本"形态：

```ts
const naturalLanguageAcceptanceSchema = z.object({
  kind: z.literal('natural_language'),
  text: z.string().min(1),
})

export const acceptanceSchema = z.union([
  z.discriminatedUnion('kind', [
    urlMatchSchema, urlRegexSchema, domVisibleSchema, domTextContainsSchema,
    apiResponseSchema, logContainsSchema, dbQuerySchema,
    naturalLanguageAcceptanceSchema,
  ]),
  // 顶级裸 string —— 自动包成 {kind: 'natural_language', text}
  z.string().min(1).transform((s) => ({ kind: 'natural_language' as const, text: s })),
])
```

pipeline-b 现有严格 kind playbook（如 [admin-first-login.playbook.yaml](../test-playbooks/admin-first-login.playbook.yaml)）一字不动；QI 链路 dev-loop 直接 dump string 也合法。

**TS 类型影响**：`Acceptance` 推断类型由 7-union 变成 8-union（多 `natural_language` 形态）。已 grep 确认 prod 代码无 `switch (a.kind)` / `case 'url_match'` 之类的穷举消费方——只有 LLM prompt 字符串里提及 `acceptance.kind`（[src/e2e/pipeline-a/nodes/llm-generator.ts](../../src/e2e/pipeline-a/nodes/llm-generator.ts)、[src/e2e/playbook-draft/llm-generator.ts](../../src/e2e/playbook-draft/llm-generator.ts)），不会因类型扩展破坏类型检查。

### 2.2 dev-loop skill 字段名修正（`.claude/skills/quick-impl-artifact-author/roles/dev-loop.md` L116-128）

**仅做字段名对齐**，acceptance dump 部分本来就是 `- "{string}"`，不动。

| 当前模板（L116-128） | 改成 |
|---|---|
| `playbook_id: qi-{requirementId}` | **删除**（`playbookSchema` 不认此字段） |
| `spec_path: docs/specs/qi-{requirementId}.md` | `specPath: docs/specs/qi-{requirementId}.md` |
| `spec_title: "{spec.title 或 spec.summary 截前 80 字}"` | `specTitle: "{spec.summary 截前 80 字}"`（`SpecAuthorOutputSchema` 没有 `title` 字段，仅 `summary`，原模板里的 `spec.title` 永远走 undefined 兜底） |

acceptance / steps / scenario 其他字段保持现状（dev-loop 本来就不做翻译，只是 dump）。"作为独立 T0 commit"和"不重写 e2e playbook YAML"等流程性约束保留。

### 2.3 scenario runner skill 升级（`src/agent/e2e-scenario/skill/SKILL.md`）

**改动是 additive + 总指引分支化**，不是简单"加一段"。3 处需改：

**改 1：Phase 1 line 46 总指引分支化**

当前：「For each `acceptance` item, identify which `kind` it is and what tool you'll use to verify it」+ 7 行 kind→tool 表。

改成：先判断形态——
- 若 `acceptance` 是裸 string 或 `kind === 'natural_language'`：跳到 NL 消费段（改 3）
- 否则按原 7 行 kind→tool 表

**改 2：Phase 4 line ~159 "no downgrades" 边界澄清**

当前：「`acceptance.kind` dictates the verification tool — no downgrades」。

改成：「**对 7 种 strict kind 不允许 downgrade**（`dom_visible` 不能用 curl 替代）；NL 形态不在此约束内（自由选工具）」。

**改 3：新增 NL acceptance 消费段**

新章节"Phase 4.5: Verifying natural-language acceptance"。要点：
- 读 `text` 字段（裸 string 直接读元素本身）
- **自由选工具**：page.evaluate / curl / psql / docker logs / browser_snapshot / browser_take_screenshot
- evidence 强制要求：
  - `acceptanceResults[i].kind` = `'natural_language'`
  - `acceptanceResults[i].expected` = NL 原文
  - `acceptanceResults[i].actual` = 实测值（URL / DOM 片段 / SQL 行 / page.evaluate 返回值原值）
  - `acceptanceResults[i].reason` = 一句话说"用什么工具怎么验的"
  - `artifacts[]` 至少 1 条独立证据（截图 / sql_result / page.evaluate 返回值文本文件）让 reviewer 不依赖 LLM 自述就能判定真假

### 2.4 qi-e2e-runner / e2e_router 拓扑不变

[src/pipeline/node-types/qi-e2e-runner.ts:74-83](../../src/pipeline/node-types/qi-e2e-runner.ts#L74-L83) `readQiPlaybook` 维持现状（schema fail 仍 throw）。schema 加了 NL 支持后，dev-loop 产出的 acceptance 字段不会再因"string vs object"触发 schema fail；YAML 完全坏掉（语法错 / 顶层非对象 / 缺 `id`/`name`/`steps` 等结构性字段）的兜底 throw 留作系统级错误处理。

**显式不做**：不新增 `result: 'playbook_invalid'` 路径，不修改 `e2e_router` 拓扑，不在 dev-loop inputs 加 `playbookErrors` 字段，不增加 schema-fail 自修回路。这些都是方案 B 的复杂度——方案 C 通过让 schema 容得下 spec_author 真实输出形态，从源头消除了 fail 的可能性。

### 2.5 测试

| 层级 | 文件 | 用例 |
|---|---|---|
| schema 单测 | `src/__tests__/unit/playbook-schema.test.ts` | 1) `kind: 'natural_language'` 对象解析通过；2) 顶层裸 `string` 自动 transform 成 `{kind:'natural_language', text}`；3) 现有 7 种 kind 仍合法（回归 fixture） |
| 解析集成 | `src/__tests__/unit/playbook-schema.test.ts` 同文件 | dev-loop 风格完整 YAML（具 `specPath`/`specTitle` + 全部 acceptance 为裸 string）通过 `parsePlaybookYaml` |
| qi-runner | `src/__tests__/unit/qi-e2e-runner.test.ts`（如已存在）或新增 mock 文件 | `readQiPlaybook` 读 NL acceptance YAML 不 throw；YAML 缺 `specPath` / scenario `id` 时仍 throw（兜底回归） |

`SKILL.md` 改动是文档（影响 LLM 行为），不进 unit 测试范围；后续 dogfood 一次 QI 跑通流程作为 E2E smoke 验证。

不需要新增 e2e_router / bootstrap graph 测试（拓扑不变）。

## 3. 不变量

- pipeline-b 现有严格 kind playbook **零改动**（`admin-first-login.playbook.yaml`、`poc-smoke.playbook.yaml` 等）
- pipeline-a / playbook-draft 的 LLM 生成器 prompt **零改动**（[src/e2e/pipeline-a/nodes/llm-generator.ts](../../src/e2e/pipeline-a/nodes/llm-generator.ts)、[src/e2e/playbook-draft/llm-generator.ts](../../src/e2e/playbook-draft/llm-generator.ts) 仍要求 LLM 产 7 种 strict kind）。这两条链路生成的是要 commit 进 `docs/test-playbooks/` 反复跑的长期资产，严格 kind 是设计意图。schema 改成 union 后是"扩容"不"放松"，pipeline-a / playbook-draft 通过 prompt 约束继续产 strict kind 即可
- spec_author skill / `E2eScenarioInlineSchema` **不动**——spec 层维持 NL，PM/产品 review 友好
- `e2e_router` 拓扑、`qi_e2e_runner` attempt 计数、e2e fix-loop 入口 **不动**
- v8 老 spec（无 `e2eScenarios`）：dev-loop.md L135 跳过逻辑保留
- 已有 in-flight QI run：dev-loop 重新跑 round 时按新模板写 YAML（裸 string acceptance），qi_e2e_runner 校验通过

## 4. Trade-off

**牺牲**：machine-verifiable 严格 kind 在 QI 链路被弱化，evidence 质量取决于 scenario runner LLM 的尽责度。一个错误的 LLM 实现可能把"页面 URL 是 /dashboard"验成"截了张图就 pass"。

**换来**：
- spec_author 实际表达能力从 7 种 kind 解放
- dev-loop 不再背"翻译"职责（QI 场景下它在写代码时也不一定有 selector 可参考——鸡和蛋）
- 删除一个错误源（翻译错 → schema fail → 回路）
- 改动面最小：1 个 schema 改动（向后兼容 union） + 2 个 skill md 改动 + 测试

如果以后 QI evidence 质量出问题，可以**单独**升级 scenario runner SKILL（要求更结构化的 evidence、强制截图 + sql_result 双证、对 NL 文本做关键词反查）而不必动 spec_author / dev-loop / schema。

## 5. 不在本设计范围

- spec_author skill 进化（让 LLM 写出更结构化 acceptance、引入 hint 字段等）— 可选未来增强
- scenario runner 从单 LLM agent 升级到 multi-shot verifier — 可选未来增强
- pipeline-b 链路是否也允许 NL acceptance — 当前 PM 手写 playbook 用 strict kind 是合理的，不动
- evidence 质量自动评估 — 后续看 dogfood 数据再加
