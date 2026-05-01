// src/e2e/pipeline-a/nodes/commit-pr.ts
import { spawnSync, execFile } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { promisify } from 'util'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { updateE2eSpecStatus } from '../../../db/repositories/e2e-specs.js'
import { getWorkspacePaths } from './baseline-sandbox.js'
import type { PipelineAStateType } from '../types.js'

const execFileAsync = promisify(execFile)

function git(args: string[], cwd: string, env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 60_000,
    cwd,
    env: { ...process.env, ...env },
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export async function commitAndPrNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const spec = state.specs[state.currentSpecIndex]
  if (!spec) {
    return {}
  }

  if (!spec.scriptPath || !spec.generatedContent) {
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  const { url: gitlabUrl, token } = await resolveGitlabConfig()
  const { containerPath } = getWorkspacePaths(spec.targetProjectId)

  // 写测试文件到 workspace（target project 克隆目录）
  const testFilePath = join(containerPath, spec.scriptPath)
  mkdirSync(dirname(testFilePath), { recursive: true })
  writeFileSync(testFilePath, spec.generatedContent, 'utf8')

  // git checkout -b 创建分支
  const branchName = `e2e-gen/${spec.specId}-${Date.now()}`
  const checkoutResult = git(['checkout', '-b', branchName], containerPath)
  if (checkoutResult.status !== 0) {
    console.error(`[PipelineA:commitPr] checkout failed: ${checkoutResult.stderr}`)
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // git add
  const addResult = git(['add', spec.scriptPath], containerPath)
  if (addResult.status !== 0) {
    console.error(`[PipelineA:commitPr] add failed: ${addResult.stderr}`)
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // git commit
  const commitResult = git(['commit', '-m', `feat(e2e): 自动生成测试脚本 — ${spec.title}`], containerPath)
  if (commitResult.status !== 0) {
    console.error(`[PipelineA:commitPr] commit failed: ${commitResult.stderr}`)
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // git push
  const pushResult = git(['push', 'origin', branchName], containerPath)
  if (pushResult.status !== 0) {
    console.error(`[PipelineA:commitPr] push failed: ${pushResult.stderr}`)
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // glab mr create
  const mrResult = spawnSync(
    'glab',
    [
      'mr',
      'create',
      `--title=feat(e2e): 自动生成测试脚本 — ${spec.title}`,
      `--description=由 Pipeline A 自动生成，已过 baseline self-correct 验证`,
      `--source-branch=${branchName}`,
      `--target-branch=${state.baseBranch}`,
      '--yes',
    ],
    {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: containerPath,
      env: {
        ...process.env,
        GITLAB_TOKEN: token ?? '',
        GITLAB_HOST: gitlabUrl ?? '',
      },
    },
  )

  if (mrResult.status !== 0) {
    console.error(`[PipelineA:commitPr] glab mr create failed: ${mrResult.stderr}`)
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  const prUrl = (mrResult.stdout ?? '').trim().split('\n').pop() ?? ''

  await updateE2eSpecStatus(spec.specId, 'pr_open', {
    generatedPrUrl: prUrl,
    generatedArtifactPath: spec.scriptPath,
    lastGeneratedAt: new Date(),
  })

  // 异步启动 auto merge（不阻塞主流程）
  void autoMergePr(prUrl, spec.specId, token ?? '', gitlabUrl ?? '')

  return {
    completedSpecs: [{ specId: spec.specId, status: 'pr_open', prUrl }],
    baselineAttempts: 0,
    staticCheckAttempts: 0,
    sandboxHandle: null,
  }
}

async function autoMergePr(prUrl: string, specId: bigint, token: string, gitlabUrl: string): Promise<void> {
  const iid = prUrl.split('/').pop()
  if (!iid) {
    console.warn(`[PipelineA:autoMerge] failed to extract MR IID from ${prUrl}`)
    return
  }

  let ciPassed = false
  const maxAttempts = 60 // 30 min with 30s interval
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 30_000))

    try {
      const { stdout } = await execFileAsync('glab', ['mr', 'view', iid, '--output=json'], {
        timeout: 30_000,
        env: {
          ...process.env,
          GITLAB_TOKEN: token,
          GITLAB_HOST: gitlabUrl,
        },
      })

      const mr = JSON.parse(stdout ?? '{}')
      if (mr.detailed_merge_status === 'mergeable' || mr.pipeline?.status === 'success') {
        ciPassed = true
        break
      }
      if (mr.pipeline?.status === 'failed') {
        console.warn(`[PipelineA:autoMerge] CI failed for MR ${iid}`)
        break
      }
    } catch (e) {
      console.warn(`[PipelineA:autoMerge] glab mr view error (attempt ${i+1}):`, e)
    }
  }

  if (!ciPassed) {
    console.warn(`[PipelineA:autoMerge] CI timed out for MR ${iid}`)
    return
  }

  // CI passed, merge the MR
  try {
    await execFileAsync('glab', ['mr', 'merge', iid, '--yes', '--squash'], {
      timeout: 60_000,
      env: {
        ...process.env,
        GITLAB_TOKEN: token,
        GITLAB_HOST: gitlabUrl,
      },
    })
    await updateE2eSpecStatus(specId, 'committed')
    console.log(`[PipelineA:autoMerge] successfully merged MR ${iid} for spec ${specId}`)
  } catch (e) {
    console.warn(`[PipelineA:autoMerge] failed to merge MR ${iid}:`, e)
  }
}
