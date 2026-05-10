# QI E2E NL acceptance 直通 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 QI 流水线 v9 的 spec_author → dev-loop → qi_e2e_runner → e2e-scenario runner 链路在 acceptance 字段上不再 schema-fail，方法是给 `playbookSchema` 加 `natural_language` kind 形态（同时接受裸 string），再修 dev-loop 字段名 + scenario runner SKILL.md NL 消费段。

**Architecture:** schema 层用 `z.union([discriminatedUnion(7+1种), z.string().transform()])` 做向后兼容扩容；pipeline-b 现有 strict-kind playbook 零回归；scenario runner 通过 SKILL.md 文档新增 NL 段实现自由工具选择。

**Tech Stack:** TypeScript / Zod / vitest / yaml

---

## File Structure

| 文件 | 状态 | 责任 |
|---|---|---|
| `src/e2e/pipeline-b/playbook/types.ts` | 修改 | acceptance schema 加 NL union 形态 |
| `src/__tests__/unit/playbook-schema.test.ts` | 修改 | 加 3 个 NL 形态测试 + 1 个 dev-loop 风格 YAML 集成测试 |
| `.claude/skills/quick-impl-artifact-author/roles/dev-loop.md` | 修改 | L116-128 字段名 camelCase 修正 |
| `src/agent/e2e-scenario/skill/SKILL.md` | 修改 | Phase 1 总指引分支化 + line ~159 边界澄清 + 新增 Phase 4.5 |

---

## Task 1: Schema 加 NL acceptance（TDD）

**Files:**
- Modify: `src/e2e/pipeline-b/playbook/types.ts:82-90`
- Test: `src/__tests__/unit/playbook-schema.test.ts:98-190`（"acceptance 类型" describe 块尾部追加）

- [ ] **Step 1: 写失败测试 — natural_language kind 对象形态**

在 `src/__tests__/unit/playbook-schema.test.ts` 文件第 188 行（`describe('parseManifestJson')` 之前）插入：

```ts
  it('natural_language kind 对象合法', () => {
    const r = validatePlaybook({
      specPath: 'docs/specs/qi-1.md',
      scenarios: [{
        id: 's1',
        name: 'NL 形态',
        steps: ['步骤'],
        acceptance: [{ kind: 'natural_language', text: '页面跳转到 /dashboard' }],
      }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.scenarios[0].acceptance[0]).toEqual({
      kind: 'natural_language',
      text: '页面跳转到 /dashboard',
    })
  })

  it('裸 string acceptance 自动 transform 为 natural_language', () => {
    const r = validatePlaybook({
      specPath: 'docs/specs/qi-1.md',
      scenarios: [{
        id: 's1',
        name: 'string 形态',
        steps: ['步骤'],
        acceptance: ['用户名输入框值等于 admin'],
      }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.scenarios[0].acceptance[0]).toEqual({
      kind: 'natural_language',
      text: '用户名输入框值等于 admin',
    })
  })

  it('natural_language 必须有非空 text（空串 → 报错）', () => {
    const r = validatePlaybook({
      specPath: 'docs/specs/qi-1.md',
      scenarios: [{
        id: 's1', name: 's', steps: ['x'],
        acceptance: [{ kind: 'natural_language', text: '' }],
      }],
    })
    expect(r.ok).toBe(false)
  })
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `npx vitest run src/__tests__/unit/playbook-schema.test.ts -t "natural_language"`

Expected: 3 个新测试全部 FAIL（schema 不识别 `kind: 'natural_language'` 也不接受裸 string）

- [ ] **Step 3: 改 schema 支持 NL 形态**

修改 `src/e2e/pipeline-b/playbook/types.ts`，找到 acceptanceSchema 定义（第 82-90 行）：

```ts
export const acceptanceSchema = z.discriminatedUnion('kind', [
  urlMatchSchema,
  urlRegexSchema,
  domVisibleSchema,
  domTextContainsSchema,
  apiResponseSchema,
  logContainsSchema,
  dbQuerySchema,
])
```

替换为：

```ts
const naturalLanguageAcceptanceSchema = z.object({
  kind: z.literal('natural_language'),
  text: z.string().min(1),
})

export const acceptanceSchema = z.union([
  z.discriminatedUnion('kind', [
    urlMatchSchema,
    urlRegexSchema,
    domVisibleSchema,
    domTextContainsSchema,
    apiResponseSchema,
    logContainsSchema,
    dbQuerySchema,
    naturalLanguageAcceptanceSchema,
  ]),
  // 顶级裸 string —— 自动包成 {kind: 'natural_language', text}
  z.string().min(1).transform((s) => ({
    kind: 'natural_language' as const,
    text: s,
  })),
])
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `npx vitest run src/__tests__/unit/playbook-schema.test.ts`

Expected: 全部 PASS（包括新 3 个 + 现有 7 种 kind 回归）

- [ ] **Step 5: typecheck**

Run: `pnpm exec tsc --noEmit`

Expected: 0 errors

- [ ] **Step 6: commit**

```bash
git add src/e2e/pipeline-b/playbook/types.ts src/__tests__/unit/playbook-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(e2e-playbook): acceptance schema 加 natural_language kind 形态

支持 dev-loop 直接 dump string acceptance（{kind:'natural_language',text}
对象 + 裸 string 自动 transform 两种写法）。pipeline-b 现有 7 种 strict
kind playbook 一字不动。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: parsePlaybookYaml dev-loop 风格 YAML 集成测试

**Files:**
- Test: `src/__tests__/unit/playbook-schema.test.ts:30`（`describe('parsePlaybookYaml')` 块尾部）

- [ ] **Step 1: 写测试 — dev-loop 风格 YAML（specTitle + 全 NL acceptance）解析通过**

在 `src/__tests__/unit/playbook-schema.test.ts` 第 96 行（`describe('parsePlaybookYaml')` 块的末尾，"`scenario.id 重复 → superRefine 报错`" 测试之后、`describe('acceptance 类型')` 之前）插入：

```ts
  it('dev-loop 风格 YAML（specTitle + 全 NL string acceptance）解析通过', () => {
    const yaml = `
specPath: docs/specs/qi-42.md
specTitle: 用户登录记住用户名
scenarios:
  - id: remember-username
    name: 勾选记住用户名后下次自动填充
    tags: [happy]
    steps:
      - "打开 /login"
      - "输入用户名 admin 并勾选「记住用户名」"
      - "点击登录按钮"
    acceptance:
      - "页面 URL 跳转到 /dashboard"
      - "通过 page.evaluate(() => localStorage.getItem('chatops_remembered_username')) 获取值等于 'admin'"
`
    const r = parsePlaybookYaml(yaml)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.specPath).toBe('docs/specs/qi-42.md')
    expect(r.value.specTitle).toBe('用户登录记住用户名')
    expect(r.value.scenarios[0].acceptance).toHaveLength(2)
    expect(r.value.scenarios[0].acceptance[0]).toEqual({
      kind: 'natural_language',
      text: '页面 URL 跳转到 /dashboard',
    })
    expect(r.value.scenarios[0].acceptance[1].kind).toBe('natural_language')
  })
```

- [ ] **Step 2: 跑测试确认 pass**（schema 已在 Task 1 改完）

Run: `npx vitest run src/__tests__/unit/playbook-schema.test.ts -t "dev-loop 风格"`

Expected: PASS

- [ ] **Step 3: 跑全套 schema 测试确认无回归**

Run: `npx vitest run src/__tests__/unit/playbook-schema.test.ts`

Expected: 全部 PASS（含原有 25+ case）

- [ ] **Step 4: commit**

```bash
git add src/__tests__/unit/playbook-schema.test.ts
git commit -m "$(cat <<'EOF'
test(e2e-playbook): dev-loop 风格 NL acceptance YAML 解析集成测试

模拟 spec_author 真实输出形态（specTitle + 裸 string acceptance）走完
parsePlaybookYaml 全链路。覆盖根因里报的 specPath/acceptance 字段错的
反向回归。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: dev-loop.md 字段名修正

**Files:**
- Modify: `.claude/skills/quick-impl-artifact-author/roles/dev-loop.md:116-128`

- [ ] **Step 1: Read 当前模板段确认行号**

Run: 

```bash
sed -n '110,140p' .claude/skills/quick-impl-artifact-author/roles/dev-loop.md
```

Expected output: 看到 L116 起的 ```yaml ... ``` 模板块

- [ ] **Step 2: 改字段名（3 处）**

用 Edit 工具替换 `.claude/skills/quick-impl-artifact-author/roles/dev-loop.md` 中 L116-128 的 YAML 模板块。

old_string（包含开头 3 个空格的代码块缩进）：

```
   ```yaml
   playbook_id: qi-{requirementId}
   spec_path: docs/specs/qi-{requirementId}.md
   spec_title: "{spec.title 或 spec.summary 截前 80 字}"
   scenarios:
     - id: {scenario.id}
       name: "{scenario.name}"
       tags: [{tags...}]
       steps:
         - "{step}"
       acceptance:
         - "{acceptance}"
   ```
```

new_string：

```
   ```yaml
   specPath: docs/specs/qi-{requirementId}.md
   specTitle: "{spec.summary 截前 80 字}"
   scenarios:
     - id: {scenario.id}
       name: "{scenario.name}"
       tags: [{tags...}]
       steps:
         - "{step}"
       acceptance:
         - "{acceptance}"
   ```
```

变化点：
- 删 `playbook_id: qi-{requirementId}` 整行（playbookSchema 不识别此字段，会被吞掉但写它是误导）
- `spec_path:` → `specPath:`
- `spec_title:` → `specTitle:`
- `{spec.title 或 spec.summary 截前 80 字}` → `{spec.summary 截前 80 字}`（SpecAuthorOutputSchema 没有 title 字段，原模板里 `spec.title` 永远 undefined 走兜底）

- [ ] **Step 3: 验证 grep 结果**

Run: `grep -n "specPath\|specTitle\|playbook_id\|spec_path\|spec_title" .claude/skills/quick-impl-artifact-author/roles/dev-loop.md`

Expected output: 只看到 `specPath: ...` 和 `specTitle: ...` 两行；**没有** `playbook_id` / `spec_path` / `spec_title` / `spec.title`。

- [ ] **Step 4: commit**

```bash
git add .claude/skills/quick-impl-artifact-author/roles/dev-loop.md
git commit -m "$(cat <<'EOF'
fix(skill/dev-loop): playbook YAML 字段名 camelCase 对齐 schema

- 删 playbook_id（schema 无此字段）
- spec_path → specPath；spec_title → specTitle
- {spec.title 或 spec.summary} → {spec.summary}（SpecAuthorOutputSchema
  没有 title 字段，仅 summary）

修因：dev-loop 写出来的 YAML 用 snake_case，playbookSchema 用 camelCase；
落盘后 qi_e2e_runner 校验 specPath: undefined 报错。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: scenario runner SKILL.md NL acceptance 升级

**Files:**
- Modify: `src/agent/e2e-scenario/skill/SKILL.md:46`（Phase 1 总指引）
- Modify: `src/agent/e2e-scenario/skill/SKILL.md:159`（"no downgrades" 边界）
- Modify: `src/agent/e2e-scenario/skill/SKILL.md`（新增 Phase 4.5 章节，插在 Phase 4 后 Phase 5 前）

- [ ] **Step 1: Read 上下文确认行号**

Run: `sed -n '44,76p' src/agent/e2e-scenario/skill/SKILL.md`

记下 Phase 1 line 46 起的 kind 表行号、Phase 4 末尾位置、Phase 5 起始位置。

- [ ] **Step 2: 改 Phase 1 line 46 总指引分支化**

用 Edit 替换 Phase 1 段落开头到 kind 表结束这一整块。

old_string（line 46-56 范围，含表头和分隔行）：

```
Read the YAML scenario in your input. For each `acceptance` item, identify which `kind` it is and what tool you'll use to verify it:

| kind | Tool |
|---|---|
| `url_match` / `url_regex` | Playwright MCP — read current URL after navigation |
| `dom_visible` / `dom_text_contains` | Playwright MCP `browser_snapshot` + element search |
| `api_response` | `curl` (or check `browser_network_requests` if triggered by UI) |
| `log_contains` | `docker logs <containerId>` filtered with grep |
| `db_query` | `psql "$dsn" -c "..."` against the DSN named by `connection` |

If a `connection` referenced by `db_query` is not in `sandboxHandle.endpoints`, **fail that acceptance with `result=error`** and continue — do not invent a DSN.
```

new_string：

```
Read the YAML scenario in your input. Each `acceptance` item is one of two shapes:

**Shape A — strict kind** (object with `kind` field, 7 enumerated types). Identify the `kind` and use the mandated tool below.
**Shape B — natural language** (`kind: 'natural_language'` with `text`, OR a bare string in YAML). Skip the table and jump to **Phase 4.5** for free-form verification.

For Shape A:

| kind | Tool |
|---|---|
| `url_match` / `url_regex` | Playwright MCP — read current URL after navigation |
| `dom_visible` / `dom_text_contains` | Playwright MCP `browser_snapshot` + element search |
| `api_response` | `curl` (or check `browser_network_requests` if triggered by UI) |
| `log_contains` | `docker logs <containerId>` filtered with grep |
| `db_query` | `psql "$dsn" -c "..."` against the DSN named by `connection` |

If a `connection` referenced by `db_query` is not in `sandboxHandle.endpoints`, **fail that acceptance with `result=error`** and continue — do not invent a DSN.
```

- [ ] **Step 3: 改 line ~159 "no downgrades" 边界澄清**

先 grep 定位精确行：

Run: `grep -n "no downgrades\|dictates the verification tool" src/agent/e2e-scenario/skill/SKILL.md`

用 Edit 替换该行所在的 bullet。

old_string：

```
- **`acceptance.kind` dictates the verification tool — no downgrades.**
```

new_string：

```
- **For the 7 strict kinds, `acceptance.kind` dictates the verification tool — no downgrades** (`dom_visible` cannot be replaced by `curl`). The `natural_language` shape is exempt: pick whatever tool fits the assertion (Phase 4.5).
```

- [ ] **Step 4: 新增 Phase 4.5 章节**

先 grep 定位 Phase 5 起始行：

Run: `grep -n "^## Phase 5" src/agent/e2e-scenario/skill/SKILL.md`

用 Edit 在 `## Phase 5: Collect Artifacts` 行**之前**插入：

old_string：

```
## Phase 5: Collect Artifacts
```

new_string：

```
## Phase 4.5: Verifying natural-language acceptance

When `acceptance.kind === 'natural_language'` (or the YAML wrote it as a bare string, which is automatically wrapped to that shape), read `text` and pick the right verification tool yourself. Examples:

| `text` says... | Pick |
|---|---|
| "页面 URL 是 X" / "跳转到 Y" | Playwright MCP read URL |
| "看到元素 / 文字 X" | `browser_snapshot` + element search |
| "input 的 value 等于 X" / "焦点在 X" / 任何需要跑 JS 的 | Playwright MCP `browser_evaluate` (page.evaluate) |
| "API 返回 X" / "HTTP 状态 X" | `curl` (or `browser_network_requests`) |
| "数据库表 X 里 Y 等于 Z" | `psql` against the named DSN in `sandboxHandle.endpoints` |
| "日志里出现 X" | `docker logs <containerId>` + grep |
| "元素 A 的 Y 坐标大于 B 的" / 视觉/几何 | `browser_evaluate` 读 `getBoundingClientRect` |

**Evidence requirements** (so a human reviewer can verify without trusting your narration):
- `acceptanceResults[i].kind` MUST be `'natural_language'`
- `acceptanceResults[i].expected` MUST be the original NL `text` verbatim
- `acceptanceResults[i].actual` MUST be the raw observed value (the URL string, the DOM snippet, the SQL row, the page.evaluate return value)
- `acceptanceResults[i].reason` MUST be one sentence stating the tool you used (e.g. `"page.evaluate read localStorage.getItem('chatops_remembered_username') = 'admin'"`)
- At least 1 entry in `artifacts[]` for this acceptance: a screenshot, a `db-N.sql.txt`, or a text file with the page.evaluate return value. Reviewer must be able to judge pass/fail from the artifact alone, without re-running anything.

If `text` is too vague to verify (e.g. "用户体验良好"), set `result=error` with `reason` explaining what's missing — do not pretend to verify.

```

- [ ] **Step 5: 验证 grep 结果**

Run: `grep -n "Phase 4.5\|natural_language\|Shape A\|Shape B" src/agent/e2e-scenario/skill/SKILL.md`

Expected: 至少 5+ 行命中（Phase 1 分支 + Phase 4 边界 + Phase 4.5 整段）

- [ ] **Step 6: commit**

```bash
git add src/agent/e2e-scenario/skill/SKILL.md
git commit -m "$(cat <<'EOF'
feat(skill/e2e-scenario): 支持 natural_language acceptance

- Phase 1 总指引分支化：strict kind 走原表，NL 跳到 Phase 4.5
- Phase 4 'no downgrades' 边界澄清：仅约束 7 种 strict kind，NL 自由选工具
- 新增 Phase 4.5: NL acceptance 消费段（决策表 + evidence 强约束）

配合 playbookSchema 加 natural_language kind 后，QI 链路 dev-loop 可直
接 dump 裸 string acceptance 让 runner 自由验证。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 跑完整测试 + 验证

- [ ] **Step 1: typecheck（前后端）**

Run: `./test.sh --typecheck`

Expected: 0 errors

- [ ] **Step 2: 跑改动相关单测**

Run: `npx vitest run src/__tests__/unit/playbook-schema.test.ts src/__tests__/unit/qi-e2e-runner.test.ts src/__tests__/unit/run-scenario-via-runner.test.ts`

Expected: 全部 PASS

- [ ] **Step 3: 跑全套测试（确认无远端回归）**

Run: `./test.sh`

Expected: 全部 PASS（200s+ 耗时正常，testcontainer postgres 启一次）

- [ ] **Step 4: 手动 review skill 文档变更**

Run: `git log --oneline -4 && git diff main~3 main -- '*.md' | head -100`

确认 4 个 commit + 文档 diff 无意外。

- [ ] **Step 5: dogfood 验证（可选 / 推荐）**

如果有进行中的 QI 需求或可触发的 demo，在 admin 后台触发一次 QI 跑通流程，确认：
1. dev-loop 写出的 YAML 通过 `qi_e2e_runner` schema 校验（不再报 `specPath: undefined`）
2. scenario runner 能消费 NL acceptance 并写出 manifest（acceptanceResults[i].kind === 'natural_language'）

如无法 dogfood，记录在 PR 描述里说明"E2E smoke 待生产环境跑通"。

---

## Self-Review Checklist

- ✅ 覆盖 spec §2.1（Task 1）、§2.2（Task 3）、§2.3（Task 4）、§2.5（Task 1+2 已含）
- ✅ §2.4 显式不做的事：plan 没有 playbook_invalid / e2e_router 拓扑改动 / dev-loop inputs 加 schemaErrors —— 全部省略
- ✅ §3 不变量：plan 没改 spec_author skill / pipeline-a / playbook-draft llm-generator / e2e_router
- ✅ 每个 task 含具体代码 / 命令 / 期望输出
- ✅ TDD 顺序：Task 1 先写失败测试 → 跑确认失败 → 改实现 → 确认通过
- ✅ 字段名一致：spec/plan 全用 `natural_language`、`specPath`、`specTitle`
- ✅ 4 个 commit 边界清晰（schema / 集成测试 / dev-loop md / SKILL.md），可独立 revert
