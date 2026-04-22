import type { FastifyInstance } from 'fastify'
import { createProductKnowledgeRepo, getByProductLineId } from '../../db/repositories/product-knowledge-repos.js'
import { ensureLocalCache } from '../../agent/knowledge/repository.js'
import { scanAndGenerateSummaries } from '../../agent/knowledge/ai-summary-scanner.js'

interface OnboardTask {
  id: string
  productLineId: number
  status: 'pending' | 'cloning' | 'scanning' | 'creating_knowledge' | 'done' | 'failed'
  progress: string[]
  result?: unknown
  error?: string
}

const tasks = new Map<string, OnboardTask>()
const MAX_TASKS = 100
const TASK_TIMEOUT_MS = 30 * 60_000 // 30 分钟

function cleanupOldTasks(): void {
  if (tasks.size <= MAX_TASKS) return
  const entries = [...tasks.entries()].sort((a, b) => {
    const aTime = a[1].status === 'done' || a[1].status === 'failed' ? 0 : 1
    return aTime - (b[1].status === 'done' || b[1].status === 'failed' ? 0 : 1)
  })
  while (tasks.size > MAX_TASKS) {
    const oldest = entries.shift()
    if (oldest) tasks.delete(oldest[0])
  }
}

export async function registerOnboardingRoutes(app: FastifyInstance): Promise<void> {
  // 启动接入任务（异步）
  app.post('/product-knowledge/onboard', async (req) => {
    const body = req.body as any
    const productLineId = body.productLineId as number
    if (!productLineId) return { error: { code: 'MISSING_PARAM', message: 'productLineId required' } }

    const existing = await getByProductLineId(productLineId)
    if (!existing) return { error: { code: 'NOT_CONFIGURED', message: '请先配置产品线的代码仓库和知识库仓库' } }

    const taskId = `onboard-${productLineId}-${Date.now()}`
    const task: OnboardTask = { id: taskId, productLineId, status: 'pending', progress: [] }
    tasks.set(taskId, task)
    cleanupOldTasks()

    // 异步执行，带超时
    const taskPromise = runOnboard(task, existing.codeRepoUrl, existing.knowledgeRepoUrl, existing.aiSummaryPath)
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Onboard timeout (30 min)')), TASK_TIMEOUT_MS)
    )
    Promise.race([taskPromise, timeoutPromise]).catch(err => {
      task.status = 'failed'
      task.error = err instanceof Error ? err.message : String(err)
    })

    return { data: { taskId, status: task.status } }
  })

  // 查询接入进度
  app.get('/product-knowledge/onboard/:taskId', async (req) => {
    const taskId = (req.params as any).taskId as string
    const task = tasks.get(taskId)
    if (!task) return { error: { code: 'NOT_FOUND', message: 'task not found' } }
    return { data: task }
  })
}

async function runOnboard(task: OnboardTask, codeRepoUrl: string, knowledgeRepoUrl: string, aiSummaryPath: string): Promise<void> {
  const product = `pl-${task.productLineId}`

  // Step 1: Clone 代码仓库
  task.status = 'cloning'
  task.progress.push('开始 clone 代码仓库...')
  const repoPath = await ensureLocalCache(product, codeRepoUrl)
  task.progress.push(`代码仓库 clone 完成: ${repoPath}`)

  // Step 2: 扫描生成 AI 摘要
  task.status = 'scanning'
  task.progress.push('开始扫描模块并生成 AI 摘要模板...')
  const scanResult = await scanAndGenerateSummaries(repoPath, aiSummaryPath)
  task.progress.push(`检测到 ${scanResult.modules.length} 个模块，生成 ${scanResult.summaryFiles.length} 个摘要文件`)

  // Step 4: Clone 知识库仓库
  task.status = 'creating_knowledge'
  task.progress.push('确保知识库仓库本地缓存...')
  try {
    await ensureLocalCache(`${product}-knowledge`, knowledgeRepoUrl)
    task.progress.push('知识库仓库就绪')
  } catch (err) {
    task.progress.push(`知识库仓库操作失败（可能尚未创建）: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Step 5: 输出 Webhook 配置指引
  task.progress.push('--- Webhook 配置指引 ---')
  task.progress.push('1. 进入 GitLab 项目 → Settings → Webhooks')
  task.progress.push('2. URL: {your_chatops_url}/webhook/gitlab')
  task.progress.push('3. Secret token: 与 GITLAB_WEBHOOK_SECRET 一致')
  task.progress.push('4. 勾选 Issues events + Merge request events')
  task.progress.push('5. 点击 Add webhook')

  task.status = 'done'
  task.result = scanResult
  task.progress.push('接入完成！')
}
