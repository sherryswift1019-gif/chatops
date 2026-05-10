/**
 * Quick-Impl LLM-as-judge 评测脚本
 *
 * 设计：docs/prds/quick-impl-roles-v2/05-evaluation.md §2
 *
 * 用法：
 *   pnpm exec tsx scripts/qi-eval-judge.ts --report docs/qi-eval-2026-05-08-spec-author-v2-B.json
 *   pnpm exec tsx scripts/qi-eval-judge.ts --report ... --output docs/qi-judge-...json
 *
 * 流程：
 *   1. 读 qi-eval 报告 JSON（含 input / output / artifactContent / extendedOutput）
 *   2. 加载 scripts/qi-eval-judge-prompt.md 作为 system prompt
 *   3. 构造 user message：role / input / output / artifactContent
 *   4. 调 Porygon (Claude) 跑判官，解析 5 项打分 JSON
 *   5. 落盘 judge 报告
 *
 * Phase 5+ regression CI 调它跑 nightly evaluation（详见 05-evaluation.md §4.2）。
 *
 * 注：当前为框架实现，**未与人工打分校准**。Phase 5+ 跑 ≥10 个 case 后用人工抽查校准 prompt。
 */
import 'dotenv/config'
import { createPorygon } from '@snack-kit/porygon'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { buildClaudeEnv } from '../src/agent/claude-config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const JUDGE_PROMPT_PATH = join(__dirname, 'qi-eval-judge-prompt.md')

interface CliArgs {
  report: string
  output?: string
  timeoutMs: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { timeoutMs: 300_000 }
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i]!
    const next = argv[i + 1]
    switch (v) {
      case '--report':     args.report = next; i++; break
      case '--output':     args.output = next; i++; break
      case '--timeout-ms': args.timeoutMs = Number(next); i++; break
      case '--help': case '-h':
        printUsage(); process.exit(0)
      default:
        if (v?.startsWith('--')) {
          console.error(`unknown flag: ${v}`)
          printUsage(); process.exit(1)
        }
    }
  }
  if (!args.report) { console.error('--report required'); process.exit(1) }
  if (!existsSync(args.report)) { console.error(`report not found: ${args.report}`); process.exit(1) }
  return args as CliArgs
}

function printUsage(): void {
  console.log(`
qi-eval-judge — LLM-as-judge for Quick-Impl evaluation reports

Usage:
  pnpm exec tsx scripts/qi-eval-judge.ts --report <path-to-qi-eval-*.json> [--output <out.json>]

详见 docs/prds/quick-impl-roles-v2/05-evaluation.md §2
`)
}

function extractLastJsonBlock(text: string): unknown {
  const fenced = text.match(/```\s*json\s*([\s\S]*?)```/g)
  if (fenced && fenced.length > 0) {
    const body = fenced[fenced.length - 1]!.replace(/```\s*json\s*/, '').replace(/```$/, '').trim()
    return JSON.parse(body)
  }
  // fallback: balanced { ... }
  const lastClose = text.lastIndexOf('}')
  if (lastClose < 0) throw new Error('no JSON found in judge output')
  let depth = 0
  for (let i = lastClose; i >= 0; i--) {
    if (text[i] === '}') depth++
    else if (text[i] === '{') {
      depth--
      if (depth === 0) return JSON.parse(text.slice(i, lastClose + 1))
    }
  }
  throw new Error('no balanced JSON found')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)

  const report = JSON.parse(readFileSync(args.report, 'utf8'))
  const meta = report.meta ?? {}
  const role = meta.role
  const inputs = report.inputs ?? {}
  const output = report.extendedOutput ?? report.output ?? null
  const artifactContent = report.artifactContent ?? null

  if (!role) {
    console.error('report missing meta.role')
    process.exit(1)
  }

  console.log(`[judge] judging report: role=${role} case=${meta.case} mode=${meta.mode}`)

  // 加载 judge prompt
  const judgePrompt = readFileSync(JUDGE_PROMPT_PATH, 'utf8')

  const userMessage = [
    `# Evaluation input`,
    ``,
    `\`\`\`json`,
    JSON.stringify({
      role,
      input: inputs,
      output,
      artifactContent: artifactContent ? `(${artifactContent.length} chars)\n\n${artifactContent}` : null,
    }, null, 2),
    `\`\`\``,
    ``,
    `请按 system prompt 的 5 项维度评分。输出仅 JSON block。`,
  ].join('\n')

  const claudeEnv = await buildClaudeEnv()
  const startedAt = Date.now()

  const porygon = createPorygon({
    defaultBackend: 'claude',
    backends: { claude: { interactive: false } },
  })

  let assistantBuffer = ''
  let textBuffer = ''
  let inputTokens = 0
  let outputTokens = 0

  const queryIter = porygon.query({
    prompt: userMessage,
    appendSystemPrompt: judgePrompt,
    cwd: process.cwd(),
    disallowedTools: [
      'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep',
      'TodoWrite', 'Task', 'WebFetch', 'WebSearch',
    ], // judge 是纯 reasoning 任务，禁止用工具避免分心
    envVars: { ...claudeEnv },
    maxTurns: 5,
  })

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`judge timeout ${args.timeoutMs}ms`)), args.timeoutMs)
  })

  const consume = async (): Promise<void> => {
    for await (const msg of queryIter) {
      if (msg.type === 'assistant' && 'text' in msg) {
        assistantBuffer += String((msg as { text: string }).text)
      } else if (msg.type === 'result' && 'text' in msg) {
        textBuffer += String((msg as { text: string }).text)
      }
      if ('usage' in msg && msg.usage) {
        const u = msg.usage as { input_tokens?: number; output_tokens?: number }
        if (u.input_tokens) inputTokens += u.input_tokens ?? 0
        if (u.output_tokens) outputTokens += u.output_tokens ?? 0
      }
    }
    if (!textBuffer && assistantBuffer) textBuffer = assistantBuffer
  }

  await Promise.race([consume(), timeoutPromise])

  const durationMs = Date.now() - startedAt
  console.log(`[judge] done in ${durationMs}ms (input=${inputTokens} output=${outputTokens} tokens)`)

  // 解析评分 JSON
  let scores: unknown
  try {
    scores = extractLastJsonBlock(textBuffer)
  } catch (err) {
    console.error(`[judge] failed to parse judge output: ${err}`)
    console.error(`[judge] raw output (last 500):\n${textBuffer.slice(-500)}`)
    process.exit(2)
  }

  const date = new Date().toISOString().slice(0, 10)
  const outputPath = args.output ?? `docs/qi-judge-${date}-${role}-${meta.mode ?? 'unknown'}.json`

  const judgeReport = {
    meta: { date, role, case: meta.case, mode: meta.mode, sourceReport: args.report, durationMs, inputTokens, outputTokens },
    scores,
    rawOutput: textBuffer,
  }
  writeFileSync(outputPath, JSON.stringify(judgeReport, null, 2), 'utf8')
  console.log(`[judge] report written to ${outputPath}`)

  // 简要打印总分
  if (scores && typeof scores === 'object' && 'totalScore' in scores) {
    console.log(`[judge] totalScore: ${(scores as { totalScore: number }).totalScore}/25`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(3)
})
