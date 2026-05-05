// src/scripts/poc-run-scenario.ts
//
// 端到端 PoC：起真 chatops 沙盒 → 跑一条最简 playbook → 看 manifest 输出。
// 验证目标：host Claude → Playwright MCP → docker exec → 写 manifest 这条链路通。
//
// 必需 env：
//   POC_TARGET_PROJECT_ID  e2e_target_projects 表里的 id（如 'chatops'）
//   DATABASE_URL           常规 chatops 连接（src/config.ts 校验）
// 可选 env：
//   POC_BASE_BRANCH        默认 'main'
//   POC_SCENARIO_ID        默认 'poc.smoke'
//   POC_SKIP_BUILD         '1' 跳过 build 步（已有镜像时省 10min）
//   POC_TEARDOWN_ON_EXIT   '0' 跳过 teardown，留沙盒 + evidence 调试
//
// 跑：
//   POC_TARGET_PROJECT_ID=chatops pnpm exec tsx src/scripts/poc-run-scenario.ts
//
// 预计耗时：build ~10min + deploy ~30s + scenario ~5min + teardown ~30s。
// 不跑 build 时 ~7min。
import 'dotenv/config'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { runScript } from '../e2e/pipeline-b/run-script.js'
import { getE2eTargetProject } from '../db/repositories/e2e-target-projects.js'
import { runE2eScenario } from '../agent/e2e-scenario/runner.js'
import type { Playbook } from '../e2e/pipeline-b/playbook/types.js'
import type { SandboxHandle } from '../e2e/pipeline-b/types.js'

function mustEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[PoC] env ${name} required`)
    process.exit(2)
  }
  return v
}

// PoC scenario 故意做得保守，不依赖业务路由——只验链路：
//   - 用 Playwright 打开 web_base_url（任何 chatops 沙盒都暴露）
//   - 断言 body 元素存在（任何非空白页都成立）
//   - 断言 web_base_url 返回非 5xx（curl 可达）
const POC_PLAYBOOK: Playbook = {
  specPath: 'docs/test-specs/poc-smoke.md',
  specTitle: 'PoC 链路烟测（不验业务）',
  scenarios: [
    {
      id: 'poc.smoke',
      name: 'host Claude → Playwright MCP → docker exec → manifest 链路验证',
      tags: ['poc', 'smoke'],
      setup: {
        hints: ['沙盒已部署完成，所有 endpoints 在 sandboxHandle 里给出'],
      },
      steps: [
        '用 mcp__playwright__browser_navigate 打开 endpoints.web_base_url',
        '用 mcp__playwright__browser_snapshot 拿到页面 accessibility tree',
        '用 docker exec <containerId> 跑 ps -ef | head 验证容器在跑（写到 evidence/container-ps.txt）',
      ],
      acceptance: [
        { kind: 'dom_visible', selector: 'body', timeout_ms: 10_000 },
        { kind: 'api_response', request: 'GET /', expect_status: 200 },
      ],
      on_fail_hints: [
        '若 navigate 超时，检查 web_base_url 是否从 host 可达（沙盒可能只暴露在 docker network）',
      ],
    },
  ],
}

async function main(): Promise<void> {
  const targetProjectId = mustEnv('POC_TARGET_PROJECT_ID')
  const baseBranch = process.env.POC_BASE_BRANCH ?? 'main'
  const scenarioId = process.env.POC_SCENARIO_ID ?? 'poc.smoke'
  const skipBuild = process.env.POC_SKIP_BUILD === '1'
  const teardownOnExit = process.env.POC_TEARDOWN_ON_EXIT !== '0'

  console.log(`[PoC] targetProjectId=${targetProjectId} branch=${baseBranch} scenario=${scenarioId}`)
  console.log(`[PoC] skipBuild=${skipBuild} teardownOnExit=${teardownOnExit}`)

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) {
    console.error(`[PoC] e2e_target_projects "${targetProjectId}" not found`)
    process.exit(2)
  }

  // 用绝对路径避免 spawn 把 'deploy.sh' 当成 PATH 命令查（workDir 可能是 '.'）。
  const workDir = resolve(project.workingDir ?? '.')
  const deployScript = resolve(workDir, project.scripts.deploy)
  const buildScript = resolve(workDir, project.scripts.build)

  // ---- step 1: provision ----
  const handleDir = mkdtempSync(join(tmpdir(), 'poc-handle-'))
  const handleFile = join(handleDir, 'handle.json')

  console.log('[PoC] provision...')
  const provision = await runScript(
    deployScript,
    ['provision', `--branch=${baseBranch}`, `--out-handle=${handleFile}`],
    { timeout: 600_000, cwd: workDir },
  )
  if (provision.exitCode !== 0) {
    console.error(`[PoC] provision failed (exit ${provision.exitCode}): ${provision.stderr.slice(0, 500)}`)
    process.exit(1)
  }

  // ---- step 2: build (optional) ----
  if (!skipBuild) {
    console.log('[PoC] build...')
    const buildResult = await runScript(buildScript, [], {
      timeout: 900_000,
      cwd: workDir,
      env: {
        IMAGE_NAME: `chatops-poc-${Date.now()}`,
        IMAGE_TAG: 'poc',
      },
    })
    if (buildResult.exitCode !== 0) {
      console.error(`[PoC] build failed (exit ${buildResult.exitCode}): ${buildResult.stderr.slice(0, 500)}`)
      process.exit(1)
    }
  } else {
    console.log('[PoC] skip build (POC_SKIP_BUILD=1)')
  }

  // ---- step 3: deploy ----
  console.log('[PoC] deploy...')
  const deploy = await runScript(deployScript, ['deploy', `--handle=${handleFile}`], {
    timeout: 300_000,
    cwd: workDir,
  })
  if (deploy.exitCode !== 0) {
    console.error(`[PoC] deploy failed (exit ${deploy.exitCode}): ${deploy.stderr.slice(0, 500)}`)
    process.exit(1)
  }

  const handleJson = JSON.parse(readFileSync(handleFile, 'utf8')) as Record<string, unknown>
  console.log('[PoC] handle:', JSON.stringify(handleJson, null, 2))

  // chatops 的 deploy.sh:135 在 deploy 子命令里把容器命名为 chatops-e2e-{apiPort}，
  // 但 provision 写出的 handle JSON 不带 containerId / workdir。这里 driver 自己派生，
  // 让 scenario runner 能用 docker exec。
  const internalRefs = (handleJson.internalRefs as Record<string, unknown>) ?? {}
  const apiPort = internalRefs.apiPort
  const derivedContainerId =
    typeof handleJson.containerId === 'string'
      ? handleJson.containerId
      : typeof apiPort === 'number'
        ? `chatops-e2e-${apiPort}`
        : undefined

  // chatops 沙盒只暴露 endpoints.api（前端 SPA + /admin API 同 server），
  // SKILL.md 默认从 endpoints.web_base_url 起 Playwright，这里别名一下。
  const rawEndpoints = (handleJson.endpoints as Record<string, string>) ?? {}
  const endpoints: Record<string, string> = { ...rawEndpoints }
  if (!endpoints.web_base_url && endpoints.api) {
    endpoints.web_base_url = endpoints.api
  }

  if (!derivedContainerId) {
    console.warn('[PoC] WARN: 无法派生 containerId — Claude docker exec 类操作会失败')
  }

  const sandboxHandle: SandboxHandle = {
    envId: handleJson.envId as string,
    kind: (handleJson.kind as string) ?? 'docker-compose-local',
    endpoints,
    internalRefs,
    containerId: derivedContainerId,
    workdir: (handleJson.workdir as string | undefined) ?? '/app',
  }

  // ---- step 4: 准备 evidenceDir ----
  const evidenceDir = mkdtempSync(join(tmpdir(), 'poc-evidence-'))
  console.log(`[PoC] evidenceDir = ${evidenceDir}`)

  // ---- step 5: 跑 scenario ----
  console.log('[PoC] running scenario via Claude...')
  const t0 = Date.now()
  const result = await runE2eScenario({
    playbook: POC_PLAYBOOK,
    scenarioId,
    evidenceDir,
    sandboxHandle,
    attemptNumber: 1,
  })
  const elapsedMs = Date.now() - t0
  console.log(`[PoC] runE2eScenario done (${(elapsedMs / 1000).toFixed(1)}s)`)

  console.log('==== rawOutput (last 2000 chars) ====')
  console.log(result.rawOutput.slice(-2000))
  console.log('==== manifest ====')
  console.log(result.manifest ? JSON.stringify(result.manifest, null, 2) : '(null)')
  console.log('==== errorMessage ====')
  console.log(result.errorMessage ?? '(null)')
  console.log(`[PoC] evidenceDir 留在: ${evidenceDir}`)

  // ---- step 6: teardown ----
  if (teardownOnExit) {
    console.log('[PoC] teardown...')
    const teardownHandleFile = join(handleDir, 'teardown.json')
    writeFileSync(teardownHandleFile, JSON.stringify(handleJson))
    const teardown = await runScript(
      deployScript,
      ['teardown', `--handle=${teardownHandleFile}`],
      { timeout: 300_000, cwd: workDir },
    )
    if (teardown.exitCode !== 0) {
      console.warn(`[PoC] teardown 返回 ${teardown.exitCode}: ${teardown.stderr.slice(0, 300)}`)
    }
  } else {
    console.log('[PoC] skip teardown (POC_TEARDOWN_ON_EXIT=0)')
  }

  process.exit(result.errorMessage ? 1 : 0)
}

main().catch((err) => {
  console.error('[PoC] fatal:', err)
  process.exit(2)
})
