import type { AppError } from './types'

/** 1-based line and column of `offset` in `text`. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return { line, col: offset - before.lastIndexOf('\n') }
}

export interface FixTarget {
  /** Range of the failing statement within the SQL that was run. */
  from: number
  to: number
  text: string
  /** Where the error points, relative to the statement. */
  line?: number
  col?: number
}

/**
 * The statement "Fix with AI" should rewrite: the one that failed (from the
 * error's statementRange), or the whole run when the error doesn't say.
 * Offsets are UTF-16, like JS string indices.
 */
export function fixTarget(sql: string, error: AppError): FixTarget {
  const [from, to] = error.statementRange ?? [0, sql.length]
  const text = sql.slice(from, to)
  const position = error.position != null && error.position >= from && error.position <= to ? error.position - from : undefined
  return { from, to, text, ...(position != null ? lineCol(text, position) : {}) }
}
