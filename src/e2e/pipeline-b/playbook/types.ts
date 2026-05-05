// src/e2e/pipeline-b/playbook/types.ts
import { z } from 'zod'

// Acceptance kinds — 每加一种这里加一个 schema，下面 union 加一行
const urlMatchSchema = z.object({
  kind: z.literal('url_match'),
  value: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
})

const urlRegexSchema = z.object({
  kind: z.literal('url_regex'),
  pattern: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
})

const domVisibleSchema = z.object({
  kind: z.literal('dom_visible'),
  selector: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
})

const domTextContainsSchema = z.object({
  kind: z.literal('dom_text_contains'),
  selector: z.string().min(1),
  value: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
})

const apiResponseSchema = z.object({
  kind: z.literal('api_response'),
  request: z.string().min(1), // "METHOD /path"，详细解析交给 verifier
  expect_status: z.number().int().min(100).max(599).optional(),
  expect_body_contains: z.string().optional(),
  expect_body_json_path: z
    .object({
      path: z.string().min(1),
      equals: z.unknown().optional(),
      contains: z.string().optional(),
    })
    .optional(),
  timeout_ms: z.number().int().positive().optional(),
})

const logContainsSchema = z.object({
  kind: z.literal('log_contains'),
  source: z.string().min(1), // 容器名 / 日志通道，由 sandbox endpoints 解析
  value: z.string().min(1),
  since_seconds: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
})

// db_query 的期望 —— 三种之一（rows 数 / 单字段值 / 包含字段值）
const dbQueryExpectSchema = z
  .object({
    rows: z.number().int().nonnegative().optional(),
    field: z
      .object({
        col: z.string().min(1),
        equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      })
      .optional(),
    contains_field_value: z.string().optional(),
  })
  .refine(
    (v) =>
      v.rows !== undefined ||
      v.field !== undefined ||
      v.contains_field_value !== undefined,
    { message: 'expect 必须至少有一个：rows / field / contains_field_value' },
  )

const dbQuerySchema = z.object({
  kind: z.literal('db_query'),
  // dsn 不直接写 playbook，由 sandboxHandle.endpoints 里以 connection 名引用
  connection: z.string().min(1),
  sql: z.string().min(1),
  expect: dbQueryExpectSchema,
  timeout_ms: z.number().int().positive().optional(),
})

export const acceptanceSchema = z.discriminatedUnion('kind', [
  urlMatchSchema,
  urlRegexSchema,
  domVisibleSchema,
  domTextContainsSchema,
  apiResponseSchema,
  logContainsSchema,
  dbQuerySchema,
])

export type Acceptance = z.infer<typeof acceptanceSchema>
export type AcceptanceKind = Acceptance['kind']

const setupSchema = z
  .object({
    hints: z.array(z.string().min(1)).optional(),
  })
  .optional()

export const scenarioSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9._\-]+$/, 'scenario.id 仅允许字母数字 . _ -'),
  name: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  setup: setupSchema,
  steps: z.array(z.string().min(1)).default([]),
  acceptance: z.array(acceptanceSchema).min(1, 'acceptance 至少 1 条'),
  on_fail_hints: z.array(z.string().min(1)).optional(),
})

export type Scenario = z.infer<typeof scenarioSchema>

export const playbookSchema = z
  .object({
    specPath: z.string().min(1),
    specTitle: z.string().min(1).optional(),
    scenarios: z.array(scenarioSchema).min(1, 'playbook 至少 1 个 scenario'),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<string>()
    val.scenarios.forEach((s, i) => {
      if (seen.has(s.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenarios', i, 'id'],
          message: `重复的 scenario.id: ${s.id}`,
        })
      }
      seen.add(s.id)
    })
  })

export type Playbook = z.infer<typeof playbookSchema>
