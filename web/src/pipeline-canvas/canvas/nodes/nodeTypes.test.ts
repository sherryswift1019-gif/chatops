import { describe, it, expect } from 'vitest'
import { nodeTypes } from './nodeTypes'

// QI v13 (src/quick-impl/bootstrap.ts) 用到的所有 stageType。
// 未注册的 stageType 会被 React Flow 渲染为空白默认节点 —— 编排页 UI 直接坏掉。
const QI_BOOTSTRAP_STAGE_TYPES = [
  'init_qi_branch',
  'llm_author',
  'llm_review',
  'human_gate',
  'git_commit_push',
  'switch',
  'im_input',
  'mr_create',
  'cleanup',
  'end',
] as const

describe('nodeTypes', () => {
  it.each(QI_BOOTSTRAP_STAGE_TYPES)('注册了 stageType "%s" 的渲染器', stageType => {
    expect(nodeTypes).toHaveProperty(stageType)
    expect(typeof (nodeTypes as Record<string, unknown>)[stageType]).toBe('function')
  })
})
