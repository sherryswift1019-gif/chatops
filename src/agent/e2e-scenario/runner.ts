// src/agent/e2e-scenario/runner.ts
//
// Pipeline B 的"跑场景"环节：host 上调 Claude，Claude 用内置 Bash + Read + Write +
// Playwright MCP 操作沙盒（docker exec / curl / psql / browser_*），逐个 acceptance
// 验证后把结果写到 evidenceDir/manifest.json。
//
// 不修产品代码、不 git commit —— 那是 e2e-fix runner 的事，本 runner 只跑+采证。
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { stringify as yamlStringify } from 'yaml'
import { ClaudeRunner, type McpServerSpec } from '../claude-runner.js'
import type { TaskContext } from '../tools/types.js'
import { parseManifestJson } from '../../e2e/pipeline-b/playbook/parse.js'
import type { Playbook } from '../../e2e/pipeline-b/playbook/types.js'
import type { Manifest } from '../../e2e/pipeline-b/playbook/manifest.js'
import type { SandboxHandle } from '../../e2e/pipeline-b/types.js'
import { createOnMessageBridge } from '../../e2e/pipeline-b/scenario-event-bridge.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 仓库 fixture（产品代码的一部分，docker self-contained）优先；
// 找不到回落 host 用户 ~/.claude/skills（开发者本地 host 跑场景）。
const REPO_SKILL_PATH = join(__dirname, 'skill', 'SKILL.md')
const HOST_SKILL_PATH = join(homedir(), '.claude', 'skills', 'e2e-scenario', 'SKILL.md')

export function resolveSkillPath(): string {
  if (existsSync(REPO_SKILL_PATH)) return REPO_SKILL_PATH
  return HOST_SKILL_PATH
}

export interface RunScenarioInput {
  playbook: Playbook
  scenarioId: string
  evidenceDir: string
  sandboxHandle: SandboxHandle
  attemptNumber: number
  runId: bigint
}

export interface RunScenarioResult {
  manifest: Manifest | null
  rawOutput: string
  errorMessage: string | null
}

const SCENARIO_CONTEXT: TaskContext = {
  taskId: 'e2e-scenario',
  groupId: 'e2e-pipeline-b',
  platform: 'internal',
  initiatorId: 'pipeline-b',
  initiatorRole: null,
}

// Playwright MCP — base image 装的是 playwright managed chromium（chromium-XXXX），
// @playwright/mcp@latest 默认 channel=chrome 找 /opt/google/chrome/chrome 找不到；
// 它的 --browser=chromium 在新版 playwright 实际指 chrome-for-testing 也未装。
// 用 --executable-path 显式指向 base image 已装的 chromium binary，绕开版本问题。
// 路径来自 Dockerfile.base 的 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright + chromium 子目录。
//
// --no-sandbox: 容器内无 user namespaces（Ubuntu 24+ 默认禁），chromium zygote 启动会
//   FATAL: No usable sandbox。
// --headless: 容器内无 display server，必须 headless。
// @playwright/mcp 装在 chatops 的 node_modules（package.json deps 0.0.73 pin 版本），
// 不再用 `npx -y @playwright/mcp@latest` 现场下载。
// 修因：npx 冷启动需 50s+ 拉 17MB，与 Claude CLI MCP init 形成 race condition，
// host Claude 看到的 tools/list 不含 mcp__playwright__*，调用时报"No such tool available"。
// 改本地 cli.js 直调后启动稳定 1-2s（缓存命中级）。
const CHROMIUM_BIN = '/ms-playwright/chromium-1217/chrome-linux/chrome'
const PLAYWRIGHT_MCP_CLI = join(
  __dirname, '..', '..', '..',
  'node_modules', '@playwright', 'mcp', 'cli.js',
)
export const PLAYWRIGHT_MCP: Record<string, McpServerSpec> = {
  playwright: {
    command: 'node',
    args: [
      PLAYWRIGHT_MCP_CLI,
      `--executable-path=${CHROMIUM_BIN}`,
      '--no-sandbox',
      '--headless',
    ],
  },
}

// 内置工具全开（Bash/Read/Write/Edit/Glob/Grep），仅禁联网 + 子 Agent
const SCENARIO_DISALLOWED = ['WebSearch', 'WebFetch', 'Agent']

let _runner: ClaudeRunner | null = null
function getRunner(): ClaudeRunner {
  if (!_runner) _runner = new ClaudeRunner()
  return _runner
}

// 测试 / 替换钩子：让单测注入假 runner，无需真起 Claude CLI。
export function __setRunnerForTesting(runner: ClaudeRunner | null): void {
  _runner = runner
}

// 测试钩子：注入 systemPrompt 内容，绕过对 ~/.claude/skills/e2e-scenario/SKILL.md 的 fs 读取。
// 传 string 当作直接命中；传 Error 模拟读取失败；传 null 恢复真实读取行为。生产代码不应调用。
let _skillOverride: string | Error | null = null
export function __setSkillForTesting(content: string | Error | null): void {
  _skillOverride = content
}

export async function runE2eScenario(input: RunScenarioInput): Promise<RunScenarioResult> {
  const scenario = input.playbook.scenarios.find((s) => s.id === input.scenarioId)
  if (!scenario) {
    return {
      manifest: null,
      rawOutput: '',
      errorMessage: `scenarioId "${input.scenarioId}" 不在 playbook 中`,
    }
  }

  let systemPrompt: string
  if (_skillOverride !== null) {
    if (_skillOverride instanceof Error) {
      return {
        manifest: null,
        rawOutput: '',
        errorMessage: `SKILL.md 未找到: ${resolveSkillPath()}`,
      }
    }
    systemPrompt = _skillOverride
  } else {
    const skillPath = resolveSkillPath()
    try {
      systemPrompt = readFileSync(skillPath, 'utf8')
    } catch {
      return {
        manifest: null,
        rawOutput: '',
        errorMessage: `SKILL.md 未找到: ${skillPath}`,
      }
    }
  }

  const userMessage = [
    `请执行 e2e 场景 "${input.scenarioId}"（attempt #${input.attemptNumber}）。`,
    ``,
    `Evidence dir (host 路径；所有 artifact 与 manifest.json 写到此处): ${input.evidenceDir}`,
    ``,
    `沙盒环境：`,
    `- containerId: ${input.sandboxHandle.containerId ?? '(未提供)'}`,
    `- workdir(容器内): ${input.sandboxHandle.workdir ?? '(未提供)'}`,
    `- endpoints: ${JSON.stringify(input.sandboxHandle.endpoints)}`,
    ``,
    `Playbook spec: ${input.playbook.specPath}${input.playbook.specTitle ? ` (${input.playbook.specTitle})` : ''}`,
    ``,
    `当前 scenario (YAML)：`,
    yamlStringify({ scenarios: [scenario] }),
    ``,
    `请严格按 SKILL 流程操作。完成后必须在 ${input.evidenceDir}/manifest.json 写入符合 schema 的 JSON 文件，否则视为本次跑失败。`,
  ].join('\n')

  let rawOutput = ''
  try {
    const onMessage = createOnMessageBridge(input.runId, 'scenario')
    rawOutput = await getRunner().executeCapabilityDirect({
      prompt: userMessage,
      systemPrompt,
      context: SCENARIO_CONTEXT,
      tools: [],
      sessionKey: `e2e-scenario-${input.scenarioId}-${input.attemptNumber}`,
      freshSession: true,
      maxTurns: 60,
      timeoutMs: 30 * 60 * 1000,
      disallowedTools: SCENARIO_DISALLOWED,
      extraMcpServers: PLAYWRIGHT_MCP,
      onMessage,
    })
  } catch (err) {
    return {
      manifest: null,
      rawOutput: '',
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }

  const manifestPath = join(input.evidenceDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return {
      manifest: null,
      rawOutput,
      errorMessage: `Claude 完成但未写出 ${manifestPath}`,
    }
  }

  let content: string
  try {
    content = readFileSync(manifestPath, 'utf8')
  } catch (err) {
    return {
      manifest: null,
      rawOutput,
      errorMessage: `读取 ${manifestPath} 失败: ${(err as Error).message}`,
    }
  }

  const parsed = parseManifestJson(content)
  if (!parsed.ok) {
    const issues = parsed.issues?.map((i) => `${i.path}: ${i.message}`).join('; ')
    return {
      manifest: null,
      rawOutput,
      errorMessage: `manifest.json schema 校验失败: ${parsed.error}${issues ? ` (${issues})` : ''}`,
    }
  }

  return { manifest: parsed.value, rawOutput, errorMessage: null }
}
