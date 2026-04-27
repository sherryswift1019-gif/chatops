export interface JsonSchema {
  type?: string | string[]
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
}

export function generateStubFromSchema(schema: JsonSchema): unknown {
  if (schema.enum && schema.enum.length > 0) return schema.enum[0]
  const type = Array.isArray(schema.type)
    ? schema.type.find(t => t !== 'null') ?? schema.type[0]
    : schema.type
  switch (type) {
    case 'string': return ''
    case 'number': case 'integer': return 0
    case 'boolean': return false
    case 'null': return null
    case 'array': return []
    case 'object': {
      const out: Record<string, unknown> = {}
      const props = schema.properties ?? {}
      for (const [k, sub] of Object.entries(props)) {
        out[k] = generateStubFromSchema(sub)
      }
      return out
    }
    default: return null
  }
}
