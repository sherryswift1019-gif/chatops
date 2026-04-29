export interface ValidateResult {
  valid: boolean
  missingFields: string[]
}

export function validateTriggerParams(
  paramSchema: Record<string, unknown> | null | undefined,
  params: Record<string, unknown>,
): ValidateResult {
  if (!paramSchema) return { valid: true, missingFields: [] }
  const required = (paramSchema.required ?? []) as string[]
  const missingFields = required.filter(k => {
    const v = params[k]
    return v === undefined || v === null || v === ''
  })
  return { valid: missingFields.length === 0, missingFields }
}
