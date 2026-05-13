import { describe, it, expect } from 'vitest'
import {
  listNodeTypes,
  getNodeType,
  listEnabledNodeTypeKeys,
} from '../../db/repositories/pipeline-node-types.js'

// 注：迁移由 vitest globalSetup（src/__tests__/setup/pg-container.ts）顺序应用
// 全部 schema*.sql 文件，含 v27 (phase-0 行)、v34 (phase-3 行)、v44 (switch)、
// v60-v62 (quick_impl 系列)、v1006-v1014 (system node types)。
// 本测试仅验证 repository 行为。
describe('pipeline-node-types repository', () => {
  it('lists all seeded node types (both enabled and disabled)', async () => {
    const types = await listNodeTypes()
    const keys = types.map(t => t.key).sort()
    // 验证 repository 返回所有行（不过滤 enabled），包含 general/flow/llm/quick_impl 分类
    // 精确列表随 schema 演进；此处验证核心代表节点
    expect(keys).toContain('script')
    expect(keys).toContain('approval')
    expect(keys).toContain('llm_agent')
    expect(keys).toContain('wait_webhook')
    expect(keys).toContain('fan_out')
    expect(keys).toContain('switch')
    expect(keys).toContain('invoke_target_script')
    expect(keys).toContain('llm_brainstorm')
    expect(keys).toContain('mr_create')
    expect(keys).toContain('skill_node')
    // v1006-v1011 system nodes
    expect(keys).toContain('end')
    expect(keys).toContain('cleanup')
    expect(keys).toContain('git_commit_push')
    expect(keys).toContain('llm_author')
    expect(keys).toContain('llm_review')
    expect(keys).toContain('human_gate')
  })

  it('getNodeType returns null for unknown key', async () => {
    expect(await getNodeType('nonexistent')).toBeNull()
  })

  it('getNodeType returns parsed param_schema as object', async () => {
    const t = await getNodeType('script')
    expect(t).not.toBeNull()
    expect(typeof t!.paramSchema).toBe('object')
    expect(t!.category).toBe('general')
  })

  it('listEnabledNodeTypeKeys returns enabled-only set (28 total per globalSetup schema run)', async () => {
    const keys = await listEnabledNodeTypeKeys()
    // 核心 general 节点（全部 enabled）
    expect(keys.has('script')).toBe(true)
    expect(keys.has('approval')).toBe(true)
    expect(keys.has('llm_agent')).toBe(true)
    expect(keys.has('wait_webhook')).toBe(true)
    // phase-3 T9-T14
    expect(keys.has('http')).toBe(true)
    expect(keys.has('dm')).toBe(true)
    expect(keys.has('db_update')).toBe(true)
    expect(keys.has('sql_query')).toBe(true)
    expect(keys.has('file_read')).toBe(true)
    expect(keys.has('template_render')).toBe(true)
    // T15 fan_out 现已启用
    expect(keys.has('fan_out')).toBe(true)
    expect(keys.has('switch')).toBe(true)
    // v1000 E2E 自动化测试模块新增
    expect(keys.has('invoke_target_script')).toBe(true)
    // v1014 spec stage upgrade (T19)
    expect(keys.has('llm_brainstorm')).toBe(true)
    // v1006-v1011 system nodes
    expect(keys.has('end')).toBe(true)
    expect(keys.has('cleanup')).toBe(true)
    expect(keys.has('git_commit_push')).toBe(true)
    expect(keys.has('llm_author')).toBe(true)
    expect(keys.has('llm_review')).toBe(true)
    expect(keys.has('human_gate')).toBe(true)
    // v60-v62 quick_impl nodes
    expect(keys.has('mr_create')).toBe(true)
    expect(keys.has('skill_node')).toBe(true)
    expect(keys.has('skill_with_approval')).toBe(true)
    expect(keys.has('skill_with_review')).toBe(true)
    expect(keys.has('init_qi_branch')).toBe(true)
    expect(keys.has('e2e_stub')).toBe(true)
    expect(keys.has('qi_e2e_runner')).toBe(true)
    expect(keys.has('im_input')).toBe(true)
    expect(keys.size).toBe(28)
  })
})
