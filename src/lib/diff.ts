// What the chat changed in the editor: the smallest edit to make it, and a
// line diff to show it.

/** The range of `before` to replace with `text` to get `after`, keeping the common start and end. */
export function changedRange(before: string, after: string): { from: number; to: number; text: string } {
  const max = Math.min(before.length, after.length)
  let start = 0
  while (start < max && before[start] === after[start]) start++
  let end = 0
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  return { from: start, to: before.length - end, text: after.slice(start, after.length - end) }
}

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }
export type DiffRow = DiffLine | { kind: 'skip'; count: number }

const splitLines = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

/**
 * Line diff of `a` to `b` (longest common subsequence), removals before
 * additions. Null when the changed part is too big to diff quickly.
 */
export function diffLines(a: string, b: string, maxCells = 250_000): DiffLine[] | null {
  const x = splitLines(a)
  const y = splitLines(b)
  let start = 0
  while (start < x.length && start < y.length && x[start] === y[start]) start++
  let endX = x.length
  let endY = y.length
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--
    endY--
  }
  const n = endX - start
  const m = endY - start
  if (n * m > maxCells) return null

  // lcs[i][j]: common lines between x[start + i..endX] and y[start + j..endY].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[start + i] === y[start + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: DiffLine[] = x.slice(0, start).map((text) => ({ kind: 'same', text }))
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[start + i] === y[start + j]) {
      out.push({ kind: 'same', text: x[start + i] })
      i++
      j++
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push({ kind: 'del', text: x[start + i++] })
    } else {
      out.push({ kind: 'add', text: y[start + j++] })
    }
  }
  for (const text of x.slice(endX)) out.push({ kind: 'same', text })
  return out
}

/** The changed lines with `context` unchanged lines around each, the rest folded. */
export function withContext(lines: DiffLine[], context = 2): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, i) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true
  })
  const rows: DiffRow[] = []
  for (let i = 0; i < lines.length; ) {
    if (keep[i]) {
      rows.push(lines[i++])
      continue
    }
    let end = i
    while (end < lines.length && !keep[end]) end++
    // Folding a single line saves nothing.
    if (end - i === 1) rows.push(lines[i])
    else rows.push({ kind: 'skip', count: end - i })
    i = end
  }
  return rows
}
