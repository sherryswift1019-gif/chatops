import { getPool } from '../client.js'

/**
 * internal_capability_pipelines (schema-v37 引入) — phase 4 过渡映射表。
 *
 * 用途: 把 capability key (e.g. 'request_handover') 映射到一个 internal pipeline id;
 * coordinator.triggerCapability 在 PIPELINE_DAG_HANDLERS feature flag 命中时
 * 据此选择走 pipeline 路径而不是旧 handler 路径。
 *
 * phase 4 完成后(L1+L2+L3 三个 handler 全部迁完且稳定),整张表会被删除,
 * 这 3 个 capability 永远走 pipeline (见 spec §6.5)。
 */
export interface InternalCapabilityPipeline {
  capabilityKey: string
  pipelineId: number
  createdAt: Date
}

export async function getInternalPipelineId(
  capabilityKey: string,
): Promise<number | null> {
  const { rows } = await getPool().query(
    'SELECT pipeline_id FROM internal_capability_pipelines WHERE capability_key = $1',
    [capabilityKey],
  )
  return (rows[0]?.pipeline_id as number | undefined) ?? null
}
