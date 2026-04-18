import type { FastifyInstance } from 'fastify'
import { getByProductLineId, createProductKnowledgeRepo, updateProductKnowledgeRepo } from '../../db/repositories/product-knowledge-repos.js'

export async function registerProductKnowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/product-knowledge/:productLineId', async (req) => {
    const productLineId = Number((req.params as any).productLineId)
    const repo = await getByProductLineId(productLineId)
    return { data: repo }
  })

  app.post('/product-knowledge', async (req) => {
    const body = req.body as any
    if (!body.productLineId || !body.codeRepoUrl || !body.knowledgeRepoUrl) {
      return { error: { code: 'MISSING_PARAM', message: 'productLineId, codeRepoUrl, knowledgeRepoUrl required' } }
    }
    const repo = await createProductKnowledgeRepo({
      productLineId: body.productLineId,
      codeRepoUrl: body.codeRepoUrl,
      codeDefaultBranch: body.codeDefaultBranch ?? 'develop',
      knowledgeRepoUrl: body.knowledgeRepoUrl,
      aiSummaryPath: body.aiSummaryPath ?? 'docs/ai',
      imageStorageConfig: body.imageStorageConfig ?? null,
    })
    return { data: repo }
  })

  app.put('/product-knowledge/:productLineId', async (req) => {
    const productLineId = Number((req.params as any).productLineId)
    const body = req.body as any
    const repo = await updateProductKnowledgeRepo(productLineId, body)
    return { data: repo }
  })
}
