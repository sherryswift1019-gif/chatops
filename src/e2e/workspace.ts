// src/e2e/workspace.ts
//
// E2E 沙盒工作目录管理：把 target 项目 clone 到容器内可见的持久目录，
// 让 pipeline-a / pipeline-b 各节点共享。host 上挂 /srv/chatops/test-runs，
// 容器内可见 /data/chatops/test-runs（deploy.sh:146 已配 volume）。
//
// 函数原本在 src/e2e/pipeline-a/nodes/baseline-sandbox.ts 内，pipeline-b
// 之前没用同套机制（init-run cold-start 直接在 '.' 跑 git fetch，容器
// 内 /app 不是 git checkout，必失败）。本文件抽出来给两边复用。
import { execSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { resolveGitlabConfig } from '../config/gitlab.js'
import { extractGitlabPath } from '../db/repositories/e2e-target-projects.js'

export interface WorkspacePaths {
  /** 容器内可见的 workspace 路径（pipeline-b 节点 cwd 用这个） */
  containerPath: string
  /** host 上的实际路径（runDockerScript 挂卷给 DooD 内子容器用） */
  hostPath: string
}

export function getWorkspacePaths(targetProjectId: string): WorkspacePaths {
  const testDataDir = process.env.TEST_DATA_DIR ?? '/data/chatops/test-runs'
  const hostTestDataDir = process.env.HOST_TEST_DATA_DIR ?? '/srv/chatops/test-runs'
  return {
    containerPath: join(testDataDir, 'workspaces', targetProjectId),
    hostPath: join(hostTestDataDir, 'workspaces', targetProjectId),
  }
}

/**
 * 把 target 项目（gitlabRepo）clone / fetch 到 workspace。已存在的目录走
 * fetch + reset --hard 保证干净 + 跟远端 branch 同步。
 *
 * 通过 GitLab token 注入 oauth2 URL 跳过交互认证。失败时抛错。
 */
export async function ensureWorkspaceCloned(
  project: { id: string; gitlabRepo: string; defaultBranch: string },
  branch: string,
): Promise<void> {
  const { containerPath } = getWorkspacePaths(project.id)
  const cfg = await resolveGitlabConfig()
  if (!cfg.url || !cfg.token) throw new Error('GitLab config missing (url or token)')

  const repoPath = extractGitlabPath(project.gitlabRepo)
  const base = new URL(cfg.url.replace(/\/$/, ''))
  const authUrl = `${base.protocol}//oauth2:${cfg.token}@${base.host}/${repoPath}.git`

  if (!existsSync(containerPath)) {
    mkdirSync(dirname(containerPath), { recursive: true })
    execSync(`git clone --branch ${branch} --depth 1 ${authUrl} ${containerPath}`, {
      stdio: 'pipe',
      timeout: 120_000,
    })
  } else {
    execSync(
      `git -C ${containerPath} fetch origin ${branch} && git -C ${containerPath} reset --hard origin/${branch}`,
      { stdio: 'pipe', timeout: 60_000 },
    )
  }
}
