import { getPool } from '../client.js'

export interface ProductKnowledgeRepo {
  id: number
  productLineId: number
  codeRepoUrl: string
  codeDefaultBranch: string
  knowledgeRepoUrl: string
  aiSummaryPath: string
  imageStorageConfig: Record<string, unknown> | null
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): ProductKnowledgeRepo {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    codeRepoUrl: r.code_repo_url as string,
    codeDefaultBranch: r.code_default_branch as string,
    knowledgeRepoUrl: r.knowledge_repo_url as string,
    aiSummaryPath: r.ai_summary_path as string,
    imageStorageConfig: r.image_storage_config as Record<string, unknown> | null,
    createdAt: r.created_at as Date,
  }
}

export async function getByProductLineId(productLineId: number): Promise<ProductKnowledgeRepo | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM product_knowledge_repos WHERE product_line_id = $1',
    [productLineId]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createProductKnowledgeRepo(
  data: Pick<ProductKnowledgeRepo, 'productLineId' | 'codeRepoUrl' | 'codeDefaultBranch' | 'knowledgeRepoUrl' | 'aiSummaryPath' | 'imageStorageConfig'>
): Promise<ProductKnowledgeRepo> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO product_knowledge_repos (product_line_id, code_repo_url, code_default_branch, knowledge_repo_url, ai_summary_path, image_storage_config)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [data.productLineId, data.codeRepoUrl, data.codeDefaultBranch, data.knowledgeRepoUrl, data.aiSummaryPath,
     data.imageStorageConfig ? JSON.stringify(data.imageStorageConfig) : null]
  )
  return mapRow(rows[0])
}

export async function updateProductKnowledgeRepo(
  productLineId: number,
  data: Partial<Pick<ProductKnowledgeRepo, 'codeRepoUrl' | 'codeDefaultBranch' | 'knowledgeRepoUrl' | 'aiSummaryPath' | 'imageStorageConfig'>>
): Promise<ProductKnowledgeRepo | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE product_knowledge_repos SET
       code_repo_url = COALESCE($2, code_repo_url),
       code_default_branch = COALESCE($3, code_default_branch),
       knowledge_repo_url = COALESCE($4, knowledge_repo_url),
       ai_summary_path = COALESCE($5, ai_summary_path),
       image_storage_config = COALESCE($6, image_storage_config)
     WHERE product_line_id = $1 RETURNING *`,
    [productLineId, data.codeRepoUrl ?? null, data.codeDefaultBranch ?? null,
     data.knowledgeRepoUrl ?? null, data.aiSummaryPath ?? null,
     data.imageStorageConfig ? JSON.stringify(data.imageStorageConfig) : null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}
