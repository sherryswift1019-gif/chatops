import { registerCapabilityHandler, handleFixComplete } from '../coordinator.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { getByProductLineId } from '../../db/repositories/product-knowledge-repos.js'
import { acquire, release } from '../worktree/manager.js'
import { getTool } from '../tools/index.js'
import { retryWithDowngrade } from './retry-handler.js'
import { createFixBranch, commitChanges, pushBranch, rebaseOnTarget } from './branch-manager.js'
import { updateIssueLabels } from '../../adapters/gitlab/labels.js'
import { mask } from '../masking/sensitive-info.js'
import axios from 'axios'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import type { RetryContext } from './retry-handler.js'
import type { ClaudeRunner } from '../claude-runner.js'

let runner: ClaudeRunner | null = null
export function setFixClaudeRunner(r: ClaudeRunner): void { runner = r }

const FIX_SYSTEM_PROMPT = `你是一个代码修复专家。基于提供的 Bug 分析报告和修复方案，你需要：

1. 使用 read_code 阅读相关代码，理解当前实现
2. 使用 fix_code 修改代码（仅修改必要的文件，不动其他代码）
3. 使用 run_tests 运行测试验证修复
4. 如果测试不通过，分析失败原因，修改代码后重新测试
5. 修复完成后使用 update_ai_summary 更新模块的 AI 摘要

## 重要规则
- 只改方案中指定的文件和逻辑，不要顺手"优化"周围代码
- 每次修改后都要跑测试验证
- 测试全部通过后，在最后的回复中明确包含"所有测试通过"
- 如果多次尝试后测试仍然失败，在最后的回复中说明失败原因

## 输出格式
修复完成后请总结：
- 修改了哪些文件
- 修复的核心思路
- 测试结果（所有测试通过 / 测试失败+原因）
`

/** 从 git URL 提取 GitLab 项目路径 */
function extractProjectPath(codeRepoUrl: string): string {
  // http://code.paraview.cn/PAM/java-code/pas-6.0.git → PAM/java-code/pas-6.0
  // ssh://git@code.paraview.cn:PAM/java-code/pas-6.0.git → PAM/java-code/pas-6.0
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
        description: `AI 自动修复 Issue #${opts.issueId}\n\n等级: ${opts.level}\n\n> 此 MR 由 AI Agent 自动生成，请 Review 后合并。`,
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

  // 同时出现时，以最后出现的为准（Claude 可能先失败后修复成功）
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
    if (!runner) return { success: false, error: 'ClaudeRunner 未初始化' }

    const knowledgeRepo = await getByProductLineId(report.productLineId)
    if (!knowledgeRepo) return { success: false, error: `产品线 ${report.productLineId} 未配置代码仓库` }

    const projectPath = extractProjectPath(knowledgeRepo.codeRepoUrl)
    const targetBranch = knowledgeRepo.codeDefaultBranch || 'test'

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

      // Step 2: Claude 执行修复（read_code → fix_code → run_tests）
      const toolNames = ['fix_code', 'run_tests', 'update_ai_summary', 'switch_version', 'read_code']
      const tools = toolNames.map(n => getTool(n)).filter(Boolean) as any[]

      const solutionsSummary = report.solutionsJson
        ?.map((s: any) => `- [${s.recommended ? '推荐' : '备选'}] ${s.summary}（风险:${s.risk}, 工作量:${s.effort}）`)
        .join('\n') ?? '无方案'

      const prompt = [
        `修复 Bug Issue #${report.issueId}（尝试 ${ctx.attempt}/3，等级 ${level}）`,
        '',
        `## 根因分析`,
        report.rootCauseSummary,
        '',
        `## 修复方案`,
        solutionsSummary,
        '',
        `## 影响模块`,
        (report.affectedModules ?? []).join(', ') || '未知',
        '',
        `请按照推荐方案修复代码，修复后运行测试验证。`,
      ].join('\n')

      const rawOutput = await runner.executeCapabilityDirect({
        prompt,
        systemPrompt: FIX_SYSTEM_PROMPT,
        context: { ...opts.context, cwd: worktree.path, productLineId: report.productLineId },
        tools,
        cwd: worktree.path,
        sessionKey: `fix-${report.issueId}-${ctx.attempt}`,
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

      // Step 5: Rebase 到目标分支最新（检测冲突）
      const rebaseResult = await rebaseOnTarget(worktree.path, targetBranch)
      if (rebaseResult.conflict) {
        console.warn(`[FixAgent] Issue #${report.issueId}: rebase 冲突，跳过 MR 创建`)
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

      // Step 6: 更新 Issue 标签 + 触发 AI Review
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

    // 更新 GitLab Issue 标签
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
    // L1 不重试，一次搞定（配置类改动简单）
    return fixAttempt({ issueId: report.issueId, level, attempt: 1 })
  }

  // L2/L3 使用重试 + 降级
  return retryWithDowngrade(report.issueId, level, fixAttempt, onDowngrade)
}

export function registerFixHandlers(): void {
  registerCapabilityHandler('fix_bug_l1', (opts) => handleFixBug(opts, 'l1'))
  registerCapabilityHandler('fix_bug_l2', (opts) => handleFixBug(opts, 'l2'))
  registerCapabilityHandler('fix_bug_l3', (opts) => handleFixBug(opts, 'l3'))
  console.log('[FixAgent] fix_bug_l1/l2/l3 handlers registered')
}

export { extractProjectPath, isFixSuccessful }
