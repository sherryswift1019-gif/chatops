// src/e2e/pipeline-a/nodes/commit-pr.ts
import { spawnSync } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { updateE2eSpecStatus } from '../../../db/repositories/e2e-specs.js'
import type { PipelineAStateType } from '../types.js'

function git(args: string[], env: Record<string, string> = {}): { status: number; stdout: string } {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '' }
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

  // 创建目录并写文件
  mkdirSync(dirname(spec.scriptPath), { recursive: true })
  writeFileSync(spec.scriptPath, spec.generatedContent, 'utf8')

  // git checkout -b 创建分支
  const branchName = `e2e-gen/${spec.specId}-${Date.now()}`
  const checkoutResult = git(['checkout', '-b', branchName])
  if (checkoutResult.status !== 0) {
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // git add
  const addResult = git(['add', spec.scriptPath])
  if (addResult.status !== 0) {
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // git commit
  const commitResult = git(['commit', '-m', `feat(e2e): 自动生成测试脚本 — ${spec.title}`])
  if (commitResult.status !== 0) {
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // git push
  const pushResult = git(['push', 'origin', branchName])
  if (pushResult.status !== 0) {
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
      env: {
        ...process.env,
        GITLAB_TOKEN: token ?? '',
        GITLAB_HOST: gitlabUrl ?? '',
      },
    },
  )

  if (mrResult.status !== 0) {
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
    currentSpecIndex: state.currentSpecIndex + 1,
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

    const checkResult = spawnSync('glab', ['mr', 'view', iid, '--output=json'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        GITLAB_TOKEN: token,
        GITLAB_HOST: gitlabUrl,
      },
    })

    if (checkResult.status === 0) {
      try {
        const mr = JSON.parse(checkResult.stdout ?? '{}')
        if (mr.detailed_merge_status === 'mergeable' || mr.pipeline?.status === 'success') {
          ciPassed = true
          break
        }
        if (mr.pipeline?.status === 'failed') {
          console.warn(`[PipelineA:autoMerge] CI failed for MR ${iid}`)
          break
        }
      } catch (e) {
        console.warn(`[PipelineA:autoMerge] failed to parse MR view result`, e)
        continue
      }
    }
  }

  if (!ciPassed) {
    console.warn(`[PipelineA:autoMerge] CI timed out for MR ${iid}`)
    return
  }

  // CI passed, merge the MR
  const mergeResult = spawnSync('glab', ['mr', 'merge', iid, '--yes', '--squash'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      GITLAB_TOKEN: token,
      GITLAB_HOST: gitlabUrl,
    },
  })

  if (mergeResult.status === 0) {
    await updateE2eSpecStatus(specId, 'committed')
    console.log(`[PipelineA:autoMerge] successfully merged MR ${iid} for spec ${specId}`)
  } else {
    console.warn(`[PipelineA:autoMerge] failed to merge MR ${iid}: ${mergeResult.stderr}`)
  }
}
