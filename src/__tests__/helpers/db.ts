import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 测试库 marker 表名（防误连生产/开发库的唯一硬防线）。
 * resetTestDb 在 DROP SCHEMA 前校验此表存在，否则立即中止；
 * 重建 schema 之后再把此表种回去（因为 DROP SCHEMA CASCADE 会把它一起删）。
 */
export const TEST_DB_MARKER_TABLE = 'chatops_test_db_marker'

/**
 * 断言 DATABASE_URL 在测试环境下已设置（仅非空校验）。
 * 不抛的场景：NODE_ENV 非 test（跳过，不干扰生产/开发环境的调用）。
 * 抛的场景：NODE_ENV=test 且 DATABASE_URL 未设置。
 *
 * 注：URL 名字约定（含 _test 或白名单）已移除，唯一防线是 resetTestDb 内部的
 * marker 表 `chatops_test_db_marker`——生产/开发库绝无此表，DROP SCHEMA 前会
 * 校验，缺失立即中止。放宽 URL 校验是为了让 GitLab CI 直接用 `.../chatops`
 * 跑测试（CI 容器里 postgres service 默认 db 名就叫 chatops）。
 */
export function assertDatabaseUrlForTests(
  databaseUrl: string | undefined,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv !== 'test') return
  if (!databaseUrl) {
    throw new Error(
      `[test setup] DATABASE_URL 未设置。` +
      ` 测试运行时必须显式传 DATABASE_URL（resetTestDb 会再校验 marker 表 ${TEST_DB_MARKER_TABLE} 防止误连开发/生产库）。`,
    )
  }
}

// Vitest setup file: ensures tool modules that transitively load src/config.ts
// can be imported in unit tests without a real DATABASE_URL in the environment.
// Integration tests that actually talk to Postgres must set their own URL.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/chatops_test'
}

// 总门：测试环境下 DATABASE_URL 必须已设置（仅非空校验，名字约定已移除）
// 真正的测试库/生产库判别交给 resetTestDb 里的 marker 表校验
assertDatabaseUrlForTests(
  process.env.DATABASE_URL,
  process.env.NODE_ENV,
)

// Pipeline executor resolves TEST_DATA_DIR at module-load time; must be set
// before any pipeline import, which happens before any beforeAll().
if (!process.env.TEST_DATA_DIR) {
  process.env.TEST_DATA_DIR = '/tmp/chatops-test-runs'
}

let testPool: Pool | null = null

export function getTestPool(): Pool {
  if (!testPool) {
    testPool = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return testPool
}

interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

/**
 * 三叉防御：
 * 1. NODE_ENV 必须为 'test'（vitest 自动设置）——拦非测试进程的意外调用
 * 2. 有 marker 表 → 通过（本地开发者已 bootstrap 过的测试库）
 * 3. 无 marker 表 + public schema 完全空 → 视为全新测试库，自动 bootstrap marker 后通过
 *    （GitLab CI 里 postgres service 刚启动时 public 就是空的；开发库/生产库不可能空）
 * 4. 无 marker 表 + public schema 有业务表 → throw（典型开发库/生产库，硬防线）
 *
 * 抛出错误时必须包含 bootstrap 指南（CREATE TABLE + INSERT），让用户知道如何合法初始化测试 DB。
 */
export async function assertTestDbSafeToReset(
  pool: QueryablePool,
  nodeEnv: string | undefined,
  databaseUrl: string | undefined,
): Promise<void> {
  if (nodeEnv !== 'test') {
    throw new Error(
      `resetTestDb() 拒绝执行：NODE_ENV=${nodeEnv}，必须为 'test'。` +
      ` 正常跑测试时 vitest 会自动设 NODE_ENV=test。如果你在写脚本绕过了该机制，请检查调用链。`,
    )
  }

  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=$1`,
    [TEST_DB_MARKER_TABLE],
  )
  if (rows.length > 0) return

  // marker 缺失——判断是否为"全新空库"场景：public schema 一个表都没有就视为 CI 的全新 postgres 容器
  // 开发库/生产库必有业务表（capabilities / projects / users ...），不会误判
  const { rows: tableRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname='public'`,
  )
  const tableCount = Number((tableRows[0] as { n?: number })?.n ?? 0)
  if (tableCount === 0) {
    // 全新空库 → 自动 bootstrap marker，后续 resetTestDb 的 DROP SCHEMA CASCADE 会再把它一起删
    // 再次重建 schema 时 resetTestDb 会把 marker 重新种回来（末尾 CREATE + INSERT）
    await pool.query(`CREATE TABLE ${TEST_DB_MARKER_TABLE} (id INT PRIMARY KEY)`)
    await pool.query(`INSERT INTO ${TEST_DB_MARKER_TABLE} (id) VALUES (1)`)
    console.log(
      `[test] 空库自动 bootstrap marker 表 ${TEST_DB_MARKER_TABLE} (${databaseUrl})`,
    )
    return
  }

  throw new Error(
    `resetTestDb() 拒绝执行：当前 DB (${databaseUrl}) 缺少 marker 表 "${TEST_DB_MARKER_TABLE}"，` +
    `不能确认是测试库（public schema 有 ${tableCount} 个业务表，不像全新空库）。\n\nBootstrap 说明（只需做一次，确认当前连接的库确实是专用测试库后）：\n` +
    `  psql "${databaseUrl}" -c "CREATE TABLE ${TEST_DB_MARKER_TABLE} (id INT PRIMARY KEY); INSERT INTO ${TEST_DB_MARKER_TABLE} (id) VALUES (1);"`,
  )
}

const SCHEMA_FILES = [
  'schema.sql',
  'schema-v2.sql',
  'schema-v3.sql',
  'schema-v4.sql',
  'schema-v5.sql',
  'schema-v6.sql',
  'schema-v7.sql',
  'schema-v8.sql',
  'schema-v9.sql',
  'schema-v10.sql',
  'schema-v11.sql',
  'schema-v12.sql',
  'schema-v13.sql',
  'schema-v14.sql',
  'schema-v15.sql',
  'schema-v16.sql',
  'schema-v17.sql',
  'schema-v18.sql',
  'schema-v19.sql',
  'schema-v20.sql',
  // 注意：不要补齐 v21-v28。团队 schema 文件设计上 DDL 和 seed 数据
  // 混在同一文件（如 v25 塞入 pam 产线 + pas project + L1-L4 pipeline 模板），
  // 跑完会污染"空产线 / 0 project"的测试预期（analyzer.test.ts /
  // bug-analysis-reports-repo.test.ts 等）。resetTestDb 的前提是纯 DDL，
  // 混用 seed 会打穿这个假设。v21+ 新建的表（prd_submit_events / arch_*）
  // 目前没有单元测试依赖；globalSetup 的 pg-container.ts 会扫全部文件
  // 支持首次 bootstrap，业务代码运行时 migrate.ts 也会跑全套。
  //
  // v27 (pipeline_node_types): 全新表 + 非污染 catalog seed（5 行节点类型
  // 定义），所有依赖此表的测试都期望这 5 行存在；不加会让 v34/v35/v36/v44
  // 引用此表时炸"relation does not exist"。原本占 v30，merge main 时让到
  // v27 占用历史 squash 空号。
  'schema-v27.sql',
  // 后续 v3X 例外：全新表 + 非污染 catalog seed 才能加进 SCHEMA_FILES。
  'schema-v30.sql',
  // v31 (capabilities 4 字段): 纯 ALTER TABLE ADD + 对已有行的 UPDATE backfill。
  // 不引入新 capability 行,不影响其它 fixture。所有依赖 capabilities 表
  // 4 字段的测试都期望 deploy/rollback/restart 有 deploy lock,
  // analyze_bug + fix_bug_l1/l2/l3 有 worktree,其余 capability neither。
  'schema-v31.sql',
  // v32 (im_triggers + product_line_im_triggers + approval_rules 改名):
  // 新表 + ALTER + 数据迁移。所有依赖 IM 触发器的测试期望 im_triggers 至少有
  // 入口类 capability 行数 (~5+)。同 v31 forward policy。
  'schema-v32.sql',
  // v33 (capabilities cleanup): DROP 5 个 legacy 字段, 纯 ALTER, 无新行无新表。
  // 测试期望 capabilities 表只剩 LLM agent 核心字段 (phase 2 cleanup 完成后)。
  'schema-v33.sql',
  // v34 (pipeline_node_types 7 新行): 纯 INSERT, ON CONFLICT DO NOTHING, 不影响其它 fixture。
  // 默认 enabled=FALSE; phase 3 后续 task 启用各类型时通过 schema-v3X 或 admin SQL UPDATE。
  'schema-v34.sql',
  // v35 (T9-T14 enable 6 new simple node types): 纯 UPDATE pipeline_node_types
  // SET enabled=TRUE。每个 executor commit 后追加一行 UPDATE 并 bump 末尾断言。
  // T15 fan_out 推迟,本文件最终 6 行 enabled = 11(5 phase-0 + 6 simple)。
  'schema-v35.sql',
  // v36 (T17 capability → llm_agent rename): pipeline_node_types row 改名
  // + test_pipelines.graph / .stages JSONB 节点 stageType 改名。
  // 测试 fixture 里若仍用 'capability' 字面量需要 phase 3 后续清理 —— 但 SQL 迁移
  // 是幂等 + WHERE EXISTS 守门,空表上是 no-op。
  'schema-v36.sql',
  // v37 (phase 4 — internal_capability_pipelines + L1 handover seed):
  // CREATE TABLE internal_capability_pipelines + 在 product_lines 非空时种入
  // 'handover-internal' pipeline 并注册映射。空 product_lines 时 seed 自动 skip,
  // 不产生 fixture 污染。需要映射的测试自行 bootstrap product_line + 重跑 v37
  // (见 internal-capability-pipelines-repo.test.ts)。
  'schema-v37.sql',
  // v38/v39: 纯 FK 行为修正，无 seed 污染。保持 resetTestDb 与当前迁移链一致：
  // - v38: im_triggers.pipeline_id ON DELETE SET NULL
  // - v39: internal_capability_pipelines.pipeline_id ON DELETE CASCADE
  'schema-v38.sql',
  'schema-v39.sql',
  // v40 (phase 4 T3 — notify_bug pipeline 迁移): CREATE FUNCTION build_notify_message
  // (PL/pgSQL, 4 种 scenario 文案拼接) + 在 product_lines 非空时种入 'notify-internal'
  // pipeline (4 节点 DAG: sql_query → fan_out → db_update × 2) 并注册 'notify_bug'
  // 映射。空 product_lines 时 seed 自动 skip。同 v37 forward policy。
  'schema-v40.sql',
  // v41 (phase 4 T4 — create_mr pipeline 迁移): CREATE FUNCTION build_mr_description
  // / build_mr_title (PL/pgSQL) + 在 product_lines 非空时种入 'create-mr-internal'
  // pipeline (4 节点 DAG: sql_query → fan_out → db_update × 2) 并注册 'create_mr'
  // 映射。空 product_lines 时 seed 自动 skip。同 v37/v40 forward policy。
  'schema-v41.sql',
  // v42: pipeline 解绑产线，新建 pipeline_bindings 关联表 + 老数据迁移 + 删 schedule。
  'schema-v42.sql',
  // v43: im_triggers 增加 capability_key 目标 + pipeline/capability 互斥约束。
  'schema-v43.sql',
  // v44: switch 节点类型 + llm_agent outputFormat backfill + edge expression 语法归一化。
  'schema-v44.sql',
  // v45: 纯 DDL（pipeline_dryrun_snapshots + test_runs.trigger_params），无 seed 数据，安全加入。
  'schema-v45.sql',
  // v46: 纯 DDL（capability_invocations 新表），无 seed 数据，安全加入。
  'schema-v46.sql',
  // v47: pipeline_webhooks 表，纯 DDL，无 seed 数据，安全加入。
  'schema-v47.sql',
  // v48: capabilities 新增业务分类字段，纯 ALTER，无 seed 数据，安全加入。
  'schema-v48.sql',
  // v49: capabilities 业务分类自动预填，纯 UPDATE，安全加入。
  'schema-v49.sql',
  // v50: test_pipelines 新增 container_image 列，纯 ALTER，无 seed 数据，安全加入。
  'schema-v50.sql',
  // v51: diagnose_and_repair capability，纯 INSERT catalog，安全加入测试库。
  'schema-v51.sql',
  // v53: test_pipelines 新增 param_schema/im_prompt 列 + pipeline_schedules 纯 DDL，安全加入。
  'schema-v53.sql',
  // v54: 删除 im_input 节点类型，DELETE 幂等，安全加入。
  'schema-v54.sql',
  // v55: dingtalk_users 新增 resigned_at 列，纯 ALTER，无 seed 数据，安全加入。
  'schema-v55.sql',
  // v56: PAM Proxy 部署流水线移除 im_input 节点，填充 param_schema/im_prompt。
  // DO $$ 块幂等，无 product_lines 时自动跳过，安全加入。
  'schema-v56.sql',
  // v57: im_triggers 新增 category 列，纯 ALTER，无 seed 数据，安全加入。
  'schema-v57.sql',
  // v58: capability_invocations status CHECK 加 not_executed，纯约束变更，安全加入。
  'schema-v58.sql',
  // v59: 给 diagnose_and_repair capability 补 run_remote_command 工具，纯 UPDATE catalog，安全加入。
  'schema-v59.sql',
  // v60: quick-impl pipeline 新增 requirements / requirement_approval_waiters 两表 +
  // test_pipelines.is_system 列 + pipeline_node_types CHECK 扩展 + 4 个新 quick_impl 节点类型。
  // 全新表 + 纯 ALTER + ON CONFLICT 幂等 INSERT，安全加入。
  'schema-v60.sql',
  // v61: init_qi_branch and e2e_stub node types for Quick-Impl Phase 1
  'schema-v61.sql',
  // v62: qi_e2e_runner / im_input node types for Quick-Impl Phase 2 (real E2E + IM intervention)
  'schema-v62.sql',
  // v63: requirement_approval_waiters 加 target_task_id / cited_ai_notes（PRD §7 step 6 字段级反馈）
  'schema-v63.sql',
  // v64: requirements.skip_e2e — 触发时勾选「跳过 E2E」
  'schema-v64.sql',
  'schema-v1000.sql',
  // v1001: e2e_runs status 加 awaiting_human_review；evidence_manifest 容量 32K→64K。
  'schema-v1001.sql',
  // v1002: 修复 v1000 早期提交 INSERT 列错位导致 invoke_target_script.enabled=FALSE。
  'schema-v1002.sql',
  // v1003: e2e_playbook_drafts 表 — Modal 内"输入场景 → AI 生成 → 人审"调试入口
  'schema-v1003.sql',
  // v1004: e2e_playbook_drafts 新增 mr_url / committed_path 列，纯 ALTER，安全加入。
  'schema-v1004.sql',
  // v1005: 取消首次登录强制改密（e2e 沙盒需要 admin/admin 直登），纯 UPDATE，安全加入。
  'schema-v1005.sql',
  // v1006: 注册 'end' 节点类型（Pipeline Stage Types Sub-plan A Task 1）。
  // 纯 ON CONFLICT INSERT/UPDATE pipeline_node_types，无 seed 污染，安全加入。
  'schema-v1006.sql',
  // v1007: 注册 'cleanup' 节点类型（Pipeline Stage Types Sub-plan A Task 2）。
  // 纯 ON CONFLICT INSERT/UPDATE pipeline_node_types，无 seed 污染，安全加入。
  'schema-v1007.sql',
  // v1008: 注册 'git_commit_push' 节点类型（Pipeline Stage Types Sub-plan A Task 3）。
  // 纯 ON CONFLICT INSERT/UPDATE pipeline_node_types，无 seed 污染，安全加入。
  'schema-v1008.sql',
  // v1009: 注册 'llm_author' 节点类型（Pipeline Stage Types Sub-plan A Task 4）。
  // 纯 ON CONFLICT INSERT/UPDATE pipeline_node_types，无 seed 污染，安全加入。
  'schema-v1009.sql',
  // v1010: 注册 'llm_review' 节点类型（Pipeline Stage Types Sub-plan A Task 5）。
  // 纯 ON CONFLICT INSERT/UPDATE pipeline_node_types，无 seed 污染，安全加入。
  'schema-v1010.sql',
  // v1011: 注册 'human_gate' 节点类型（Pipeline Stage Types Sub-plan A Task 6）。
  // 纯 ON CONFLICT INSERT/UPDATE pipeline_node_types，无 seed 污染，安全加入。
  'schema-v1011.sql',
  // v1012: Phase 3 product-reviewer config keys（Plan Stage Upgrade Phase 3 Task 16）。
  // 纯 ON CONFLICT INSERT system_config，无 seed 污染，安全加入。
  'schema-v1012.sql',
  // v1013: pipeline_run_state 表 — 累计 token 用量，供 budget gate 查询。
  // 纯 DDL（CREATE TABLE IF NOT EXISTS + INDEX），无 seed 数据，安全加入。
  'schema-v1013.sql',
  // v1014: 注册 llm_brainstorm 节点类型（spec_brainstorm 节点，T19 spec stage upgrade）。
  // 纯 ON CONFLICT INSERT/UPDATE pipeline_node_types，无 seed 污染，安全加入。
  'schema-v1014.sql',
  // v1015: retry_counters JSONB COMMENT documentation (ai_review_rounds + last_ai_review_notes)。
  // 纯 COMMENT ON COLUMN，无 DDL/DML 副作用，无 seed 污染，安全加入。
  'schema-v1015.sql',
  // v1016: brainstorm_waiters 表 — multi-round LLM brainstorm 持久化。
  // 纯 DDL（CREATE TABLE IF NOT EXISTS + INDEX），无 seed 数据，安全加入。
  'schema-v1016.sql',
]

export async function resetTestDb(): Promise<void> {
  const pool = getTestPool()
  await assertTestDbSafeToReset(pool, process.env.NODE_ENV, process.env.DATABASE_URL)
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  for (const file of SCHEMA_FILES) {
    const sql = readFileSync(join(process.cwd(), 'src/db', file), 'utf8')
    await pool.query(sql)
  }
  // DROP SCHEMA CASCADE 把 marker 一并删了，重建 schema 后补回来供下次校验
  await pool.query(`CREATE TABLE ${TEST_DB_MARKER_TABLE} (id INT PRIMARY KEY)`)
  await pool.query(`INSERT INTO ${TEST_DB_MARKER_TABLE} (id) VALUES (1)`)
}
