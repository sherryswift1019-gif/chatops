/**
 * Quick-Impl Bootstrap
 *
 * 服务启动时调用 bootstrapQuickImpl()：
 *   - 读 system_config.quick_impl.template_version
 *   - 若不存在或版本不一致，在 test_pipelines 表创建/更新 quick-impl 流水线模板
 *   - In-flight runs 不受影响（LangGraph state 已持久化，老 run 走老 graph 快照）
 *
 * 设计：docs/prds/prd-quick-impl.md §5.1 / §5.2
 *       docs/prds/prd-quick-impl-e2e-phase2.md "状态机改造"（v9）
 */
import { getTestPipelineByName, createTestPipeline, updateTestPipeline } from '../db/repositories/test-pipelines.js'
import { getConfig, setConfig } from '../db/repositories/system-config.js'
import type { PipelineGraph, PipelineNode, PipelineEdge } from '../pipeline/types.js'

/**
 * v8 → v9: e2e_stub 替换为 qi_e2e_runner 子机（含 fix-loop / IM 人工介入）。
 * v8 in-flight QI run 仍走 v8 graph 快照（test_pipelines.graph 在 run 启动时绑定）。
 */
export const QUICK_IMPL_TEMPLATE_VERSION = 11
export const QUICK_IMPL_PIPELINE_NAME = 'quick-impl'

// ─── Node definitions ────────────────────────────────────────────────────────

const NODE_X = 300  // horizontal center
const NODE_Y_START = 80
const NODE_Y_GAP = 160  // vertical gap between nodes
let _nodeIndex = 0

function makeNode(id: string, partial: Omit<PipelineNode, 'id' | 'position' | 'targetRoles' | 'parallel' | 'timeoutSeconds' | 'retryCount'>): PipelineNode {
  const y = NODE_Y_START + (_nodeIndex++) * NODE_Y_GAP
  return {
    id,
    position: { x: NODE_X, y },
    targetRoles: [],
    parallel: false,
    timeoutSeconds: 3600,
    retryCount: 0,
    ...partial,
  } as PipelineNode
}

function buildQuickImplGraph(): PipelineGraph {
  _nodeIndex = 0  // reset counter for each build
  const nodes: PipelineNode[] = [
    makeNode('init_branch', {
      name: 'Init Branch',
      stageType: 'init_qi_branch',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        gitlabProject: '{{triggerParams.gitlabProject}}',
        baseBranch: '{{triggerParams.baseBranch}}',
      },
    } as any),

    // Spec 阶段：author → ai_review → human_gate (required) → commit_push
    makeNode('spec_author', {
      name: 'Spec Author',
      stageType: 'llm_author',
      onFailure: 'continue',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        skill: 'quick-impl-artifact-author',
        role: 'spec-author',
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        baseBranch: '{{triggerParams.baseBranch}}',
        artifactPath: 'docs/specs/qi-{{triggerParams.requirementId}}.md',
        maxTurns: 100,
        timeoutMs: 1800000,
        statusOnSuccess: 'spec_review',
        inputs: {
          rawInput: '{{triggerParams.rawInput}}',
        },
      },
    } as any),

    makeNode('spec_ai_review', {
      name: 'Spec AI Review',
      stageType: 'llm_review',
      onFailure: 'continue',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        skill: 'quick-impl-artifact-author',
        role: 'spec-reviewer',
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        baseBranch: '{{triggerParams.baseBranch}}',
        artifactPath: 'docs/specs/qi-{{triggerParams.requirementId}}.md',
        maxTurns: 30,
        timeoutMs: 600000,
      },
    } as any),

    makeNode('spec_human_gate', {
      name: 'Spec Human Gate',
      stageType: 'human_gate',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        mode: 'required',
        timeoutSeconds: 86400,
        onTimeout: 'reject',
        approvalKind: 'spec',
        approverIds: '{{vars.qiApproverIds}}',
        source: 'ai_pass',
        artifact: '{{steps.spec_author.output.skillOutput}}',
        aiReview: '{{steps.spec_ai_review.output}}',
      },
    } as any),

    makeNode('spec_commit_push', {
      name: 'Spec Commit & Push',
      stageType: 'git_commit_push',
      onFailure: 'stop',
      params: {
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        artifactPaths: ['docs/specs/qi-{{triggerParams.requirementId}}.md'],
        commitMessage: 'docs(qi-{{triggerParams.requirementId}}): spec — {{triggerParams.title}}',
      },
    } as any),

    // Plan 阶段：author → ai_review → human_gate (on_fail) → commit_push
    makeNode('plan_author', {
      name: 'Plan Author',
      stageType: 'llm_author',
      onFailure: 'continue',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        skill: 'quick-impl-artifact-author',
        role: 'plan-decomposer',
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        baseBranch: '{{triggerParams.baseBranch}}',
        artifactPath: 'docs/plans/qi-{{triggerParams.requirementId}}.md',
        maxTurns: 100,
        timeoutMs: 1800000,
        statusOnSuccess: 'planning',
        inputs: {
          spec: '{{steps.spec_author.output.skillOutput}}',
          specPath: '{{steps.spec_author.output.artifactPath}}',
          rawInput: '{{triggerParams.rawInput}}',
        },
      },
    } as any),

    makeNode('plan_ai_review', {
      name: 'Plan AI Review',
      stageType: 'llm_review',
      onFailure: 'continue',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        skill: 'quick-impl-artifact-author',
        role: 'plan-reviewer',
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        baseBranch: '{{triggerParams.baseBranch}}',
        artifactPath: 'docs/plans/qi-{{triggerParams.requirementId}}.md',
        maxTurns: 30,
        timeoutMs: 600000,
        inputs: {
          spec: '{{steps.spec_author.output.skillOutput}}',
        },
      },
    } as any),

    makeNode('plan_human_gate', {
      name: 'Plan Human Gate',
      stageType: 'human_gate',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        mode: 'on_fail',
        timeoutSeconds: 172800,
        onTimeout: 'reject',
        approvalKind: 'plan',
        approverIds: '{{vars.qiApproverIds}}',
        source: 'ai_escalation',
        artifact: '{{steps.plan_author.output.skillOutput}}',
        aiReview: '{{steps.plan_ai_review.output}}',
        aiAttempts: 3,
      },
    } as any),

    makeNode('plan_commit_push', {
      name: 'Plan Commit & Push',
      stageType: 'git_commit_push',
      onFailure: 'stop',
      params: {
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        artifactPaths: ['docs/plans/qi-{{triggerParams.requirementId}}.md'],
        commitMessage: 'docs(qi-{{triggerParams.requirementId}}): plan',
      },
    } as any),

    // Dev 阶段：author → ai_review → human_gate (on_fail) → dev_push (pushOnly)
    makeNode('dev_author', {
      name: 'Dev Author',
      stageType: 'llm_author',
      onFailure: 'continue',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        skill: 'quick-impl-artifact-author',
        role: 'dev-loop',
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        baseBranch: '{{triggerParams.baseBranch}}',
        artifactPath: '{{steps.init_branch.output.worktreePath}}',
        maxTurns: 200,
        timeoutMs: 3600000,
        statusOnSuccess: 'developing',
        inputs: {
          spec: '{{steps.spec_author.output.skillOutput}}',
          plan: '{{steps.plan_author.output.skillOutput}}',
          planPath: '{{steps.plan_author.output.artifactPath}}',
          planTasks: '{{steps.plan_author.output.skillOutput.tasks}}',
          requirementId: '{{triggerParams.requirementId}}',
        },
      },
    } as any),

    makeNode('dev_ai_review', {
      name: 'Dev AI Review',
      stageType: 'llm_review',
      onFailure: 'continue',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        skill: 'quick-impl-artifact-author',
        role: 'code-quality-reviewer',
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        baseBranch: '{{triggerParams.baseBranch}}',
        artifactPath: '{{steps.init_branch.output.worktreePath}}',
        maxTurns: 30,
        timeoutMs: 600000,
        inputs: {
          spec: '{{steps.spec_author.output.skillOutput}}',
          plan: '{{steps.plan_author.output.skillOutput}}',
          tasksDone: '{{steps.dev_author.output.skillOutput.tasksDone}}',
        },
      },
    } as any),

    makeNode('dev_human_gate', {
      name: 'Dev Human Gate',
      stageType: 'human_gate',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        mode: 'on_fail',
        timeoutSeconds: 172800,
        onTimeout: 'reject',
        approvalKind: 'plan',
        approverIds: '{{vars.qiApproverIds}}',
        source: 'ai_escalation',
        artifact: '{{steps.dev_author.output.skillOutput}}',
        aiReview: '{{steps.dev_ai_review.output}}',
        aiAttempts: 3,
      },
    } as any),

    makeNode('dev_push', {
      name: 'Dev Push',
      stageType: 'git_commit_push',
      onFailure: 'stop',
      params: {
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        pushOnly: true,
        statusOnSuccess: 'testing',
      },
    } as any),

    // v9: 取代 e2e_stub 的真实 E2E 节点
    makeNode('qi_e2e_runner', {
      name: 'QI E2E Test',
      stageType: 'qi_e2e_runner',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        bareRepoPath: '{{steps.init_branch.output.bareRepoPath}}',
        maxAttempts: 2,
      },
    } as any),

    // 路由：根据 qi_e2e_runner.output.result + attempt 分流
    makeNode('e2e_router', {
      name: 'E2E Router',
      stageType: 'switch',
      onFailure: 'stop',
      params: {
        cases: [
          {
            when: "steps.qi_e2e_runner.output.result == 'pass' || steps.qi_e2e_runner.output.result == 'skipped'",
            target: 'final_approval',
          },
          {
            when: "steps.qi_e2e_runner.output.result == 'sandbox_failed'",
            target: 'e2e_sandbox_intervention',
          },
          {
            when: "steps.qi_e2e_runner.output.result == 'fail' && steps.qi_e2e_runner.output.attempt < 2",
            target: 'dev_fix_author',
          },
        ],
        default: 'e2e_im_intervention',
      },
    } as any),

    // Dev Fix 阶段：dev_fix_author + dev_fix_ai_review（无 human_gate，e2e 修复速度优先）
    makeNode('dev_fix_author', {
      name: 'Dev Fix Author',
      stageType: 'llm_author',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        skill: 'quick-impl-artifact-author',
        role: 'dev-loop',
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        baseBranch: '{{triggerParams.baseBranch}}',
        artifactPath: '{{steps.init_branch.output.worktreePath}}',
        maxTurns: 120,
        timeoutMs: 1800000,
        // 不切 status（仍是 'testing'）
        inputs: {
          spec: '{{steps.spec_author.output.skillOutput}}',
          plan: '{{steps.plan_author.output.skillOutput}}',
          planPath: '{{steps.plan_author.output.artifactPath}}',
          planTasks: '{{steps.plan_author.output.skillOutput.tasks}}',
          failureReport: '{{steps.qi_e2e_runner.output.failureReport}}',
          humanNote: '{{steps.e2e_im_intervention.output.humanNote}}',
          attempt: '{{steps.qi_e2e_runner.output.attempt}}',
          mode: 'e2e_fix',
        },
      },
    } as any),

    makeNode('dev_fix_ai_review', {
      name: 'Dev Fix AI Review',
      stageType: 'llm_review',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        skill: 'quick-impl-artifact-author',
        role: 'code-quality-reviewer',
        worktreePath: '{{steps.init_branch.output.worktreePath}}',
        branch: '{{steps.init_branch.output.branch}}',
        baseBranch: '{{triggerParams.baseBranch}}',
        artifactPath: '{{steps.init_branch.output.worktreePath}}',
        maxTurns: 20,
        timeoutMs: 300000,
        inputs: {
          failureReport: '{{steps.qi_e2e_runner.output.failureReport}}',
          mode: 'e2e_fix',
        },
      },
    } as any),

    // E2E 第 3 轮 IM 人工介入（3 按钮：fix / force_passed / aborted）
    makeNode('e2e_im_intervention', {
      name: 'E2E 人工介入',
      stageType: 'im_input',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        kind: 'qi_e2e_intervention',
        approverIds: '{{vars.qiApproverIds}}',
        requirementTitle: '{{triggerParams.title}}',
        contextPayload: {
          failureReport: '{{steps.qi_e2e_runner.output.failureReport}}',
        },
        timeoutSeconds: 86400,
      },
    } as any),

    // 路由：根据 e2e_im_intervention.output.decision 分流
    makeNode('e2e_intervention_router', {
      name: 'IM 决策路由',
      stageType: 'switch',
      onFailure: 'stop',
      params: {
        cases: [
          {
            when: "steps.e2e_im_intervention.output.decision == 'force_passed'",
            target: 'final_approval',
          },
          {
            when: "steps.e2e_im_intervention.output.decision == 'fix'",
            target: 'dev_fix_author',
          },
        ],
        default: 'cleanup', // aborted 走结束分支
      },
    } as any),

    // Sandbox 失败 IM 介入（2 按钮：retry → fix / aborted）
    makeNode('e2e_sandbox_intervention', {
      name: 'Sandbox 失败介入',
      stageType: 'im_input',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        kind: 'qi_sandbox_failed',
        approverIds: '{{vars.qiApproverIds}}',
        requirementTitle: '{{triggerParams.title}}',
        contextPayload: {
          sandboxError: '{{steps.qi_e2e_runner.output.sandboxError}}',
        },
        timeoutSeconds: 86400,
      },
    } as any),

    // 路由：sandbox 介入决策
    makeNode('sandbox_intervention_router', {
      name: 'Sandbox 决策路由',
      stageType: 'switch',
      onFailure: 'stop',
      params: {
        cases: [
          {
            when: "steps.e2e_sandbox_intervention.output.decision == 'fix'",
            target: 'qi_e2e_runner',
          },
        ],
        default: 'cleanup', // aborted → 终止
      },
    } as any),

    makeNode('final_approval', {
      name: 'Final Approval',
      stageType: 'human_gate',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        mode: 'required',
        timeoutSeconds: 86400,
        onTimeout: 'reject',
        approvalKind: 'final',
        approverIds: '{{vars.qiApproverIds}}',
        source: 'final',
        statusOnSuccess: 'mr_pending',
        artifact: {
          spec: '{{steps.spec_author.output.skillOutput}}',
          plan: '{{steps.plan_author.output.skillOutput}}',
          devTasksDone: '{{steps.dev_author.output.skillOutput.tasksDone}}',
          e2eResult: '{{steps.qi_e2e_runner.output.result}}',
          e2eAttempt: '{{steps.qi_e2e_runner.output.attempt}}',
        },
      },
    } as any),

    makeNode('mr_create', {
      name: 'Create MR',
      stageType: 'mr_create',
      onFailure: 'stop',
      params: {
        requirementId: '{{triggerParams.requirementId}}',
        titleTemplate: 'Draft: [quick-impl] {{triggerParams.title}}',
        labels: ['quick-impl'],
        removeSourceBranchAfterMerge: true,
        squashCommits: false,
        draft: true,
        statusOnSuccess: 'mr_open',
        inputs: {
          spec: '{{steps.spec_author.output.skillOutput}}',
          plan: '{{steps.plan_author.output.skillOutput}}',
          devReview: '{{steps.dev_ai_review.output}}',
          tasksDone: '{{steps.dev_author.output.skillOutput.tasksDone}}',
        },
      },
    } as any),

    makeNode('cleanup', {
      name: 'Cleanup',
      stageType: 'cleanup',
      onFailure: 'stop',
      params: {
        targets: [
          { kind: 'worktree', path: '{{steps.init_branch.output.worktreePath}}' },
          { kind: 'bare_repo', path: '{{steps.init_branch.output.bareRepoPath}}' },
        ],
        statusOnSuccess: 'aborted',
      },
    } as any),

    makeNode('done', {
      name: 'Done',
      stageType: 'end',
      onFailure: 'stop',
      params: {},
    } as any),
  ]

  // ─── Edges：v10 plan_review_loop 条件路由 + v9 e2e 分支循环 ───────────────────
  // 线性前段：init → spec → plan_review_loop
  const linearChainFront = ['init_branch', 'spec_review_loop', 'plan_review_loop']
  // 线性后段：dev → qi_e2e_runner → e2e_router（plan_human_escalation 也汇入 dev）
  const linearChainBack = ['dev_with_review_loop', 'qi_e2e_runner', 'e2e_router']
  const edges: PipelineEdge[] = []
  for (let i = 0; i < linearChainFront.length - 1; i++) {
    edges.push({
      id: `${linearChainFront[i]}__${linearChainFront[i + 1]}`,
      source: linearChainFront[i],
      target: linearChainFront[i + 1],
    })
  }
  for (let i = 0; i < linearChainBack.length - 1; i++) {
    edges.push({
      id: `${linearChainBack[i]}__${linearChainBack[i + 1]}`,
      source: linearChainBack[i],
      target: linearChainBack[i + 1],
    })
  }

  // plan_review_loop 条件路由
  edges.push({
    id: 'plan_review_loop__dev_with_review_loop',
    source: 'plan_review_loop',
    target: 'dev_with_review_loop',
    condition: { kind: 'onSuccess' },
  })
  edges.push({
    id: 'plan_review_loop__plan_human_escalation',
    source: 'plan_review_loop',
    target: 'plan_human_escalation',
    condition: { kind: 'onFailure' },
  })
  edges.push({
    id: 'plan_human_escalation__dev_with_review_loop',
    source: 'plan_human_escalation',
    target: 'dev_with_review_loop',
    condition: { kind: 'onSuccess' },
  })

  // e2e_router → 4 个目标
  for (const target of ['final_approval', 'e2e_sandbox_intervention', 'dev_loop_for_e2e_fix', 'e2e_im_intervention']) {
    edges.push({ id: `e2e_router__${target}`, source: 'e2e_router', target })
  }

  // dev_loop_for_e2e_fix 修完 → 回 qi_e2e_runner 重跑
  edges.push({ id: 'dev_loop_for_e2e_fix__qi_e2e_runner', source: 'dev_loop_for_e2e_fix', target: 'qi_e2e_runner' })

  // e2e_im_intervention → e2e_intervention_router → 3 个目标
  edges.push({ id: 'e2e_im_intervention__e2e_intervention_router', source: 'e2e_im_intervention', target: 'e2e_intervention_router' })
  for (const target of ['final_approval', 'dev_loop_for_e2e_fix', 'mr_create_skip']) {
    edges.push({ id: `e2e_intervention_router__${target}`, source: 'e2e_intervention_router', target })
  }

  // e2e_sandbox_intervention → sandbox_intervention_router → 2 个目标
  edges.push({ id: 'e2e_sandbox_intervention__sandbox_intervention_router', source: 'e2e_sandbox_intervention', target: 'sandbox_intervention_router' })
  for (const target of ['qi_e2e_runner', 'mr_create_skip']) {
    edges.push({ id: `sandbox_intervention_router__${target}`, source: 'sandbox_intervention_router', target })
  }

  // 终态线性：final_approval → mr_create
  edges.push({ id: 'final_approval__mr_create', source: 'final_approval', target: 'mr_create' })

  return { nodes, edges }
}

// ─── Bootstrap entry ─────────────────────────────────────────────────────────

export async function bootstrapQuickImpl(): Promise<void> {
  const configEntry = await getConfig('quick_impl')
  const currentVersion = configEntry?.value?.template_version as number | undefined

  if (currentVersion === QUICK_IMPL_TEMPLATE_VERSION) {
    return // already up-to-date
  }

  const graph = buildQuickImplGraph()
  const existing = await getTestPipelineByName(QUICK_IMPL_PIPELINE_NAME)

  if (!existing) {
    await createTestPipeline({
      name: QUICK_IMPL_PIPELINE_NAME,
      description: 'Quick-Impl：一句话需求 → 自动产出 MR（v10 plan AI review + human escalation）',
      stages: [],
      graph,
      enabled: true,
      variables: { qiApproverIds: '' },
    })
  } else {
    await updateTestPipeline(existing.id, {
      graph,
      // 保留已有 variables，补充缺失的默认键
      variables: { qiApproverIds: '', ...(existing.variables as Record<string, unknown> ?? {}) },
    })
  }

  await setConfig('quick_impl', {
    ...(configEntry?.value ?? {}),
    template_version: QUICK_IMPL_TEMPLATE_VERSION,
  })

  console.log(`[quick-impl] bootstrap: pipeline template updated to v${QUICK_IMPL_TEMPLATE_VERSION}`)
}
