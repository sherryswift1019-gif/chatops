import { describe, it, expect } from 'vitest'
import { getKindLabel } from '../../pipeline/qi-approval-manager.js'

/**
 * kindLabel 逻辑测试（Sub-plan B Task 2）
 *
 * 直接 import 实现，验证 IM 卡片标题映射规则：
 *   - 固定 approvalKind（spec / plan / final / qi_*）→ 固定标签
 *   - human_gate 按 kindMeta.source 推子标签（ai_pass / ai_escalation / final / fallback）
 *   - 未知 kind → '升级审批'
 */
describe('approvalKind kindLabel', () => {
  it('spec → "Spec 评审"', () => {
    expect(getKindLabel('spec')).toBe('Spec 评审')
  })

  it('plan → "Plan 评审"', () => {
    expect(getKindLabel('plan')).toBe('Plan 评审')
  })

  it('dev → "Dev 评审"（v14 新增，dev_human_gate 不再借用 plan 标签）', () => {
    expect(getKindLabel('dev')).toBe('Dev 评审')
  })

  it('final → "最终确认"', () => {
    expect(getKindLabel('final')).toBe('最终确认')
  })

  it('qi_e2e_intervention → "E2E 失败人工介入"', () => {
    expect(getKindLabel('qi_e2e_intervention')).toBe('E2E 失败人工介入')
  })

  it('qi_sandbox_failed → "Sandbox 启动失败"', () => {
    expect(getKindLabel('qi_sandbox_failed')).toBe('Sandbox 启动失败')
  })

  it('human_gate 无 kindMeta → "人工审批"（默认 fallback）', () => {
    expect(getKindLabel('human_gate')).toBe('人工审批')
  })

  it('human_gate kindMeta=null → "人工审批"', () => {
    expect(getKindLabel('human_gate', null)).toBe('人工审批')
  })

  it('human_gate source=ai_pass → "人工审核"', () => {
    expect(getKindLabel('human_gate', { source: 'ai_pass' })).toBe('人工审核')
  })

  it('human_gate source=ai_escalation → "人工裁决（AI 多轮未过）"', () => {
    expect(getKindLabel('human_gate', { source: 'ai_escalation' })).toBe('人工裁决（AI 多轮未过）')
  })

  it('human_gate source=final → "最终批准"', () => {
    expect(getKindLabel('human_gate', { source: 'final' })).toBe('最终批准')
  })

  it('human_gate unknown source → "人工审批"', () => {
    expect(getKindLabel('human_gate', { source: 'unknown_value' })).toBe('人工审批')
  })

  it('escalation → "升级审批"', () => {
    expect(getKindLabel('escalation')).toBe('升级审批')
  })

  it('unknown kind → "升级审批"', () => {
    expect(getKindLabel('totally_made_up')).toBe('升级审批')
  })
})
