// 触发自注册 —— 任何模块 import 此 barrel 都会让 4 种 node type 注册到 registry
import './script.js'
import './approval.js'
import './llm-agent.js'
import './wait-webhook.js'
// Phase 3 T9-T14 simple executor
import './http.js'
import './dm.js'
import './db-update.js'
import './sql-query.js'
import './file-read.js'
import './template-render.js'
// Phase 3 T15 fan_out scheduler (standalone NodeExecutor; v1 limits in fan-out.ts)
import './fan-out.js'
import './switch.js'
import './invoke-target-script.js'
// Quick-Impl Phase 1 skill node types (interrupt-bound / context-bound)
import './skill-node.js'
import './skill-with-approval.js'
import './skill-with-review.js'
// Quick-Impl Phase 1 MR creation node type
import './mr-create.js'
// Quick-Impl Phase 1 init branch + e2e stub node types
import './init-qi-branch.js'
import './e2e-stub.js'
// Quick-Impl Phase 2 real E2E runner（替换 e2e_stub）
import './qi-e2e-runner.js'
// Quick-Impl Phase 2 IM 卡片人工介入节点
import './im-input.js'
// Pipeline Stage Types Sub-plan A: explicit END sink
import './end.js'
// Pipeline Stage Types Sub-plan A: resource cleanup
import './cleanup.js'
// Pipeline Stage Types Sub-plan A: idempotent git commit + push
import './git-commit-push.js'
// Pipeline Stage Types Sub-plan A: LLM 生成 artifact（不 commit）
import './llm-author.js'
// Pipeline Stage Types Sub-plan A: LLM 审 artifact
import './llm-review.js'

export * from './registry.js'
export * from './types.js'
