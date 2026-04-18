import { registerCapabilityHandler, handleFixComplete } from '../coordinator.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { getByProductLineId } from '../../db/repositories/product-knowledge-repos.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { acquire, release } from '../worktree/manager.js'
import { retryWithDowngrade } from './retry-handler.js'
import { createFixBranch, commitChanges, pushBranch, rebaseOnTarget } from './branch-manager.js'
import { updateIssueLabels } from '../../adapters/gitlab/labels.js'
import { runClaudeCli } from '../claude-cli.js'
import { mask } from '../masking/sensitive-info.js'
import axios from 'axios'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import type { RetryContext } from './retry-handler.js'

/** 从 git URL 提取 GitLab 项目路径 */
function extractProjectPath(codeRepoUrl: string): string {
  const url = codeRepoUrl.replace(/\.git$/, '')
  const httpMatch = url.match(/https?:\/\/[^/]+\/(.+)/)
  if (httpMatch) return httpMatch[1]
  const sshMatch = url.match(/[^:]+:(.+)/)
  if (sshMatch) return sshMatch[1]
  return url
}

/** 通过 GitLab API 创建 MR */
async function createMrViaApi(opts: {
  projectPath: string
  sourceBranch: string
  targetBranch: string
  level: string
  issueId: number
  issueTitle: string
}): Promise<{ iid: number; url: string } | null> {
  const gitlabUrl = process.env.GITLAB_URL
  const gitlabToken = process.env.GITLAB_TOKEN
  if (!gitlabUrl || !gitlabToken) {
    console.error('[FixAgent] 缺少 GITLAB_URL 或 GITLAB_TOKEN')
    return null
  }

  try {
    const response = await axios.post(
      `${gitlabUrl}/api/v4/projects/${encodeURIComponent(opts.projectPath)}/merge_requests`,
      {
        title: `fix(${opts.level}): #${opts.issueId} ${opts.issueTitle}`,
        description: `AI 自动修复 Issue #${opts.issueId}\n\n等级: ${opts.level}\n\n> 此 MR 由 AI Agent 自动生成，请 Review 后合并。验证通过后手动关闭 Issue。`,
        source_branch: opts.sourceBranch,
        target_branch: opts.targetBranch,
        labels: `ai-generated,level-${opts.level}`,
        remove_source_branch: false,
      },
      { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000 }
    )

    const mr = response.data
    console.log(`[FixAgent] MR !${mr.iid} 已创建: ${mr.web_url}`)
    return { iid: mr.iid, url: mr.web_url }
  } catch (err) {
    console.error('[FixAgent] 创建 MR 失败:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** 判断 Claude 输出是否表示修复成功 */
function isFixSuccessful(output: string): boolean {
  const successPatterns = ['所有测试通过', '测试通过', 'tests passed', 'all tests pass', 'BUILD SUCCESS']
  const failurePatterns = ['测试失败', '编译失败', 'test failed', 'BUILD FAILURE', 'COMPILATION ERROR']

  const hasSuccess = successPatterns.some(p => output.toLowerCase().includes(p.toLowerCase()))
  const hasFailure = failurePatterns.some(p => output.toLowerCase().includes(p.toLowerCase()))

  if (hasSuccess && hasFailure) {
    const lastSuccessIdx = Math.max(...successPatterns.map(p => output.toLowerCase().lastIndexOf(p.toLowerCase())))
    const lastFailureIdx = Math.max(...failurePatterns.map(p => output.toLowerCase().lastIndexOf(p.toLowerCase())))
    return lastSuccessIdx > lastFailureIdx
  }

  return hasSuccess
}

async function handleFixBug(opts: TriggerOptions, level: string): Promise<TriggerResult> {
  const reportId = opts.extraParams?.reportId as number | undefined
  if (!reportId) {
    return { success: false, error: '缺少 reportId' }
  }

  const report = await getBugAnalysisReportById(reportId)
  if (!report) {
    return { success: false, error: `分析报告 ${reportId} 不存在` }
  }

  const fixAttempt = async (ctx: RetryContext): Promise<TriggerResult> => {
    const knowledgeRepo = await getByProductLineId(report.productLineId)
    if (!knowledgeRepo) return { success: false, error: `产品线 ${report.productLineId} 未配置代码仓库` }

    const projectPath = extractProjectPath(knowledgeRepo.codeRepoUrl)
    const targetBranch = knowledgeRepo.codeDefaultBranch || 'test'

    const capabilityRow = await getCapabilityByKey(`fix_bug_${level}`)
    if (!capabilityRow?.systemPrompt) {
      return { success: false, error: `fix_bug_${level} 未配置 systemPrompt，请在管理后台配置` }
    }

    const worktree = await acquire({
      userId: 'fix-agent',
      product: `pl-${report.productLineId}`,
      version: targetBranch,
      sessionId: `fix-${report.issueId}-${ctx.attempt}`,
      repoUrl: knowledgeRepo.codeRepoUrl,
    })

    try {
      // Step 1: 创建 fix 分支 + 更新 Issue 标签
      const branch = await createFixBranch(worktree.path, report.issueId, ctx.attempt)
      console.log(`[FixAgent] Issue #${report.issueId} attempt ${ctx.attempt}: branch ${branch}, cwd ${worktree.path}`)

      if (ctx.attempt === 1) {
        await updateIssueLabels(projectPath, report.issueId, {
          add: ['fixing'],
          remove: ['graded', 'needs-approval', 'approved'],
        }).catch(() => {})
      }

      // Step 2: Claude 修复代码（直接调 claude CLI）
      const solutionsSummary = report.solutionsJson
        ?.map((s: any) => `- [${s.recommended ? '推荐' : '备选'}] ${s.summary}（风险:${s.risk}, 工作量:${s.effort}）`)
        .join('\n') ?? '无方案'

      const prompt = `${capabilityRow.systemPrompt}

代码仓库路径: ${worktree.path}

修复 Bug Issue #${report.issueId}（尝试 ${ctx.attempt}/3，等级 ${level}）

## 根因分析
${report.rootCauseSummary}

## 修复方案
${solutionsSummary}

## 影响模块
${(report.affectedModules ?? []).join(', ') || '未知'}

请按照推荐方案修复代码。修复后用 Bash 工具运行测试验证。
修复成功请回复"所有测试通过"，失败请说明原因。`

      const rawOutput = await runClaudeCli({
        prompt,
        allowedTools: 'Read,Glob,Grep,Bash,Write,Edit',
        timeoutMs: 20 * 60_000,
        onEvent: (e) => console.log(`[FixAgent] ${e.type}: ${e.message}`),
        signal: opts.signal,
      })

      const output = mask(rawOutput)

      // Step 3: 判断修复结果
      if (!isFixSuccessful(output)) {
        console.log(`[FixAgent] Issue #${report.issueId} attempt ${ctx.attempt}: 修复未成功`)
        return { success: false, output, error: '测试未通过' }
      }

      console.log(`[FixAgent] Issue #${report.issueId} attempt ${ctx.attempt}: 测试通过，开始提交`)

      // Step 4: 提交并推送
      await commitChanges(worktree.path, {
        level,
        issueTitle: (report.rootCauseSummary ?? '').substring(0, 60),
        issueId: report.issueId,
        attempt: ctx.attempt,
        hypothesis: (report.rootCauseSummary ?? '').substring(0, 100),
        changed: '由 AI Agent 自动修复',
        testResult: '通过',
        next: '等待 AI Review',
        confidence: report.confidence ?? 'medium',
      })

      // Step 5: Rebase + Push
      const rebaseResult = await rebaseOnTarget(worktree.path, targetBranch)
      if (rebaseResult.conflict) {
        return { success: false, output, error: `与 ${targetBranch} 存在冲突，需要人工解决` }
      }

      await pushBranch(worktree.path, branch)

      // Step 6: 创建 MR
      const mr = await createMrViaApi({
        projectPath,
        sourceBranch: branch,
        targetBranch,
        level,
        issueId: report.issueId,
        issueTitle: (report.rootCauseSummary ?? '').substring(0, 60),
      })

      if (!mr) {
        return { success: false, output, error: '创建 MR 失败' }
      }

      // Step 7: 更新 Issue 标签 + 触发 AI Review
      await updateIssueLabels(projectPath, report.issueId, {
        add: ['in-review'],
        remove: ['fixing'],
      }).catch(() => {})

      handleFixComplete(report.issueId, mr.iid, projectPath)
        .catch(err => console.error(`[FixAgent] handleFixComplete failed:`, err))

      return {
        success: true,
        output: `修复完成，MR !${mr.iid} 已创建: ${mr.url}\n\n${output}`,
        data: { mrIid: mr.iid, mrUrl: mr.url, branch },
      }
    } finally {
      release(worktree)
    }
  }

  const onDowngrade = async (ctx: RetryContext): Promise<void> => {
    console.warn(`[FixAgent] Issue #${ctx.issueId}: ${ctx.attempt} 次修复失败，降级为 needs-manual`)
    const knowledgeRepo = await getByProductLineId(report.productLineId)
    if (knowledgeRepo) {
      const projectPath = extractProjectPath(knowledgeRepo.codeRepoUrl)
      await updateIssueLabels(projectPath, report.issueId, {
        add: ['needs-manual'],
        remove: ['fixing', `level-${level}`],
      }).catch(err => console.error('[FixAgent] Issue 标签更新失败:', err))
    }
  }

  if (level === 'l1') {
    return fixAttempt({ issueId: report.issueId, level, attempt: 1 })
  }

  return retryWithDowngrade(report.issueId, level, fixAttempt, onDowngrade)
}

export function registerFixHandlers(): void {
  registerCapabilityHandler('fix_bug_l1', (opts) => handleFixBug(opts, 'l1'))
  registerCapabilityHandler('fix_bug_l2', (opts) => handleFixBug(opts, 'l2'))
  registerCapabilityHandler('fix_bug_l3', (opts) => handleFixBug(opts, 'l3'))
  console.log('[FixAgent] fix_bug_l1/l2/l3 handlers registered')
}

export { extractProjectPath, isFixSuccessful }
