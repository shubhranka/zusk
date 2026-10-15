import { describe, expect, it } from 'vitest'

import { fixTarget, lineCol } from './fix'
import type { AppError } from './types'

const dbError = (extra: Partial<AppError>): AppError => ({ kind: 'database', message: 'boom', ...extra })

describe('lineCol', () => {
  it('counts lines and columns from 1', () => {
    expect(lineCol('select 1', 0)).toEqual({ line: 1, col: 1 })
    expect(lineCol('select 1\nfrom t', 9)).toEqual({ line: 2, col: 1 })
    expect(lineCol('select 1\nfrom t', 14)).toEqual({ line: 2, col: 6 })
  })
})

describe('fixTarget', () => {
  it('takes a single statement with the error position inside it', () => {
    const sql = 'SELEC * FROM orders'
    expect(fixTarget(sql, dbError({ position: 0, statementRange: [0, sql.length] }))).toEqual({
      from: 0,
      to: sql.length,
      text: sql,
      line: 1,
      col: 1,
    })
  })

  it('takes only the statement that failed in a script', () => {
    const sql = 'select 1;\nselect custmer_id\nfrom orders;'
    const from = sql.indexOf('select custmer_id')
    const to = sql.indexOf(';', from)
    const target = fixTarget(sql, dbError({ position: from + 7, statementRange: [from, to] }))
    expect(target.text).toBe('select custmer_id\nfrom orders')
    expect(target).toMatchObject({ from, to, line: 1, col: 8 })
  })

  it('reports multi-line positions relative to the statement', () => {
    const sql = 'select 1;\nselect id\nfrom orderz'
    const from = 10
    const target = fixTarget(sql, dbError({ position: sql.indexOf('orderz'), statementRange: [from, sql.length] }))
    expect(target).toMatchObject({ line: 2, col: 6 })
  })

  it('falls back to the whole run without a statement range or position', () => {
    const sql = 'select nope'
    expect(fixTarget(sql, dbError({}))).toEqual({ from: 0, to: sql.length, text: sql })
  })
})
