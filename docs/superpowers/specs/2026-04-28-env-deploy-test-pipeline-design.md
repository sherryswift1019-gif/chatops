# 环境安装部署测试 Pipeline 设计

**日期**: 2026-04-28  
**状态**: 已审批

---

## 背景与目标

团队需要一条标准化流程，在新环境（测试/预发/灰度）上完成：应用层安装部署 → 自动化测试 → 问题清单汇总 → 群通知负责人。

目前这些步骤分散执行，缺少统一的触发入口和结果汇总机制。本 pipeline 通过 IM 群指令触发，将所有步骤串成一条可追踪、可重试的流水线。

---

## Pipeline 结构

```
im_input
  └─→ script (角色1 安装+部署)   retry:2, onFailure:stop
        └─→ script (角色2 安装+部署)   retry:2, onFailure:stop
              └─→ … (按角色顺序，N 个节点)
                    └─→ script (运行自动化测试)   retry:0, onFailure:continue
                          └─→ switch (exitCode == 0?)
                                ├─ 通过 → template_render (成功模板) → im_group (群通知)
                                └─ 失败 → template_render (问题清单模板) → im_group (群通知)
```

### 触发方式

- **入口**: IM 群指令，绑定到对应 capability
- **im_input 采集**: 目标环境名称（`envName`），用户可输入"取消"退出

### 自我修复策略

| 失败场景 | 处理方式 |
|---------|---------|
| 安装/部署脚本瞬时失败（网络、包源） | `retryCount: 2`，自动重试 |
| 安装/部署持续失败 | `onFailure: stop`，中止后续步骤，pipeline 标记为 failed |
| 测试脚本失败 | `onFailure: continue`，继续走 switch，在群通知中呈现问题清单 |

---

## 节点详细设计

### 1. im_input — 参数采集

```json
{
  "nodeTypeKey": "im_input",
  "params": {
    "prompt": "请输入目标环境名称（如 staging-01）。发送「取消」可退出。",
    "paramSchema": {
      "type": "object",
      "properties": {
        "envName": { "type": "string", "description": "目标环境名称" }
      },
      "required": ["envName"]
    }
  }
}
```

采集到的 `envName` 注入 `state.runtimeVars`，后续所有 script 节点通过 `{{vars.envName}}` 引用。

### 2. script × N — 各角色安装+部署

每个角色对应一个独立的 script 节点，按依赖顺序排列（如：先数据库角色，再应用服务角色，再前端角色）。

```json
{
  "nodeTypeKey": "script",
  "params": {
    "script": "/opt/deploy/install-role1.sh {{vars.envName}}"
  },
  "retryCount": 2,
  "retryDelayMs": 10000,
  "retryWhen": "output.exitCode != 0",
  "onFailure": "stop"
}
```

- `targetRoles` 配置对应角色的服务器
- 任一角色失败即中止，不继续运行测试，避免在不完整环境上产生误导性结果

### 3. script — 自动化测试

```json
{
  "nodeTypeKey": "script",
  "name": "run_tests",
  "params": {
    "script": "/opt/test/run-all.sh {{vars.envName}}"
  },
  "retryCount": 0,
  "onFailure": "continue"
}
```

测试脚本约定：
- `stdout`: 测试摘要 + 失败用例列表（供模板引用）
- `stderr`: 错误详情
- `exitCode`: 0 = 全部通过，非 0 = 有失败项

### 4. switch — 结果路由

```json
{
  "nodeTypeKey": "switch",
  "params": {
    "cases": [
      {
        "when": "steps.run_tests.output.exitCode == 0",
        "target": "template_success"
      }
    ],
    "default": "template_failure"
  }
}
```

### 5. template_render × 2 — 消息格式化

**成功模板** (`template_success`):
```
✅ 环境 {{vars.envName}} 部署+测试完成

所有测试通过。
{{steps.run_tests.output.stdout}}
```

**失败模板** (`template_failure`):
```
❌ 环境 {{vars.envName}} 测试发现问题

📋 问题清单：
{{steps.run_tests.output.stdout}}

🔍 错误详情：
{{steps.run_tests.output.stderr}}
```

### 6. im_group × 2 — 群通知（新增节点类型）

两条分支各有一个 im_group 节点，引用各自路径的 template 输出：

```json
// 成功路径
{
  "nodeTypeKey": "im_group",
  "params": {
    "platform": "dingtalk",
    "groupId": "<pipeline 配置时填入的目标群 ID>",
    "text": "{{steps.template_success.output.text}}"
  }
}

// 失败路径
{
  "nodeTypeKey": "im_group",
  "params": {
    "platform": "dingtalk",
    "groupId": "<pipeline 配置时填入的目标群 ID>",
    "text": "{{steps.template_failure.output.text}}"
  }
}
```

---

## 新增工作：im_group 节点类型

现有 `dm` 节点发私聊，缺少发群消息的对应节点。需新增 `im_group` 节点：

**实现参考**: `src/pipeline/node-types/dm.ts`  
**基础函数**: `src/pipeline/im-notifier.ts:notifyImGroup(platform, groupId, text)`

参数 schema：

```typescript
params: {
  platform: "dingtalk" | "feishu"   // 必填
  groupId: string                    // 必填，目标群 ID
  text: string                       // 必填，消息文本（支持模板变量）
}
output: {
  deliveredAt: string                // ISO 时间戳
}
```

**需要改动的文件**：
1. `src/pipeline/node-types/im-group.ts` — 新建，执行器实现
2. `src/pipeline/node-types/index.ts` — 添加 import
3. `src/db/schema-v49.sql` — 注册到 `pipeline_node_types`（当前最新为 v48）
4. `src/db/migrate.ts` — 追加 SCHEMA_FILES 条目
5. `src/__tests__/helpers/db.ts` — 如满足"全新表+非污染 catalog seed"则加入 resetTestDb
6. 前端 `web/src/pipeline-canvas/types.ts` — 添加 `'im_group'` 到 StageType 联合类型
7. 前端 NodeInspector — 添加 im_group 的 JSON Schema 驱动表单（platform/groupId/text 三字段）

---

## 验证方案

1. **单节点验证**: 在已有测试环境用 pipeline dryrun，逐节点确认参数模板解析正确
2. **im_group 单测**: 新建单元测试，mock `notifyImGroup`，验证 platform/groupId/text 正确传递
3. **端到端验证**:
   - 在 IM 群发指令触发 pipeline
   - 观察各 script 节点按序执行
   - 模拟测试脚本返回 exitCode=0，验证群通知收到成功消息
   - 模拟测试脚本返回 exitCode=1 + stdout 问题清单，验证群通知收到失败消息
4. **重试验证**: 让安装脚本前两次返回失败，第三次成功，确认 pipeline 继续执行

---

## 不在范围内

- 多服务器并行部署（需要 fan_out，留作后续扩展）
- LLM Agent 智能诊断（超出现有能力约定）
- 审批节点（当前 pipeline 不需要人工审批环节）
