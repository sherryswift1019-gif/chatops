// src/e2e/pipeline-b/playbook/parse.ts
import YAML from 'yaml'
import { ZodError } from 'zod'
import { playbookSchema, type Playbook } from './types.js'
import { manifestSchema, type Manifest } from './manifest.js'

export interface ParseError {
  ok: false
  error: string
  issues?: Array<{ path: string; message: string }>
}

export interface ParseOk<T> {
  ok: true
  value: T
}

export type ParseResult<T> = ParseOk<T> | ParseError

function formatZodError(err: ZodError): ParseError {
  return {
    ok: false,
    error: 'schema 校验失败',
    issues: err.issues.map((i) => ({
      path: i.path.map(String).join('.') || '(root)',
      message: i.message,
    })),
  }
}

export function parsePlaybookYaml(content: string): ParseResult<Playbook> {
  let raw: unknown
  try {
    raw = YAML.parse(content)
  } catch (e) {
    return { ok: false, error: `YAML 解析失败: ${(e as Error).message}` }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'playbook 顶层必须是对象' }
  }
  const result = playbookSchema.safeParse(raw)
  if (!result.success) return formatZodError(result.error)
  return { ok: true, value: result.data }
}

export function validatePlaybook(raw: unknown): ParseResult<Playbook> {
  const result = playbookSchema.safeParse(raw)
  if (!result.success) return formatZodError(result.error)
  return { ok: true, value: result.data }
}

export function parseManifestJson(content: string): ParseResult<Manifest> {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (e) {
    return { ok: false, error: `JSON 解析失败: ${(e as Error).message}` }
  }
  const result = manifestSchema.safeParse(raw)
  if (!result.success) return formatZodError(result.error)
  return { ok: true, value: result.data }
}

export function validateManifest(raw: unknown): ParseResult<Manifest> {
  const result = manifestSchema.safeParse(raw)
  if (!result.success) return formatZodError(result.error)
  return { ok: true, value: result.data }
}
