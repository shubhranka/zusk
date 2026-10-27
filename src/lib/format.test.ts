import { describe, expect, it } from 'vitest'

import { formatMs, previewQuery, quoteIdent, relativeTime } from './format'

describe('quoteIdent', () => {
  it('leaves plain names alone and quotes the rest', () => {
    expect(quoteIdent('orders')).toBe('orders')
    expect(quoteIdent('Orders')).toBe('"Orders"')
    expect(quoteIdent('order items')).toBe('"order items"')
    expect(quoteIdent('user')).toBe('"user"')
    expect(quoteIdent('we"ird')).toBe('"we""ird"')
  })
})

describe('previewQuery', () => {
  it('builds the SELECT * … LIMIT 100 the explorer opens', () => {
    expect(previewQuery('public', 'orders')).toBe('SELECT *\nFROM   public.orders\nLIMIT  100;')
    expect(previewQuery('My Schema', 'select')).toContain('FROM   "My Schema"."select"')
  })
})

describe('formatMs / relativeTime', () => {
  it('formats durations', () => {
    expect(formatMs(0.4)).toBe('<1 ms')
    expect(formatMs(12.3)).toBe('12 ms')
    expect(formatMs(1534)).toBe('1.53 s')
  })
  it('formats edit times like the design', () => {
    const now = Date.UTC(2026, 9, 8)
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 days ago')
    expect(relativeTime(now - 8 * 86_400_000, now)).toBe('last week')
    expect(relativeTime(now - 10_000, now)).toBe('just now')
  })
})
