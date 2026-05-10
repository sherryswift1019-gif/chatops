# 前端表单：枚举字段下拉规范

> 来源：[CLAUDE.md](../../CLAUDE.md) "前端表单：枚举字段下拉规范（2026-04-22）"
> 消费 role：spec-author / plan-decomposer / dev-loop / code-quality-reviewer

## 必须（MUST）

新增 / 审查任何管理后台表单时，按 **"定义 vs 使用"原则** 决定控件类型：

### 使用枚举（引用已有记录）→ 必须 `<Select>` 下拉

典型例子：
- 审批规则的 `action`（引用 capability.key）
- 审批规则的 `env`（引用 environment.name）
- pipeline 画布节点的 `capabilityKey`
- 产线环境配置里的 runtime / server 选择

要求：
1. 数据源从对应 admin API 拉（`getCapabilities` / `getEnvironments` / ...）
2. 允许通配（如 `*`）时，Select 列表首项加显式标记：
   ```tsx
   { value: '*', label: <><Tag color="purple">*</Tag> 任意 XX（通配）</> }
   ```
3. **Stale 兼容**：值不在当前列表（源记录被删 / 重命名），不清空，显示：
   ```tsx
   <ExclamationCircleTwoTone twoToneColor="#faad14" /> {value}（不在列表中）
   ```
4. `showSearch` + 自定义 `filterOption`（按 key + displayName 双字段匹配）
5. option label 形如 `{displayName} <small>({key})</small>`

### 定义枚举（创建新记录）→ 保持 `<Input>`

典型例子：
- 环境管理页新增环境时的 `name`
- 能力管理页新增 capability 时的 `key`

### 自由文本 / 动态外部数据 → 保持 `<Input>`

- GitLab 路径、Docker 容器名、分支名等
- 可选：字段下方 `extra` 文字给出格式提示

## 不得（MUST NOT）

- **不得**在使用枚举场景用 `<Input>` 让用户手填（错字风险）
- **不得**值不在列表时清空
- **不得**因为"没 API 就留 Input" — 先加 admin GET 端点（哪怕只读）

## 检查方式（HOW TO VERIFY）

```bash
# 找新增 / 修改的前端表单文件
FE_FILES=$(git -C {worktree_path} diff origin/main..HEAD --name-only | grep "^web/src/.*\.tsx$")

for f in $FE_FILES; do
  # 启发式：找新增的 <Input>，结合上下文判断
  ADDED=$(git diff origin/main..HEAD -- "$f" | grep "^+" | grep "<Input")
  if [ -n "$ADDED" ]; then
    echo "REVIEW: $f 新增 <Input>，请人工判断是否枚举字段"
    echo "$ADDED"
  fi
done
```

reviewer 输出 JSON 中：
- 使用枚举场景误用 `<Input>` → error
- 定义 / 自由文本 → 跳过
- 通过 → `evidence.selfCheck` 加 `{item: "枚举字段下拉规范", passed: true}`

## 参考实现

- [web/src/pipeline-canvas/panels/NodeInspector.tsx](../../web/src/pipeline-canvas/panels/NodeInspector.tsx) — capability Select + stale 兼容
- [web/src/pages/ApprovalRulesPage.tsx](../../web/src/pages/ApprovalRulesPage.tsx) — action/env 含通配符 Select
