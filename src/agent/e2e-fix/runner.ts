import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { ClaudeRunner } from '../claude-runner.js'
import type { TaskContext } from '../tools/types.js'
import { createOnMessageBridge } from '../../e2e/pipeline-b/scenario-event-bridge.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 仓库 fixture（产品代码的一部分，docker self-contained）优先；
// 找不到回落 host 用户 ~/.claude/skills（开发者本地 host 跑）。
const REPO_SKILL_PATH = join(__dirname, 'skill', 'SKILL.md')
const HOST_SKILL_PATH = join(homedir(), '.claude', 'skills', 'e2e-fix', 'SKILL.md')

export function resolveSkillPath(): string {
  if (existsSync(REPO_SKILL_PATH)) return REPO_SKILL_PATH
  return HOST_SKILL_PATH
}

export interface AiDiagnosis {
  verdict: 'product_bug' | 'test_flakiness' | 'infra_issue' | 'uncertain'
  rootCauseSummary: string
  fixCommitSha: string | null
  fixedFiles: string[]
  success: boolean
  failureReason: string
}

export interface E2eFixInput {
  scenarioId: string
  evidenceDir: string
  iterationBranch: string
  containerId: string
  workdir: string
  runId: bigint
}

const E2E_FIX_CONTEXT: TaskContext = {
  taskId: 'e2e-fix-agent',
  groupId: 'e2e-pipeline-b',
  platform: 'internal',
  initiatorId: 'pipeline-b',
  initiatorRole: null,
}

let _runner: ClaudeRunner | null = null
function getRunner(): ClaudeRunner {
  if (!_runner) _runner = new ClaudeRunner()
  return _runner
}

// 测试 / 替换钩子：让单测注入假 runner，无需真起 Claude CLI。
export function __setRunnerForTesting(runner: ClaudeRunner | null): void {
  _runner = runner
}

function parseLastJsonLine(output: string): AiDiagnosis | null {
  const lines = output.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const obj = JSON.parse(line)
      if (typeof obj.success === 'boolean' && typeof obj.verdict === 'string') {
        return {
          verdict: obj.verdict as AiDiagnosis['verdict'],
          rootCauseSummary: String(obj.rootCauseSummary ?? ''),
          fixCommitSha: obj.commitSha ?? null,
          fixedFiles: Array.isArray(obj.fixedFiles) ? (obj.fixedFiles as string[]) : [],
          success: Boolean(obj.success),
          failureReason: String(obj.failureReason ?? ''),
        }
      }
    } catch {
      // not valid JSON, keep scanning upward
    }
  }
  return null
}

export async function runE2eFix(input: E2eFixInput): Promise<AiDiagnosis> {
  const userMessage = [
    `场景 ${input.scenarioId} 在沙盒里失败。`,
    `Evidence dir: ${input.evidenceDir}`,
    `Iteration branch: ${input.iterationBranch}`,
    ``,
    `请按 skill 中的流程操作：`,
    `Phase 1: 读取 ${input.evidenceDir}/manifest.json 和所有 artifacts`,
    `Phase 2: 定位根因（grep/git log/Read）`,
    `Phase 3: 运行 ./test.sh --scenario ${input.scenarioId} --evidence-dir=${input.evidenceDir}-repro 复现失败`,
    `Phase 4-5: 修复代码并验证（./test.sh --scenario ${input.scenarioId} --evidence-dir=${input.evidenceDir}-verify）`,
    `Phase 6: git add -A && git commit && git push origin ${input.iterationBranch}`,
    `Phase 7: 输出最后一行 JSON（格式见 skill Hard Rules）`,
  ].join('\n')

  try {
    const systemPrompt = readFileSync(resolveSkillPath(), 'utf8')
    const onMessage = createOnMessageBridge(input.runId, 'fix')
    const output = await getRunner().executeCapabilityDirect({
      prompt: userMessage,
      systemPrompt,
      context: E2E_FIX_CONTEXT,
      tools: [],
      cwd: input.workdir,
      sessionKey: `e2e-fix-${input.scenarioId}`,
      freshSession: true,
      maxTurns: 40,
      timeoutMs: 30 * 60 * 1000,
      dockerExec: { containerId: input.containerId },
      onMessage,
    })

    const parsed = parseLastJsonLine(output)
    if (!parsed) {
      return {
        verdict: 'uncertain',
        rootCauseSummary: '',
        fixCommitSha: null,
        fixedFiles: [],
        success: false,
        failureReason: 'no valid JSON in last line of Claude output',
      }
    }
    return parsed
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      verdict: 'uncertain',
      rootCauseSummary: '',
      fixCommitSha: null,
      fixedFiles: [],
      success: false,
      failureReason: msg,
    }
  }
}
