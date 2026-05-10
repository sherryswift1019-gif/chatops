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

### 2.2 dev-loop skill 简化（`.claude/skills/quick-impl-artifact-author/roles/dev-loop.md` L110-135）

只做**字段名对齐**，不做 kind 翻译：

```yaml
specPath: docs/specs/qi-{requirementId}.md
specTitle: "{spec.title 或 summary 截前 80 字}"
scenarios:
  - id: {scenario.id}
    name: "{scenario.name}"
    tags: [{tags}]
    steps:
      - "{step}"           # 直接 dump
    acceptance:
      - "{acceptance}"     # 直接 dump（裸 string）
```

- 字段全 camelCase（删 `playbook_id` / `spec_path` 这俩 schema 不认的字段）
- 删除所有 kind 决策表 / 翻译指令
- 保留"作为独立 T0 commit"和"不重写 e2e playbook YAML"等流程性约束

### 2.3 scenario runner skill 升级（`src/agent/e2e-scenario/skill/SKILL.md` Phase 1 / 4）

新增 NL acceptance 消费指南：
- 当 `acceptance.kind === 'natural_language'`（或裸 string），LLM 读 `text`，**自由选工具**验证它（page.evaluate / curl / psql / docker logs / browser_take_screenshot 任选）
- evidence 要求：
  - `acceptanceResults[i].kind` 写 `'natural_language'`
  - `acceptanceResults[i].expected` 写原 NL 文本
  - `acceptanceResults[i].actual` 写实测值（URL / DOM 片段 / SQL 行 / page.evaluate 返回值）
  - `acceptanceResults[i].reason` 写"用什么工具怎么验的"（一句话即可）
  - `artifacts[]` 必须给到 reviewer 能独立判定的证据（截图 / sql 结果 / page.evaluate 返回值文本文件）

现有 7 种 kind 的处理段保持不变（pipeline-b 链路零回归）。

### 2.4 qi-e2e-runner 不变

[src/pipeline/node-types/qi-e2e-runner.ts:74-83](../../src/pipeline/node-types/qi-e2e-runner.ts#L74-L83) `readQiPlaybook` 维持现状（schema fail 仍 throw）。schema 加了 NL 支持后，不会再 fail 这条具体路径。throw 兜底留给 YAML 完全坏掉（语法错 / 顶层非对象）等系统级错误。

不新增 `result: 'playbook_invalid'` 路径，不修改 `e2e_router` 拓扑。

### 2.5 测试

| 层级 | 文件 | 新增用例 |
|---|---|---|
| schema | `src/__tests__/unit/playbook-schema.test.ts` | 1) `natural_language` kind 解析；2) 裸 string 自动 transform；3) 7 种 kind 仍合法（回归） |
| qi-runner | `src/__tests__/unit/qi-e2e-runner.test.ts` 等 | dev-loop 风格 YAML（NL acceptance）能通过校验 |

不需要新增 e2e_router / bootstrap graph 测试（拓扑不变）。

## 3. 不变量

- pipeline-b 现有严格 kind playbook **零改动**（`admin-first-login.playbook.yaml`、`poc-smoke.playbook.yaml` 等）
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
