import { describe, it, expect } from 'vitest'
import {
  STEPPER_STAGES, mapNodeNameToStage, stageStatus,
  type V2StageResultLike,
} from './qi-stage-map'

function n(name: string, status: V2StageResultLike['status']): V2StageResultLike {
  return { name, status }
}

describe('qi-stage-map', () => {
  it('exposes 7 stages in order', () => {
    expect(STEPPER_STAGES).toEqual(['init', 'spec', 'plan', 'dev', 'review', 'e2e', 'mr'])
  })

  it('maps init_branch to init', () => {
    expect(mapNodeNameToStage('init_branch')).toBe('init')
  })

  it('maps spec_* nodes to spec', () => {
    expect(mapNodeNameToStage('spec_author')).toBe('spec')
    expect(mapNodeNameToStage('spec_ai_review')).toBe('spec')
    expect(mapNodeNameToStage('spec_human_gate')).toBe('spec')
    expect(mapNodeNameToStage('spec_commit_push')).toBe('spec')
  })

  it('maps plan_* nodes to plan', () => {
    expect(mapNodeNameToStage('plan_author')).toBe('plan')
    expect(mapNodeNameToStage('plan_commit_push')).toBe('plan')
  })

  it('maps dev_* nodes to dev (including dev_push, excluding dev_fix_*)', () => {
    expect(mapNodeNameToStage('dev_author')).toBe('dev')
    expect(mapNodeNameToStage('dev_ai_review')).toBe('dev')
    expect(mapNodeNameToStage('dev_push')).toBe('dev')
    expect(mapNodeNameToStage('dev_fix_author')).toBe('e2e')
    expect(mapNodeNameToStage('dev_fix_ai_review')).toBe('e2e')
  })

  it('maps qi_e2e_runner + e2e_* + sandbox_* to e2e', () => {
    expect(mapNodeNameToStage('qi_e2e_runner')).toBe('e2e')
    expect(mapNodeNameToStage('e2e_skip_router')).toBe('e2e')
    expect(mapNodeNameToStage('e2e_router')).toBe('e2e')
    expect(mapNodeNameToStage('e2e_im_intervention')).toBe('e2e')
    expect(mapNodeNameToStage('e2e_intervention_router')).toBe('e2e')
    expect(mapNodeNameToStage('e2e_sandbox_intervention')).toBe('e2e')
    expect(mapNodeNameToStage('sandbox_intervention_router')).toBe('e2e')
  })

  it('maps final_approval to review', () => {
    expect(mapNodeNameToStage('final_approval')).toBe('review')
  })

  it('maps mr_create / cleanup / done to mr', () => {
    expect(mapNodeNameToStage('mr_create')).toBe('mr')
    expect(mapNodeNameToStage('cleanup')).toBe('mr')
    expect(mapNodeNameToStage('done')).toBe('mr')
  })

  it('returns null for unknown nodes', () => {
    expect(mapNodeNameToStage('foo_bar')).toBeNull()
  })

  describe('stageStatus', () => {
    it('empty / all skipped → pending', () => {
      expect(stageStatus('spec', [])).toBe('pending')
      expect(stageStatus('spec', [n('spec_author', 'skipped')])).toBe('pending')
    })

    it('any failed → failed', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_ai_review', 'failed'),
      ])).toBe('failed')
    })

    it('any running → running', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_ai_review', 'running'),
      ])).toBe('running')
    })

    it('any waiting → running', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_human_gate', 'waiting'),
      ])).toBe('running')
    })

    it('all success (non-skipped) → done', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_ai_review', 'success'),
        n('spec_human_gate', 'success'),
        n('spec_commit_push', 'success'),
      ])).toBe('done')
    })

    it('any success + remaining pending → running (部分完成)', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_ai_review', 'pending'),
      ])).toBe('running')
    })

    it('all pending → pending', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'pending'),
        n('spec_ai_review', 'pending'),
      ])).toBe('pending')
    })

    it('skipped 不参与判定', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_ai_review', 'skipped'),
        n('spec_human_gate', 'success'),
        n('spec_commit_push', 'success'),
      ])).toBe('done')
    })
  })
})
