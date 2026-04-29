import { describe, it, expect } from 'vitest'
import { validateTriggerParams } from '../../../pipeline/validate-trigger-params.js'

describe('validateTriggerParams', () => {
  it('returns valid=true when paramSchema is null', () => {
    expect(validateTriggerParams(null, {})).toEqual({ valid: true, missingFields: [] })
  })

  it('returns valid=true when all required fields present', () => {
    const schema = { properties: { env: {}, project: {} }, required: ['env', 'project'] }
    expect(validateTriggerParams(schema, { env: 'prod', project: 'foo' }))
      .toEqual({ valid: true, missingFields: [] })
  })

  it('returns missing fields when required field absent', () => {
    const schema = { properties: { env: {}, project: {} }, required: ['env', 'project'] }
    const result = validateTriggerParams(schema, { env: 'prod' })
    expect(result.valid).toBe(false)
    expect(result.missingFields).toEqual(['project'])
  })

  it('treats empty string as missing', () => {
    const schema = { properties: { env: {} }, required: ['env'] }
    const result = validateTriggerParams(schema, { env: '' })
    expect(result.valid).toBe(false)
    expect(result.missingFields).toContain('env')
  })

  it('returns valid=true when no required array in schema', () => {
    const schema = { properties: { env: {} } }
    expect(validateTriggerParams(schema, {})).toEqual({ valid: true, missingFields: [] })
  })
})
