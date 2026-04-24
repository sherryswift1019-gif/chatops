# PRD 主动提交 MR · M4a 冒烟最后一次全绿日志

> **执行日期**: 2026-04-24
> **脚本**: [scripts/e2e-prd-submit.sh](../../scripts/e2e-prd-submit.sh)
> **分支**: `feature/prd-active-submit`
> **Git HEAD（冒烟时）**: `20d87a2` (含 self-review R1/R2 + GitLab compare reverse 修复)
> **结果**: **8 个 case，30/30 断言通过**

## 执行的 case

- **C** 路径错兜底（regex trip）
- **D** 跨 repo 兜底
- **E** email 缺失兜底
- **I** admin prompt migrate 持久化（B1 验证）
- **F** 不存在的 projectPath → GitLab 404 + extractErrorMessage（N2 验证）
- **A** 正向 pass + un-draft
- **B** blocked 保持 Draft + findings 排序（B3 验证）
- **G** 重复提交 force-draft 重置（核心闸门不变量）

## 完整输出

```
[2m[info][0m 检查 server 健康 (http://localhost:3100)
[2m[info][0m server OK: {"e2eMode":true,"claudeMock":true}
[2m[info][0m 检测到监听 MR 的 webhook id=118 url=http://172.16.18.132:3000/webhook/gitlab — 临时关 merge_requests_events
[2m[info][0m 即将跑的 case: C D E I F A B G

[1;33m── Case C · 路径错兜底（regex trip） ──[0m
[0;32m  ✓ PASS[0m  群回 "路径不合法" 提示
[0;32m  ✓ PASS[0m  事件表未被污染（拒前拒后同行数）

[1;33m── Case D · 跨 repo 兜底 ──[0m
[0;32m  ✓ PASS[0m  群回 "跨 repo" 提示

[1;33m── Case E · email 缺失兜底 ──[0m
[0;32m  ✓ PASS[0m  群回 "邮箱未同步" 提示

[1;33m── Case I · admin 编辑 prompt migrate 持久化（B1） ──[0m
[2m[info][0m 跑 pnpm migrate...
[0;32m  ✓ PASS[0m  admin 编辑的 prompt 在 migrate 后保留
[0;32m  ✓ PASS[0m  system_prompt 与 default_system_prompt 不同（admin 自定义生效）

[1;33m── Case F · 不存在的 projectPath → GitLab 404 + extractErrorMessage（N2） ──[0m
[0;32m  ✓ PASS[0m  prd_create_mr stage failed
[0;32m  ✓ PASS[0m  错误被 extractErrorMessage 抽到 HTTP 状态码: HTTP 404: 404 Project Not Found
[0;32m  ✓ PASS[0m  stage 3 notify 仍然跑（onFailure:continue 兜底）
[0;32m  ✓ PASS[0m  DM 发出失败通知
[0;32m  ✓ PASS[0m  DM 里含 GitLab 原始错误（HTTP 状态码前缀）

[1;33m── Case A · 正向 pass + un-draft ──[0m
[2m[info][0m handler 立即输出: ✅ 收到 PRD MR 提交请求（submissionId=prd-mr-test-1777019616098-9f4ed9），结果将通过 DM 单聊发送给你
[2m[info][0m submissionId: prd-mr-test-1777019616098-9f4ed9
[0;32m  ✓ PASS[0m  prd_submit_events 4 行都 success
[2m[info][0m MR iid=23 title=[PRD] docs(prd): smoke 测试样例 v1
[0;32m  ✓ PASS[0m  MR title 派生自最新 commit（验证 reverse 修复）
[0;32m  ✓ PASS[0m  review decision = pass
[0;32m  ✓ PASS[0m  un-draft 成功（Draft 已解除）
[0;32m  ✓ PASS[0m  GitLab MR title 无 Draft: 前缀 — [PRD] docs(prd): smoke 测试样例 v1
[0;32m  ✓ PASS[0m  GitLab work_in_progress=false（merge 可点）
[0;32m  ✓ PASS[0m  GitLab label 含 prd-active-review
[0;32m  ✓ PASS[0m  DM 含 pass 标志
[0;32m  ✓ PASS[0m  DM 含 "已解除 Draft" 文案

[1;33m── Case B · blocked 保持 Draft + findings 排序（B3） ──[0m
[0;32m  ✓ PASS[0m  review decision = blocked
[0;32m  ✓ PASS[0m  Draft 未解除（保持 Draft）
[0;32m  ✓ PASS[0m  GitLab MR 标题保持 Draft: 前缀 — Draft: [PRD] docs(prd): smoke 测试样例 v1
[0;32m  ✓ PASS[0m  DM 明确告知 MR 保持 Draft
[0;32m  ✓ PASS[0m  findings 摘要按 severity 排序，两个 blocker 在最前（B3 验证）

[1;33m── Case G · 重复提交 force-draft 重置（核心闸门不变量） ──[0m
[2m[info][0m 第一轮：review pass → un-draft
[2m[info][0m 第一轮 MR !23, reused=true
[2m[info][0m 第一轮后 title: [PRD] docs(prd): smoke 测试样例 v1
[2m[info][0m 第二轮：review blocked → force-draft 重置
[0;32m  ✓ PASS[0m  复用同一 MR iid
[0;32m  ✓ PASS[0m  prd_create_mr.data.reused=true
[0;32m  ✓ PASS[0m  prd_create_mr.data.wasForceDrafted=true
[0;32m  ✓ PASS[0m  MR 标题已重置回 Draft: 前缀 — Draft: [PRD] docs(prd): smoke 测试样例 v1
[0;32m  ✓ PASS[0m  第二轮 review decision=blocked

[1;33m──────────────────────────────[0m
通过 [0;32m30[0m，失败 [0;31m0[0m
[0;32m✅ 全部通过[0m
[2m[info][0m 恢复 webhook id=118 (merge_requests_events=true)
```
