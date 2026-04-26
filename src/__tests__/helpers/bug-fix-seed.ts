/**
 * 共享 seed 帮手：Pipeline 全链路集成测试专用。
 * 所有 AC 测试（l1-single-project-flow 等）使用这些 helper 避免重复。
 */
import { getTestPool } from './db.js'

export interface SeedProjectInput {
  name: string
  gitlabPath: string
  ownerId?: string
  ownerName?: string
}

export async function seedProductLine(name = 'pam'): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ($1, 'PAM', 'test')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [name],
  )
  return rows[0].id as number
}

export async function seedProject(productLineId: number, p: SeedProjectInput): Promise<void> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO projects (product_line_id, name, display_name, gitlab_path, owner_id, owner_name, description)
     VALUES ($1, $2, $3, $4, $5, $6, '')
     ON CONFLICT (name) DO UPDATE
       SET gitlab_path = EXCLUDED.gitlab_path,
           owner_id = EXCLUDED.owner_id,
           owner_name = EXCLUDED.owner_name`,
    [productLineId, p.name, p.name, p.gitlabPath, p.ownerId ?? '', p.ownerName ?? ''],
  )
}

/** 为产品线配 product_knowledge_repos（analyzer 需要）。 */
export async function seedKnowledgeRepo(
  productLineId: number,
  codeRepoUrl = 'http://code.paraview.cn/PAM/java-code/pas-6.0.git',
  defaultBranch = 'test',
): Promise<void> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO product_knowledge_repos (product_line_id, code_repo_url, code_default_branch, knowledge_repo_url, ai_summary_path)
     VALUES ($1, $2, $3, '', 'docs/ai-summary')
     ON CONFLICT (product_line_id) DO NOTHING`,
    [productLineId, codeRepoUrl, defaultBranch],
  )
}

/** 确保 analyze_bug capability 存在（带 system_prompt）。 */
export async function seedAnalyzeBugCapability(): Promise<void> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO capabilities (key, display_name, description, tool_names, is_system, system_prompt)
     VALUES ('analyze_bug', 'Bug 分析', 'Bug 分析', '[]'::jsonb, true, '你是 Bug 分析专家')
     ON CONFLICT (key) DO UPDATE SET system_prompt = EXCLUDED.system_prompt`,
  )
}

/** 确保 fix_bug_lN capability 存在（带 system_prompt）。 */
export async function seedFixBugCapabilities(): Promise<void> {
  const pool = getTestPool()
  for (const key of ['fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3']) {
    await pool.query(
      `INSERT INTO capabilities (key, display_name, description, tool_names, is_system, system_prompt)
       VALUES ($1, $1, 'test', '[]'::jsonb, true, '你是修复专家')
       ON CONFLICT (key) DO UPDATE SET system_prompt = EXCLUDED.system_prompt`,
      [key],
    )
  }
}

/**
 * 创建 L1/L2/L3/L4 Pipeline。schema-v11.sql 的 UPDATE 语句依赖 L1/L2/L3 已存在才会生效，
 * 而 resetTestDb 不跑 seed.sql，所以这里我们直接按 schema-v11 的最终 stages 结构创建。
 */
export async function seedPipelines(productLineId: number): Promise<void> {
  const pool = getTestPool()

  const l1Stages = [
    { name: 'L1 修复', stageType: 'llm_agent', capabilityKey: 'fix_bug_l1', timeoutSeconds: 1800, retryCount: 0, onFailure: 'stop', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
    { name: '创建 MR', stageType: 'llm_agent', capabilityKey: 'create_mr', timeoutSeconds: 300, retryCount: 1, onFailure: 'stop', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
    { name: 'AI Review', stageType: 'llm_agent', capabilityKey: 'ai_review_mr', timeoutSeconds: 600, retryCount: 0, onFailure: 'continue', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
    { name: '通知', stageType: 'llm_agent', capabilityKey: 'notify_bug', timeoutSeconds: 120, retryCount: 2, onFailure: 'stop', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
  ]

  const l2Stages = [
    { name: 'L2 修复', stageType: 'llm_agent', capabilityKey: 'fix_bug_l2', timeoutSeconds: 2400, retryCount: 2, onFailure: 'stop', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
    { name: '创建 MR', stageType: 'llm_agent', capabilityKey: 'create_mr', timeoutSeconds: 300, retryCount: 1, onFailure: 'stop', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
    { name: 'AI Review', stageType: 'llm_agent', capabilityKey: 'ai_review_mr', timeoutSeconds: 600, retryCount: 0, onFailure: 'continue', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
    { name: '通知', stageType: 'llm_agent', capabilityKey: 'notify_bug', timeoutSeconds: 120, retryCount: 2, onFailure: 'stop', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
  ]

  const l3Stages = [
    { name: '方案审批', stageType: 'approval', approverIdsResolver: 'primary_project_owner', approvalDescription: 'L3 Bug 修复方案审批', timeoutSeconds: 3600, retryCount: 0, onFailure: 'stop', targetRoles: [], parallel: false },
    { name: 'L3 修复', stageType: 'llm_agent', capabilityKey: 'fix_bug_l3', timeoutSeconds: 2400, retryCount: 2, onFailure: 'stop', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
    { name: '创建 MR', stageType: 'llm_agent', capabilityKey: 'create_mr', timeoutSeconds: 300, retryCount: 1, onFailure: 'stop', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
    { name: 'AI Review', stageType: 'llm_agent', capabilityKey: 'ai_review_mr', timeoutSeconds: 600, retryCount: 0, onFailure: 'continue', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
    { name: '通知', stageType: 'llm_agent', capabilityKey: 'notify_bug', timeoutSeconds: 120, retryCount: 2, onFailure: 'stop', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
  ]

  const l4Stages = [
    { name: '通知', stageType: 'llm_agent', capabilityKey: 'notify_bug', timeoutSeconds: 120, retryCount: 2, onFailure: 'stop', targetRoles: [], parallel: false, capabilityParams: { reportId: '{{triggerParams.reportId}}' } },
  ]

  const pipes = [
    { name: 'L1-配置类', stages: l1Stages },
    { name: 'L2-代码缺陷', stages: l2Stages },
    { name: 'L3-业务逻辑', stages: l3Stages },
    { name: 'L4-复杂问题', stages: l4Stages },
  ]
  for (const p of pipes) {
    await pool.query(
      `INSERT INTO test_pipelines (product_line_id, name, description, stages, enabled)
       VALUES ($1, $2, '', $3::jsonb, true)
       ON CONFLICT DO NOTHING`,
      [productLineId, p.name, JSON.stringify(p.stages)],
    )
  }
}

/** 一次性 seed：产品线 + 代码仓库 + capabilities + Pipelines + 单 project。 */
export interface BaseSeedResult {
  productLineId: number
}

export async function baseSeed(opts?: { productLineName?: string }): Promise<BaseSeedResult> {
  const productLineId = await seedProductLine(opts?.productLineName ?? 'pam')
  await seedKnowledgeRepo(productLineId)
  await seedAnalyzeBugCapability()
  await seedFixBugCapabilities()
  await seedPipelines(productLineId)
  return { productLineId }
}
