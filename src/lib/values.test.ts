import { describe, expect, it } from 'vitest'

import type { ResultColumn } from './types'
import { displayValue, filterRows, rowAsJson, rowAsTsv } from './values'

const cols: ResultColumn[] = [
  { name: 'id', typeName: 'int8', kind: 'num' },
  { name: 'active', typeName: 'bool', kind: 'bool' },
  { name: 'meta', typeName: 'jsonb', kind: 'json' },
  { name: 'note', typeName: 'text', kind: 'text' },
  { name: 'ratio', typeName: 'float8', kind: 'num' },
]

describe('displayValue', () => {
  it('renders NULL and booleans like the design', () => {
    expect(displayValue(null, 'text')).toBe('NULL')
    expect(displayValue('t', 'bool')).toBe('true')
    expect(displayValue('f', 'bool')).toBe('false')
    expect(displayValue('12.50', 'num')).toBe('12.50')
  })
})

describe('filterRows', () => {
  const rows = [
    ['1', 't', '{"a":1}', 'Hello', '0.5'],
    ['2', 'f', null, 'world', 'NaN'],
  ]
  it('matches any cell, case-insensitively, using displayed text', () => {
    expect(filterRows(rows, cols, 'HELLO')).toHaveLength(1)
    expect(filterRows(rows, cols, 'false')).toEqual([rows[1]])
    expect(filterRows(rows, cols, '  ')).toBe(rows)
  })
  it('never matches NULL', () => {
    expect(filterRows(rows, cols, 'null')).toHaveLength(0)
  })
})

describe('row copy formats', () => {
  const row = ['9007199254740993', 't', '{"tags": ["a"]}', 'tab\there', 'NaN']
  it('keeps exact numbers and embeds json in JSON output', () => {
    const json = rowAsJson(row, cols)
    expect(json).toContain('"id": 9007199254740993')
    expect(json).toContain('"meta": {"tags": ["a"]}')
    expect(json).toContain('"ratio": "NaN"')
    expect(JSON.parse(json).active).toBe(true)
  })
  it('writes TSV with NULL as an empty field', () => {
    expect(rowAsTsv(['1', null, 'x\ty'], cols.slice(0, 3))).toBe('1\t\tx y')
  })
})
