import { describe, it, expect } from 'vitest'
import { extractJsonObject, NotJsonObjectError } from '../../pipeline/json-extract.js'

describe('extractJsonObject', () => {
  it('解析纯 JSON 对象', () => {
    expect(extractJsonObject('{"a": 1, "b": "x"}')).toEqual({ a: 1, b: 'x' })
  })

  it('解析带前后空白的纯 JSON', () => {
    expect(extractJsonObject('  \n{"a": 1}\n  ')).toEqual({ a: 1 })
  })

  it('解析 ```json\\n...\\n``` 包裹的对象', () => {
    const raw = '```json\n{"filename": "x.tar.gz", "downloadUrl": "http://h/y"}\n```'
    expect(extractJsonObject(raw)).toEqual({
      filename: 'x.tar.gz',
      downloadUrl: 'http://h/y',
    })
  })

  it('解析 ```\\n...\\n``` 无 lang 标签的对象', () => {
    const raw = '```\n{"a": 1}\n```'
    expect(extractJsonObject(raw)).toEqual({ a: 1 })
  })

  it('解析带前置散文的 JSON', () => {
    const raw = '根据分析：\n{"a": 1, "nested": {"b": 2}}'
    expect(extractJsonObject(raw)).toEqual({ a: 1, nested: { b: 2 } })
  })

  it('解析 fence + 自然语言前缀混合', () => {
    const raw = '我的答案是：\n```json\n{"ok": true}\n```\n以上。'
    expect(extractJsonObject(raw)).toEqual({ ok: true })
  })

  it('真坏 JSON 抛错（保留 SyntaxError 语义）', () => {
    expect(() => extractJsonObject('not json at all')).toThrow()
  })

  it('空字符串抛错', () => {
    expect(() => extractJsonObject('')).toThrow()
  })

  it('null 抛 NotJsonObjectError', () => {
    expect(() => extractJsonObject('null')).toThrow(NotJsonObjectError)
  })

  it('数组抛 NotJsonObjectError（含 fence 的数组也拒）', () => {
    expect(() => extractJsonObject('[1, 2, 3]')).toThrow(NotJsonObjectError)
    expect(() => extractJsonObject('```json\n[1,2,3]\n```')).toThrow(NotJsonObjectError)
  })

  it('primitive number 抛 NotJsonObjectError', () => {
    expect(() => extractJsonObject('42')).toThrow(NotJsonObjectError)
  })

  it('primitive string 抛 NotJsonObjectError', () => {
    expect(() => extractJsonObject('"hello"')).toThrow(NotJsonObjectError)
  })

  it('boolean 抛 NotJsonObjectError', () => {
    expect(() => extractJsonObject('true')).toThrow(NotJsonObjectError)
  })

  it('NotJsonObjectError 是 Error 子类', () => {
    expect(new NotJsonObjectError('x')).toBeInstanceOf(Error)
  })
})
