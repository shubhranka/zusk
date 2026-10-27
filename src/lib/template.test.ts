import { describe, expect, it } from 'vitest'

import { DEFAULT_TEMPLATE_VARS, excerpt, looksLikeTemplate, parseTemplateVars } from './template'

describe('parseTemplateVars', () => {
  it('accepts a JSON object, and blank as empty', () => {
    expect(parseTemplateVars(DEFAULT_TEMPLATE_VARS)).toEqual({
      ok: true,
      vars: { from_dttm: null, to_dttm: null, filters: {}, url_params: {} },
    })
    expect(parseTemplateVars('  ')).toEqual({ ok: true, vars: {} })
  })

  it('rejects bad JSON and non-objects', () => {
    expect(parseTemplateVars('{ "a": ').ok).toBe(false)
    expect(parseTemplateVars('[1]').ok).toBe(false)
    expect(parseTemplateVars('null').ok).toBe(false)
  })
})

describe('looksLikeTemplate', () => {
  it('spots Jinja tags but not jsonb paths', () => {
    expect(looksLikeTemplate("SELECT '{{ x }}'")).toBe(true)
    expect(looksLikeTemplate('{% if a %}1{% endif %}')).toBe(true)
    expect(looksLikeTemplate('{# note #} SELECT 1')).toBe(true)
    expect(looksLikeTemplate("SELECT payload #> '{a,b}', '{x}'::text[]")).toBe(false)
  })
})

describe('excerpt', () => {
  it('returns the lines around an offset', () => {
    const text = 'a\nb\nc error\nd\ne'
    expect(excerpt(text, text.indexOf('error'))).toEqual({
      line: 3,
      col: 3,
      lines: [
        { n: 1, text: 'a' },
        { n: 2, text: 'b' },
        { n: 3, text: 'c error' },
        { n: 4, text: 'd' },
      ],
    })
    expect(excerpt('only', 0).lines).toEqual([{ n: 1, text: 'only' }])
  })
})
