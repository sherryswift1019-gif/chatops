import { describe, it, expect } from 'vitest'
import { parseBrainstormAnswer } from '../../pipeline/im-input-agent.js'

describe('parseBrainstormAnswer', () => {
  it('extracts chosenOption from single-letter reply', () => {
    expect(parseBrainstormAnswer('A')).toEqual({ chosenOption: 'A' })
  })

  it('uppercases lowercase letter', () => {
    expect(parseBrainstormAnswer('b ')).toEqual({ chosenOption: 'B' })
  })

  it('extracts both option and freeText for "A 但 ..."', () => {
    expect(parseBrainstormAnswer('A 但默认勾选'))
      .toEqual({ chosenOption: 'A', freeText: '但默认勾选' })
  })

  it('handles "A, freetext" with comma', () => {
    expect(parseBrainstormAnswer('A，但默认勾选'))
      .toEqual({ chosenOption: 'A', freeText: '但默认勾选' })
  })

  it('passes through pure freeText when no option ID', () => {
    expect(parseBrainstormAnswer('都不对，我想要 XX'))
      .toEqual({ freeText: '都不对，我想要 XX' })
  })

  it('detects /done command as freeText', () => {
    expect(parseBrainstormAnswer('/done')).toEqual({ freeText: '/done' })
  })

  it('trims whitespace', () => {
    expect(parseBrainstormAnswer('  A  ')).toEqual({ chosenOption: 'A' })
  })

  it('handles empty input', () => {
    expect(parseBrainstormAnswer('')).toEqual({ freeText: '' })
  })
})
