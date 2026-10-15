import { describe, expect, it } from 'vitest'

import { changedRange, diffLines, withContext, type DiffLine } from './diff'

const apply = (before: string, r: { from: number; to: number; text: string }) => before.slice(0, r.from) + r.text + before.slice(r.to)

describe('changedRange', () => {
  it('replaces only the part that differs', () => {
    const before = 'select * from orders\nwhere total > 10\n'
    const after = 'select * from orders\nwhere total > 100\norder by id\n'
    const r = changedRange(before, after)
    expect(r.from).toBe(before.indexOf('10') + 2)
    expect(apply(before, r)).toBe(after)
  })

  it('handles insertions, deletions, empty sides and repeats', () => {
    for (const [before, after] of [
      ['', 'select 1'],
      ['select 1', ''],
      ['select 1', 'select 1'],
      ['aaaa', 'aa'],
      ['ab', 'aXb'],
      ['select 1;\nselect 1;', 'select 1;'],
    ]) {
      expect(apply(before, changedRange(before, after))).toBe(after)
    }
    expect(changedRange('same', 'same')).toEqual({ from: 4, to: 4, text: '' })
  })
})

const kinds = (lines: DiffLine[] | null) => lines?.map((l) => `${{ same: ' ', add: '+', del: '-' }[l.kind]}${l.text}`)

describe('diffLines', () => {
  it('marks changed lines, removals first', () => {
    const before = 'select *\nfrom orders\nwhere total > 10\nlimit 5'
    const after = 'select id, total\nfrom orders\nwhere total > 10\n  and paid\nlimit 5'
    expect(kinds(diffLines(before, after))).toEqual([
      '-select *',
      '+select id, total',
      ' from orders',
      ' where total > 10',
      '+  and paid',
      ' limit 5',
    ])
  })

  it('treats an empty editor as no lines and ignores a trailing newline', () => {
    expect(kinds(diffLines('', 'select 1\n'))).toEqual(['+select 1'])
    expect(kinds(diffLines('select 1\n', 'select 1'))).toEqual([' select 1'])
  })

  it('gives up on changes too big to diff quickly', () => {
    const many = (p: string) => Array.from({ length: 50 }, (_, i) => `${p}${i}`).join('\n')
    expect(diffLines(many('a'), many('b'), 100)).toBeNull()
    expect(diffLines(many('a'), many('b'))).toHaveLength(100)
  })
})

describe('withContext', () => {
  it('folds unchanged runs, but never a single line', () => {
    const lines = diffLines(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'H'].join('\n'))!
    expect(withContext(lines, 2)).toEqual([
      { kind: 'skip', count: 5 },
      { kind: 'same', text: 'f' },
      { kind: 'same', text: 'g' },
      { kind: 'del', text: 'h' },
      { kind: 'add', text: 'H' },
    ])
    const short = diffLines('a\nb\nc\nd', 'a\nb\nc\nD')!
    expect(withContext(short, 2).map((r) => r.kind)).toEqual(['same', 'same', 'same', 'del', 'add'])
  })
})
