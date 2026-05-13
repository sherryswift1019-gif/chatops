import { describe, it, expect } from 'vitest'
import {
  parseBrainstormLlmJson,
  BrainstormLlmParseError,
  parseOptionsFromMarkdown,
  parseFiveSectionMarkdown,
  initBrainstormState,
  rebuildAfterWaiter,
} from '../../pipeline/node-types/llm-brainstorm.js'
import type { BrainstormWaiter } from '../../db/repositories/brainstorm-waiters.js'

describe('parseBrainstormLlmJson', () => {
  it('parses bare JSON', () => {
    const out = parseBrainstormLlmJson('{"decision":"ask","round":1,"question":"hi"}')
    expect(out.decision).toBe('ask')
    expect(out.question).toBe('hi')
  })

  it('parses JSON inside markdown fence', () => {
    const raw = 'some preamble\n```json\n{"decision":"ready","round":3}\n```\ntail'
    const out = parseBrainstormLlmJson(raw)
    expect(out.decision).toBe('ready')
    expect(out.round).toBe(3)
  })

  it('parses JSON with leading/trailing junk by extracting {} block', () => {
    const raw = 'analysis: blah blah {"decision":"fail","round":2} done'
    const out = parseBrainstormLlmJson(raw)
    expect(out.decision).toBe('fail')
  })

  it('throws BrainstormLlmParseError on bad JSON', () => {
    expect(() => parseBrainstormLlmJson('not json at all')).toThrow(BrainstormLlmParseError)
  })

  it('throws BrainstormLlmParseError on schema mismatch', () => {
    expect(() => parseBrainstormLlmJson('{"decision":"yolo"}')).toThrow(BrainstormLlmParseError)
  })

  it('throws on empty', () => {
    expect(() => parseBrainstormLlmJson('')).toThrow(BrainstormLlmParseError)
  })

  it('decision-only with default round', () => {
    const out = parseBrainstormLlmJson('{"decision":"ready"}')
    expect(out.decision).toBe('ready')
    expect(out.round).toBe(1) // default
  })

  it('accepts enrichedInputDelta record', () => {
    const out = parseBrainstormLlmJson('{"decision":"ask","round":2,"question":"...","enrichedInputDelta":{"foo":"bar"}}')
    expect(out.enrichedInputDelta).toEqual({ foo: 'bar' })
  })
})

describe('parseOptionsFromMarkdown', () => {
  it('extracts **A.** style', () => {
    const opts = parseOptionsFromMarkdown('**A.** alpha\n**B.** beta\n')
    expect(opts).toEqual([{ id: 'A', label: 'alpha' }, { id: 'B', label: 'beta' }])
  })

  it('extracts **A：** Chinese colon', () => {
    const opts = parseOptionsFromMarkdown('**A：**alpha\n**B：**beta')
    expect(opts).toHaveLength(2)
  })

  it('extracts list-marker variant - **A.** alpha', () => {
    const opts = parseOptionsFromMarkdown('- **A.** alpha\n- **B.** beta')
    expect(opts).toHaveLength(2)
  })

  it('skips duplicate letters', () => {
    const opts = parseOptionsFromMarkdown('**A.** first\n**A.** dup')
    expect(opts).toHaveLength(1)
  })

  it('returns [] for non-option text', () => {
    expect(parseOptionsFromMarkdown('blah no options here')).toEqual([])
  })

  it('empty string returns []', () => {
    expect(parseOptionsFromMarkdown('')).toEqual([])
  })
})

describe('parseFiveSectionMarkdown adds options[]', () => {
  it('valid 5-section returns options array', () => {
    const md = [
      '## 已查证的现状\nx',
      '## 这一轮要决定\ny',
      '## 选项（带我的推荐）\n**A.** alpha\n**B.** beta',
      '## 我替你做的默认\nA',
      '## 你怎么回？\nA',
    ].join('\n\n')
    const r = parseFiveSectionMarkdown(md)
    expect(r.valid).toBe(true)
    expect(r.options).toHaveLength(2)
    expect(r.options[0].id).toBe('A')
  })

  it('missing options section: valid=false, options=[]', () => {
    const r = parseFiveSectionMarkdown('## 已查证的现状\nx')
    expect(r.valid).toBe(false)
    expect(r.options).toEqual([])
  })
})

describe('rebuildAfterWaiter', () => {
  const makeWaiter = (over: Partial<BrainstormWaiter> = {}): BrainstormWaiter => ({
    id: 1,
    requirementId: 100,
    pipelineRunId: 1000,
    threadId: '1000',
    nodeId: 'spec_brainstorm',
    round: 1,
    questionMd: [
      '## 已查证的现状\nx',
      '## 这一轮要决定\ny',
      '## 选项（带我的推荐）\n**A.** alpha\n**B.** beta',
      '## 我替你做的默认\nA',
      '## 你怎么回？\nA',
    ].join('\n\n'),
    options: [{ id: 'A', label: 'alpha' }, { id: 'B', label: 'beta' }],
    enrichedInput: { actors: ['user'] },
    history: [],
    failedQualityRounds: 0,
    readyForSpec: false,
    status: 'answered',
    source: 'web',
    chosenOption: 'A',
    freeText: null,
    answeredAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date(),
    ...over,
  })

  it('answered waiter advances round + appends history turn', () => {
    const bs0 = initBrainstormState()
    const bs1 = rebuildAfterWaiter(bs0, makeWaiter({ chosenOption: 'A' }))
    expect(bs1.round).toBe(2)
    expect(bs1.history).toHaveLength(1)
    expect(bs1.history[0].answer).toBe('A')
    expect(bs1.history[0].source).toBe('web')
  })

  it('freeText "/done" early-terminates', () => {
    const bs0 = initBrainstormState()
    const bs1 = rebuildAfterWaiter(bs0, makeWaiter({ chosenOption: null, freeText: '/done' }))
    expect(bs1.earlyDone).toBe(true)
    expect(bs1.readyForSpec).toBe(true)
  })

  it('pending waiter does NOT advance state', () => {
    const bs0 = initBrainstormState()
    const bs1 = rebuildAfterWaiter(bs0, makeWaiter({ status: 'pending', chosenOption: null }))
    expect(bs1.round).toBe(1)
    expect(bs1.history).toHaveLength(0)
  })

  it('preserves enriched_input snapshot', () => {
    const bs0 = initBrainstormState()
    const bs1 = rebuildAfterWaiter(bs0, makeWaiter({ enrichedInput: { foo: 'bar' } }))
    expect(bs1.enrichedInput.foo).toBe('bar')
  })
})
