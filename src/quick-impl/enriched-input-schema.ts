import { z } from 'zod'

export const EnrichedInputSchema = z.object({
  schemaVersion: z.literal('v1'),
  rawInput: z.string(),

  actors: z.object({
    triggerer: z.string().optional(),
    primaryUsers: z.array(z.string()).optional(),
    verifier: z.string().optional(),
  }),
  objective: z.object({
    userValue: z.string().optional(),
    businessValue: z.string().optional(),
    successSignal: z.string().optional(),
  }),
  scope: z.object({
    in: z.array(z.string()),
    out: z.array(z.string()),
    deferred: z.array(z.string()).optional(),
  }),
  noGos: z.array(z.object({
    desc: z.string(),
    reason: z.string().optional(),
  })),
  historicalRefs: z.array(z.object({
    description: z.string(),
    relation: z.enum(['existing', 'past_attempt', 'deprecated', 'related']),
    pointer: z.string().optional(),
  })),
  businessWindow: z.object({
    deadline: z.string().optional(),
    upstreamDeps: z.array(z.string()).optional(),
    priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
  }).optional(),
  codebaseEvidence: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    purpose: z.string(),
  })),

  conversationSummary: z.string(),
  qaTurnCount: z.number(),
  partial: z.boolean(),
  missingFields: z.array(z.string()).optional(),
})

export type EnrichedInput = z.infer<typeof EnrichedInputSchema>
