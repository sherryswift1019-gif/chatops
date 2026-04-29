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

  // ---- 多 markdown fence 场景（PAM Proxy run-11 stage-5 实战：散文 + bash fence + json fence）----

  it('多 fence：散文 + ```bash``` 非 JSON block + 末尾 ```json``` JSON block → 取末尾 JSON', () => {
    // 关键设计：bash block 内有 `{...}` 字面（make sure first/last `{}` 兜底
    // 不会误把 bash 内容当 JSON 抓走），强制走步骤 2 的 fence 迭代。
    const raw = [
      '根据日志分析故障，以下是诊断步骤：',
      '',
      '```bash',
      'ssh root@host "systemctl status app | grep -E \'\\{.*\\}\'"',
      '```',
      '',
      '建议执行：',
      '',
      '```bash',
      'ssh root@host "echo {ok: yes}"',
      '```',
      '',
      '最终输出：',
      '',
      '```json',
      '{"intent": "restart", "service": "app", "confidence": 0.92}',
      '```',
    ].join('\n')
    expect(extractJsonObject(raw)).toEqual({
      intent: 'restart',
      service: 'app',
      confidence: 0.92,
    })
  })

  it('多个 ```json``` fence：返回第一个 parse 成功的对象', () => {
    // 让兜底步骤 3 救不了：raw 里 first `{` 在第一个 json fence，last `}` 在
    // 第二个 json fence —— substring 横跨 ` ``` second attempt: ``` ` 散文，
    // 不是合法 JSON。所以必须靠步骤 2 的 fence 迭代取第一个能 parse 的。
    const raw = [
      'first attempt:',
      '```json',
      '{"a": 1}',
      '```',
      'second attempt:',
      '```json',
      '{"b": 2}',
      '```',
    ].join('\n')
    expect(extractJsonObject(raw)).toEqual({ a: 1 })
  })

  it('回归：散文 + 单 ```json``` fence 仍取该 fence 内容（multi-fence 修法不退化单 fence 路径）', () => {
    const raw = '说明：\n```json\n{"k": "v"}\n```\n以上。'
    expect(extractJsonObject(raw)).toEqual({ k: 'v' })
  })

  it('多 fence：bash fence 内容里有看似 JSON 的字面 `{...}` 也不会被错认（避免 first/last `{}` 兜底误抓）', () => {
    // 关键防御：步骤 3 的 first `{` to last `}` 兜底容易把散文里的 `{{x}}` /
    // bash 中 `{` 抓进来，必须在步骤 2 的 fence 迭代里就能找到 json fence。
    const raw = [
      'analysis: see `{{triggerParams.foo}}` reference and {bracket} note',
      '```bash',
      'echo "{not json}"',
      '```',
      'final answer:',
      '```json',
      '{"ok": true, "n": 3}',
      '```',
    ].join('\n')
    expect(extractJsonObject(raw)).toEqual({ ok: true, n: 3 })
  })
})
