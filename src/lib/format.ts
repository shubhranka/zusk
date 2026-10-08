const grouped = new Intl.NumberFormat('en-US')

export function formatCount(n: number | null | undefined): string {
  return n == null ? '—' : grouped.format(n)
}

export function formatMs(ms: number): string {
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`
}

/** "just now", "5 minutes ago", "2 days ago", "last week", … */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - timestamp) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return m === 1 ? 'a minute ago' : `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  if (d < 14) return 'last week'
  if (d < 31) return `${Math.round(d / 7)} weeks ago`
  return new Date(timestamp).toLocaleDateString()
}

/** Postgres reports "UTF8"; people read "UTF-8". */
export function formatEncoding(enc: string): string {
  return enc === 'UTF8' ? 'UTF-8' : enc
}

const PLAIN_IDENT = /^[a-z_][a-z0-9_$]*$/

const RESERVED = new Set(
  ('all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create ' +
    'current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc ' +
    'distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral ' +
    'leading limit localtime localtimestamp not null offset on only or order placing primary references returning ' +
    'select session_user some symmetric system_user table then to trailing true union unique user using variadic when ' +
    'where window with').split(' '),
)

/** Quotes an identifier only when Postgres needs it to. */
export function quoteIdent(name: string): string {
  if (PLAIN_IDENT.test(name) && !RESERVED.has(name)) return name
  return `"${name.replace(/"/g, '""')}"`
}

export function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}

/** The query opened when a table or view is picked in the explorer. */
export function previewQuery(schema: string, name: string): string {
  return `SELECT *\nFROM   ${qualified(schema, name)}\nLIMIT  100;`
}
