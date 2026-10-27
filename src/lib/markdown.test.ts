import { describe, expect, it } from 'vitest'

import { isSqlBlock, parseInline, parseMarkdown } from './markdown'

describe('parseMarkdown', () => {
  it('reads headings, paragraphs, rules and code', () => {
    const blocks = parseMarkdown('## Orders\n\nThere are **42**.\nAll shipped.\n\n---\n```sql\nselect 1\n\nfrom t\n```\nAfter')
    expect(blocks).toEqual([
      { type: 'heading', level: 2, text: 'Orders' },
      { type: 'paragraph', text: 'There are **42**.\nAll shipped.' },
      { type: 'rule' },
      { type: 'code', lang: 'sql', text: 'select 1\n\nfrom t' },
      { type: 'paragraph', text: 'After' },
    ])
  })

  it('keeps an unclosed fence as code to the end', () => {
    expect(parseMarkdown('```\nselect *\nfrom orders')).toEqual([{ type: 'code', lang: '', text: 'select *\nfrom orders' }])
  })

  it('reads nested and loose lists', () => {
    const blocks = parseMarkdown('1. First\n2. Second\n   - a\n   - b\n3. Third\n\n- x\n\n- y\n\nDone')
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: true,
        start: 1,
        items: [
          [{ type: 'paragraph', text: 'First' }],
          [
            { type: 'paragraph', text: 'Second' },
            { type: 'list', ordered: false, start: 1, items: [[{ type: 'paragraph', text: 'a' }], [{ type: 'paragraph', text: 'b' }]] },
          ],
          [{ type: 'paragraph', text: 'Third' }],
        ],
      },
      { type: 'list', ordered: false, start: 1, items: [[{ type: 'paragraph', text: 'x' }], [{ type: 'paragraph', text: 'y' }]] },
      { type: 'paragraph', text: 'Done' },
    ])
  })

  it('accepts two-space nesting under a numbered item', () => {
    const [list] = parseMarkdown('3. Top\n  - sub')
    expect(list).toMatchObject({ type: 'list', start: 3 })
    expect(list.type === 'list' && list.items[0][1]).toMatchObject({ type: 'list', ordered: false })
  })

  it('reads tables with alignment, escaped pipes and code', () => {
    const blocks = parseMarkdown('| status | count |\n|:--|--:|\n| shipped | 10 |\n| `a|b` | x \\| y |\n| short |\n\nNext')
    expect(blocks[0]).toEqual({
      type: 'table',
      align: ['left', 'right'],
      header: ['status', 'count'],
      rows: [
        ['shipped', '10'],
        ['`a|b`', 'x | y'],
        ['short', ''],
      ],
    })
    expect(blocks[1]).toEqual({ type: 'paragraph', text: 'Next' })
  })

  it('reads quotes', () => {
    expect(parseMarkdown('> Note: **cut off**\n> at 100 rows')).toEqual([
      { type: 'quote', blocks: [{ type: 'paragraph', text: 'Note: **cut off**\nat 100 rows' }] },
    ])
  })
})

describe('parseInline', () => {
  it('reads marks, code, links and breaks', () => {
    expect(parseInline('**42** orders, *mostly* `shipped`\n~~none~~ [docs](https://x.y)')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: '42' }] },
      { type: 'text', text: ' orders, ' },
      { type: 'em', children: [{ type: 'text', text: 'mostly' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'shipped' },
      { type: 'break' },
      { type: 'del', children: [{ type: 'text', text: 'none' }] },
      { type: 'text', text: ' ' },
      { type: 'link', children: [{ type: 'text', text: 'docs' }], href: 'https://x.y' },
    ])
  })

  it('leaves snake_case, lone stars and escapes alone', () => {
    expect(parseInline('customer_id and order_id')).toEqual([{ type: 'text', text: 'customer_id and order_id' }])
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }])
    expect(parseInline('\\*not em\\*')).toEqual([{ type: 'text', text: '*not em*' }])
    expect(parseInline('`unclosed')).toEqual([{ type: 'text', text: '`unclosed' }])
  })

  it('nests marks', () => {
    expect(parseInline('**total: *42***')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'total: ' }, { type: 'em', children: [{ type: 'text', text: '42' }] }] },
    ])
  })
})

describe('isSqlBlock', () => {
  it('knows SQL by its tag, or by how an untagged block starts', () => {
    expect(isSqlBlock({ lang: 'sql', text: 'x' })).toBe(true)
    expect(isSqlBlock({ lang: 'postgresql', text: 'x' })).toBe(true)
    expect(isSqlBlock({ lang: '', text: '  SELECT 1' })).toBe(true)
    expect(isSqlBlock({ lang: '', text: 'npm run' })).toBe(false)
    expect(isSqlBlock({ lang: 'bash', text: 'select' })).toBe(false)
  })
})
