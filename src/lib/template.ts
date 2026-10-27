// Jinja templating helpers. Rendering itself happens in Rust
// (src-tauri/src/template.rs); this side keeps the variables and shows errors.

import { lineCol } from './fix'

/** The JSON object of template variables, as sent to render_template. */
export type TemplateVars = Record<string, unknown>

export const DEFAULT_TEMPLATE_VARS = `{
  "from_dttm": null,
  "to_dttm": null,
  "filters": {},
  "url_params": {}
}
`

export type ParsedVars = { ok: true; vars: TemplateVars } | { ok: false; error: string }

/** Parses the variables editor's text, which must be a JSON object. */
export function parseTemplateVars(text: string): ParsedVars {
  if (!text.trim()) return { ok: true, vars: {} }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Template variables aren’t valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Template variables must be a JSON object, like { "filters": {} }.' }
  }
  return { ok: true, vars: value as TemplateVars }
}

/** True when `sql` has Jinja tags: {{ … }}, {% … %} or {# … #}. */
export function looksLikeTemplate(sql: string): boolean {
  return /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/.test(sql)
}

export interface Excerpt {
  /** 1-based position of `offset`. */
  line: number
  col: number
  lines: { n: number; text: string }[]
}

/** The lines of `text` around `offset`, to show where an error is. */
export function excerpt(text: string, offset: number, before = 2, after = 1): Excerpt {
  const { line, col } = lineCol(text, Math.min(offset, text.length))
  const all = text.split('\n')
  const first = Math.max(1, line - before)
  const last = Math.min(all.length, line + after)
  const lines = all.slice(first - 1, last).map((t, i) => ({ n: first + i, text: t }))
  return { line, col, lines }
}
