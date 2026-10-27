import type { ResultColumn, ValueKind } from './types'

/** Text shown in a grid cell. Postgres sends booleans as t/f. */
export function displayValue(value: string | null, kind: ValueKind): string {
  if (value === null) return 'NULL'
  if (kind === 'bool') return value === 't' ? 'true' : value === 'f' ? 'false' : value
  return value
}

/** Client-side row filter: case-insensitive substring match on any cell. */
export function filterRows(rows: (string | null)[][], columns: ResultColumn[], filter: string): (string | null)[][] {
  const needle = filter.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((row) =>
    row.some((v, i) => v !== null && displayValue(v, columns[i]?.kind ?? 'text').toLowerCase().includes(needle)),
  )
}

/** A row as tab-separated values (NULL becomes an empty field), for spreadsheets. */
export function rowAsTsv(row: (string | null)[], columns: ResultColumn[]): string {
  return row.map((v, i) => (v === null ? '' : displayValue(v, columns[i].kind).replace(/[\t\n\r]+/g, ' '))).join('\t')
}

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * A row as a JSON object. Numbers are written exactly as Postgres sent them
 * (no float rounding of numeric/int8), json/jsonb values are embedded as JSON.
 */
export function rowAsJson(row: (string | null)[], columns: ResultColumn[]): string {
  const fields = columns.map((c, i) => {
    const v = row[i]
    let value: string
    if (v === null) value = 'null'
    else if (c.kind === 'bool' && (v === 't' || v === 'f')) value = v === 't' ? 'true' : 'false'
    else if (c.kind === 'num' && JSON_NUMBER.test(v)) value = v
    else if (c.kind === 'json' && isJson(v)) value = v
    else value = JSON.stringify(v)
    return `  ${JSON.stringify(c.name)}: ${value}`
  })
  return `{\n${fields.join(',\n')}\n}`
}
