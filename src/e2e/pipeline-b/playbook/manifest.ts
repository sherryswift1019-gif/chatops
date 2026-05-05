// src/e2e/pipeline-b/playbook/manifest.ts
//
// scenario 跑完后由 host Claude 写入 evidenceDir/manifest.json，
// 供 await_human_review 节点摘要、e2e-fix-agent 接力诊断使用。
import { z } from 'zod'

const traceStepSchema = z.object({
  step: z.number().int().nonnegative(),
  intent: z.string().min(1),
  tool: z.string().min(1).optional(), // 如 browser_navigate / bash / psql
  args_summary: z.string().optional(), // 一行可读摘要，原始 args 不要塞进来太大
  verdict: z.enum(['ok', 'warn', 'error']),
  note: z.string().optional(),
  started_at: z.string().datetime().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
})

const acceptanceResultSchema = z.object({
  kind: z.string().min(1), // 与 playbook 的 acceptance.kind 对齐
  index: z.number().int().nonnegative(), // playbook.scenarios[i].acceptance[index]
  result: z.enum(['pass', 'fail', 'skip', 'error']),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  reason: z.string().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
})

const artifactSchema = z.object({
  path: z.string().min(1), // 相对 evidenceDir 的路径
  kind: z.enum([
    'screenshot',
    'log',
    'har',
    'dom_snapshot',
    'sql_result',
    'other',
  ]),
  description: z.string().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
})

export const manifestSchema = z.object({
  scenarioId: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  result: z.enum(['pass', 'fail', 'error', 'timeout']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  claudeTrace: z.array(traceStepSchema).default([]),
  acceptanceResults: z.array(acceptanceResultSchema).default([]),
  artifacts: z.array(artifactSchema).default([]),
  errorMessage: z.string().optional(),
  // 额外结构化字段（沙盒环境信息 / 自由扩展）
  meta: z.record(z.string(), z.unknown()).optional(),
})

export type Manifest = z.infer<typeof manifestSchema>
export type TraceStep = z.infer<typeof traceStepSchema>
export type AcceptanceResult = z.infer<typeof acceptanceResultSchema>
export type Artifact = z.infer<typeof artifactSchema>
