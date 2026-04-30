import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { upsertE2eSpec, updateE2eSpecStatus, listE2eSpecs } from '../../../db/repositories/e2e-specs.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import type { PipelineAStateType, SpecWorkItem } from '../types.js'

export async function initGenerationNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { targetProjectId, specPaths, baseBranch } = state

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: project "${targetProjectId}" not found`)

  await resolveGitlabConfig()

  let resolvedPaths = specPaths
  if (!resolvedPaths.length) {
    const all = await listE2eSpecs(targetProjectId)
    resolvedPaths = all.filter(s => s.generationStatus === 'pending').map(s => s.specPath)
  }

  const specs: SpecWorkItem[] = []
  for (const specPath of resolvedPaths) {
    const spec = await upsertE2eSpec({
      targetProjectId,
      specPath,
      title: specPath.split('/').pop()?.replace('.md', '') ?? specPath,
      contentHash: 'tbd',
    })
    await updateE2eSpecStatus(spec.id, 'generating')
    specs.push({
      specId: spec.id,
      specPath,
      title: spec.title,
      contentHash: spec.contentHash,
      targetProjectId,
    })
  }

  console.log(`[PipelineA:initGeneration] ${specs.length} specs to generate for ${targetProjectId}`)
  return { specs, currentSpecIndex: 0 }
}
