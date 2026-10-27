// A small Markdown parser for the agent's answers: headings, paragraphs,
// lists, GitHub tables, block quotes, fenced code and the usual inline marks.
// It builds a tree that React renders, so no HTML from the model ever
// reaches the page.

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'table'; align: Align[]; header: string[]; rows: string[][] }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'rule' }

export type Align = 'left' | 'center' | 'right' | null

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  | { type: 'link'; children: Inline[]; href: string }
  | { type: 'break' }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}>\s?/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const indentOf = (line: string) => line.length - line.trimStart().length
const isBlank = (line: string | undefined) => line == null || !line.trim()

function startsTable(lines: string[], i: number): boolean {
  return lines[i].includes('|') && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1]) && lines[i + 1].includes('-')
}

/** Whether a line can't continue a paragraph because it starts another block. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || startsTable(lines, i)
}

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'))
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const indent = indentOf(line)
      const code: string[] = []
      i++
      // Runs to the closing fence, or the end of the text.
      while (i < lines.length && !(lines[i].trim().startsWith(marker) && lines[i].trim().replace(new RegExp(`^${marker[0]}+`), '') === '')) {
        code.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))))
        i++
      }
      i++
      blocks.push({ type: 'code', lang: fence[2].toLowerCase(), text: code.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      i++
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }

    if (startsTable(lines, i)) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]).map((cell): Align => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        return left && right ? 'center' : right ? 'right' : left ? 'left' : null
      })
      i += 2
      const rows: string[][] = []
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        const cells = splitRow(lines[i])
        rows.push(header.map((_, c) => cells[c] ?? ''))
        i++
      }
      blocks.push({ type: 'table', align: header.map((_, c) => align[c] ?? null), header, rows })
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(QUOTE, ''))
        i++
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(quoted) })
      continue
    }

    if (ITEM.test(line)) {
      i = parseList(lines, i, blocks)
      continue
    }

    const paragraph = [line.trim()]
    i++
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
      paragraph.push(lines[i].trim())
      i++
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
  }
  return blocks
}

/** Parses the list starting at line `i` into `blocks`; returns the line after it. */
function parseList(lines: string[], i: number, blocks: Block[]): number {
  const first = ITEM.exec(lines[i])!
  const base = first[1].length
  const ordered = /\d/.test(first[2])
  const items: Block[][] = []

  while (i < lines.length) {
    const item = ITEM.exec(lines[i])
    if (!item || item[1].length !== base || /\d/.test(item[2]) !== ordered) break
    const contentIndent = base + item[2].length + 1
    const content = [item[3]]
    i++
    while (i < lines.length) {
      const line = lines[i]
      if (isBlank(line)) {
        // A blank line continues the item only if indented text follows.
        let next = i + 1
        while (next < lines.length && isBlank(lines[next])) next++
        if (next < lines.length && indentOf(lines[next]) >= contentIndent) {
          content.push('')
          i = next
          continue
        }
        if (next < lines.length && ITEM.test(lines[next]) && indentOf(lines[next]) === base) i = next
        break
      }
      const indent = indentOf(line)
      if (indent >= contentIndent || (indent > base && ITEM.test(line))) {
        content.push(line.slice(Math.min(indent, contentIndent)))
      } else if (!startsBlock(lines, i)) {
        // A lazy continuation of the item's text.
        content.push(line.trim())
      } else {
        break
      }
      i++
    }
    items.push(parseBlocks(content))
    if (isBlank(lines[i - 1]) && !(i < lines.length && ITEM.test(lines[i]) && indentOf(lines[i]) === base)) break
  }

  blocks.push({ type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items })
  return i
}

/** The cells of a table row, honouring \| and pipes inside `code`. */
function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\' && text[i + 1] === '|') {
      cell += '|'
      i++
    } else if (c === '`') {
      inCode = !inCode
      cell += c
    } else if (c === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += c
    }
  }
  cells.push(cell.trim())
  return cells
}

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let plain = ''
  const flush = () => {
    if (plain) out.push({ type: 'text', text: plain })
    plain = ''
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]

    if (c === '\\' && i + 1 < text.length && PUNCTUATION.test(text[i + 1])) {
      plain += text[i + 1]
      i += 2
      continue
    }

    if (c === '\n') {
      flush()
      out.push({ type: 'break' })
      i++
      continue
    }

    if (c === '`') {
      let run = 1
      while (text[i + run] === '`') run++
      const ticks = '`'.repeat(run)
      const end = text.indexOf(ticks, i + run)
      if (end > 0) {
        flush()
        const code = text.slice(i + run, end)
        out.push({ type: 'code', text: code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code })
        i = end + run
        continue
      }
      plain += ticks
      i += run
      continue
    }

    const mark = emphasis(text, i)
    if (mark) {
      flush()
      out.push({ type: mark.type, children: parseInline(mark.inner) })
      i = mark.end
      continue
    }

    if (c === '[') {
      const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(i))
      if (link) {
        flush()
        out.push({ type: 'link', children: parseInline(link[1]), href: link[2] })
        i += link[0].length
        continue
      }
    }

    plain += c
    i++
  }
  flush()
  return out
}

const MARKS: [string, 'strong' | 'em' | 'del'][] = [
  ['**', 'strong'],
  ['__', 'strong'],
  ['~~', 'del'],
  ['*', 'em'],
  ['_', 'em'],
]

/** A **strong**, *em* or ~~del~~ span starting at `i`, if one closes. */
function emphasis(text: string, i: number): { type: 'strong' | 'em' | 'del'; inner: string; end: number } | null {
  for (const [marker, type] of MARKS) {
    if (!text.startsWith(marker, i)) continue
    const after = text[i + marker.length]
    if (after == null || /\s/.test(after)) continue
    // snake_case words aren't emphasis.
    if (marker[0] === '_' && i > 0 && /\w/.test(text[i - 1])) continue
    let from = i + marker.length + 1
    while (from <= text.length) {
      let end = text.indexOf(marker, from)
      if (end < 0) break
      // In "***" closing "**", the inner "*" closes first: **a *b***.
      while (marker.length === 2 && text[end + 2] === marker[0]) end++
      const doubled = marker.length === 1 && text[end + 1] === marker
      const closes = !/\s/.test(text[end - 1]) && !doubled && !(marker[0] === '_' && /\w/.test(text[end + marker.length] ?? ''))
      if (closes) return { type, inner: text.slice(i + marker.length, end), end: end + marker.length }
      from = end + (doubled ? 2 : 1)
    }
  }
  return null
}

const SQL_LANGS = new Set(['sql', 'postgresql', 'postgres', 'pgsql', 'psql', 'plpgsql'])

/** Whether a code block holds SQL the editor can open. */
export function isSqlBlock(block: { lang: string; text: string }): boolean {
  if (SQL_LANGS.has(block.lang)) return true
  return !block.lang && /^\s*(select|with|explain|show|values|table)\b/i.test(block.text)
}
