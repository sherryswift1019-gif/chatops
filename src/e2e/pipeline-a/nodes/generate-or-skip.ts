// src/e2e/pipeline-a/nodes/generate-or-skip.ts
import { spawnSync } from 'child_process'
import { join } from 'path'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { runE2eLlmGenerator } from './llm-generator.js'
import type { PipelineAStateType } from '../types.js'

export async function generateOrSkipNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const spec = state.specs[state.currentSpecIndex]
  if (!spec) return {}

  const project = await getE2eTargetProject(spec.targetProjectId)
  if (!project) throw new Error(`project not found: ${spec.targetProjectId}`)

  const outScriptPath = `tests/e2e/${spec.specPath.split('/').pop()!.replace('.md', '.spec.ts')}`

  if (project.capabilities.generate) {
    const testScript = join(project.workingDir, project.scripts.test)
    const result = spawnSync(testScript, ['--generate', spec.specPath, `--out=${outScriptPath}`], {
      encoding: 'utf8',
      timeout: 120_000,
    })
    if (result.status === 0) {
      const updatedSpec = { ...spec, scriptPath: outScriptPath }
      const updatedSpecs = [...state.specs]
      updatedSpecs[state.currentSpecIndex] = updatedSpec
      return { specs: updatedSpecs }
    }
    console.warn(`[PipelineA:generateOrSkip] project --generate failed (exit ${result.status}), falling back to LLM`)
  }

  const generated = await runE2eLlmGenerator(spec.specPath, spec.title)
  const updatedSpec = { ...spec, scriptPath: outScriptPath, generatedContent: generated }
  const updatedSpecs = [...state.specs]
  updatedSpecs[state.currentSpecIndex] = updatedSpec

  return { specs: updatedSpecs, staticCheckAttempts: 0 }
}
