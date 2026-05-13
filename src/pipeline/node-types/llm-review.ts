import { z } from 'zod'
import { registerNodeType } from './registry.js'

registerNodeType({
  key: 'llm_review',
  async execute() {
    throw new Error(
      'llm_review must be invoked via graph-builder (buildLlmReviewNode). See src/pipeline/graph-builder.ts.',
    )
  },
})

const NoteItem = z.object({
  severity: z.enum(['error', 'warn']),
  msg: z.string(),
  file: z.string().optional(),
})

export const SpecReviewOutputSchema = z.object({
  round: z.number().int().min(1),
  decision: z.enum(['pass', 'fail']),
  notes: z.array(NoteItem),
  newIssues: z.array(NoteItem),
  decisionBasis: z.string(),
  resolvedFromPrevious: z.array(z.object({
    previousNote: z.string(),
    status: z.enum(['resolved', 'still-failing', 'not-applicable']),
    evidence: z.string(),
  })).optional(),
}).superRefine((data, ctx) => {
  if (data.round >= 2 && !data.resolvedFromPrevious) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolvedFromPrevious'],
      message: 'resolvedFromPrevious is required when round >= 2',
    })
  }
})

export type SpecReviewOutput = z.infer<typeof SpecReviewOutputSchema>
