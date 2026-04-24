# PRD 主动提交 MR · M4b 可应用 patch

> **触发时机**: 未来 passive PRD review（`doc-review-handler.ts`）合入 main 时
> **改动量**: 3 行（不含空行/注释）
> **风险**: 极低（早退，不影响任何原逻辑）
> **本次不做的原因**: main 当前无 `src/adapters/gitlab/doc-review-handler.ts`；passive 还在 `/Users/zhangshanshan/chatops` 的 `prd-onepass` 分支活跃开发中，**不能动那个工作副本**

---

## 1. 为什么需要这个 patch

E2E 冒烟时（[prd-active-submit-e2e-log.md](prd-active-submit-e2e-log.md)）首次跑 Case G 失败，定位后发现：

- GitLab project webhook 指向**另一份** chatops 实例（passive review 在那边跑）
- passive `doc-review-handler` 收到 MR `open/update` webhook 就自己跑一遍 review
- 如果 passive review 判定 blocked → **重新加 `Draft:` 前缀**（[doc-review-handler.ts:260](../../../chatops/src/adapters/gitlab/doc-review-handler.ts#L260)）
- 结果：active 链路 review pass 后 un-draft，**几秒内被 passive 强制回 Draft**

冒烟脚本目前用"临时关 merge_requests_events webhook"绕过（见 `scripts/e2e-prd-submit.sh` 的 `disable_mr_webhook_if_any`），**那只是开发期 workaround**。上线后必须在 passive 里加 **label 短路**，让 passive 看到 `prd-active-review` label 时早退、把 review 主权交给 active 链路。

---

## 2. Patch 内容（3 行）

**文件**: `src/adapters/gitlab/doc-review-handler.ts`（passive 合入 main 后才存在）

**插入点**：在 `state !== 'opened'` 判断的 `}` 之后、`// 2. 拉 changes` 注释之前（passive 当前源对应 **L70 与 L72 之间**——未来合入 main 时行号可能漂移，按语义识别）

**diff 形式**：

```diff
   if (mr.state !== 'opened') {
     console.log(`[doc-review] MR ${projectPath}!${mrIid} state=${mr.state}，跳过`)
     return
   }

+  // active 主动提交链路 (prd_submit pipeline) 会给它托管的 MR 打 `prd-active-review` label。
+  // passive review 看到这条 label 必须早退——否则两边会对同一个 MR 反复争夺 Draft 状态：
+  //   active review pass → un-draft → webhook 触发 passive → passive 若判 blocked → 重加 Draft
+  // 见 docs/prds/prd-active-submit.md §3.5 和 E2E 冒烟 Case G 反复现象
+  if (mr.labels?.includes('prd-active-review')) {
+    console.log(`[doc-review] MR ${projectPath}!${mrIid} 带 prd-active-review label（主动提交链路托管），跳过 passive review`)
+    return
+  }
+
   // 2. 拉 changes，过滤 PRD 路径
   let changeSet
```

**核心 3 行**（带注释 8 行）：

```ts
if (mr.labels?.includes('prd-active-review')) {
  console.log(`[doc-review] MR ${projectPath}!${mrIid} 带 prd-active-review label（主动提交链路托管），跳过 passive review`)
  return
}
```

---

## 3. 前置条件检查

**在 passive 合入 main 后**，确认下面两条都成立再 apply：

- [ ] `src/adapters/gitlab/doc-review-handler.ts` 的 `handleMergeRequestForDocReview` 函数里**仍有** `if (mr.state !== 'opened')` 的早退块（如果 passive 重构了函数结构，需要重新找语义等价的插入点）
- [ ] `getMr()` 返回的 `MrInfo` / `MergeRequest` 类型**仍含** `labels: string[]` 字段（passive 当前源 `src/adapters/gitlab/mr-api.ts:40` 已有；若 passive 重构后缺，补 `labels?: string[]`）

---

## 4. Apply 后的验证步骤

**验证 A：passive 早退日志可见**

```bash
# 保持 GitLab webhook 监听 MR 事件（不要用 smoke 脚本的 disable_mr_webhook）
# 跑一次 Case A
bash scripts/e2e-prd-submit.sh A
```

然后看 passive 实例的 stderr / log：应该出现

```
[doc-review] MR PAM/devops/chatops!XX 带 prd-active-review label（主动提交链路托管），跳过 passive review
```

passive 实例**不会**往 MR 上加 `Draft:` 前缀或 `prd-review-blocked` label。

**验证 B：移除 smoke 脚本的 webhook 自愈，Case A/G 仍全绿**

临时删掉 `scripts/e2e-prd-submit.sh` 里的 `disable_mr_webhook_if_any` 调用（或改成 no-op），然后跑：

```bash
bash scripts/e2e-prd-submit.sh A G
```

预期：A 9/9、G 5/5 都通过。如果 G 第一轮后 MR 被再次 draft，说明 patch 没生效或位置错。

**验证 C：passive 对无 label 的普通 MR 行为不变**

手动推一个**不带** `prd-active-review` label 的 MR（例如直接去 GitLab UI 开一个），确认 passive 还是照常 review 它（passive 自己的 smoke 脚本应照常跑绿）。

### 4.1 本 patch 的预先实证验证（2026-04-24）

**目的**：证明 patch 代码机械正确，不是纸上谈兵。

**做法**：在**不动 passive 任何提交状态**的前提下，临时把 3 行 patch 复制到 `/Users/zhangshanshan/chatops/src/adapters/gitlab/doc-review-handler.ts`（该文件在 passive 那边是 untracked，我备份原件后就地改；passive 用 tsx watch，保存后自动 reload）→ 跑 active 的 Case A（**未关 GitLab MR webhook**）→ 验证后 `cp` 备份回去。

**实验结果**（保留 MR !23 为观察对象）：

```
跑前（前一轮 Case G 结束后的状态）:
  title="Draft: [PRD] docs(prd): smoke 测试样例 v1"
  draft=true
  labels=["prd-active-review","prd-review-blocked"]

发 trigger → 等 20 秒（足够让 pipeline 跑完 + GitLab webhook 飞一回给 passive）:

跑后：
  title="[PRD] docs(prd): smoke 测试样例 v1"   ← Draft: 前缀被 active un-draft 去掉
  draft=false                                     ← 且**稳定停在 false，没被 passive 回滚**
  labels=["prd-active-review","prd-review-blocked"]
```

**结论**：
- patch 的 3 行生效了——passive 看到 `prd-active-review` label 就 return，没有再加 Draft 前缀
- un-draft 在 active 侧完成后能"立得住"，即使 webhook 延迟触发 passive 也不再干扰
- 原先 E2E 冒烟 Case G 第一轮失败的真实原因**就是 passive 无 label 短路**——patch 针对性修复

验证完毕后，passive 文件已 `cp` 备份回去，passive 的 git 状态与实验前 bit-for-bit 一致（`diff` 结果空）。

---

## 5. 零回归清单（passive 侧必过）

patch 合入 passive 后，passive 自己的单测应全绿：

```bash
cd /path/to/passive/repo
pnpm test src/__tests__/unit/doc-review-*.test.ts
```

这些测试不应该依赖 `prd-active-review` label 的缺席；如果有关于"所有 opened MR 都会被 review"之类的强断言，可能需要更新——见 passive 测试代码。

---

## 6. 后续（patch apply 之后）

应用 M4b patch 后，可以把 `scripts/e2e-prd-submit.sh` 里的 `disable_mr_webhook_if_any` 和 `restore_mr_webhook` 两个函数连同 trap EXIT 一起**删掉**（它们只是过渡期绕过）。

或者更保守：把 webhook 自愈改为"仅在 passive 未部署短路时才触发"——例如 check passive 的版本 tag 或者直接跑一次 Case G 看是否 reset，pass 才清理。但这复杂度过高，简单删掉即可。

---

## 7. 相关位置速查

| 项 | 位置 |
|----|------|
| Passive 实例当前源（未合入 main） | `/Users/zhangshanshan/chatops/src/adapters/gitlab/doc-review-handler.ts` |
| 插入点附近（passive 当前版本） | L67-L72 的 `state !== 'opened'` 块 |
| PRD 对应章节 | [prd-active-submit.md](prd-active-submit.md) §3.5 |
| 开发计划里的 M4b | [prd-active-submit-dev-plan.md](prd-active-submit-dev-plan.md) §6 |
| 冒烟脚本 webhook 自愈（过渡期） | `scripts/e2e-prd-submit.sh` `disable_mr_webhook_if_any` |
