import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { copyText } from '../../lib/clipboard'
import { formatCount } from '../../lib/format'
import { isMac, MOD } from '../../lib/platform'
import type { ResultColumn } from '../../lib/types'
import { displayValue, rowAsJson, rowAsTsv } from '../../lib/values'
import { useApp } from '../../store/app'

type Row = (string | null)[]

interface Props {
  columns: ResultColumn[]
  /** Rows to show (after the client-side filter). */
  rows: Row[]
  /** Every row of the result, used to size columns. */
  allRows: Row[]
  filtering: boolean
  dimmed: boolean
}

// JetBrains Mono advances 0.6em: 13px values, 11px type labels.
const CH = 7.8
const CH_SMALL = 6.6
const MIN_W = 56
const MAX_W = 440
const OVERSCAN = 10
const MAX_RENDERED_CHARS = 400

function columnWidths(columns: ResultColumn[], rows: Row[], pad: number): number[] {
  const sample = rows.length > 400 ? rows.slice(0, 400) : rows
  return columns.map((c, i) => {
    let longest = 0
    for (const row of sample) {
      const len = displayValue(row[i], c.kind).length
      if (len > longest) longest = len
    }
    const header = c.name.length * CH + (c.typeName ? 8 + c.typeName.length * CH_SMALL : 0)
    const content = Math.min(longest, 56) * CH
    return Math.round(Math.min(MAX_W, Math.max(MIN_W, header, content) + pad + 2))
  })
}

interface Cell {
  r: number
  c: number
}

export function ResultsGrid({ columns, rows, allRows, filtering, dimmed }: Props) {
  const density = useApp((s) => s.settings.density)
  const zebra = useApp((s) => s.settings.zebra)
  const toast = useApp((s) => s.toast)
  const setRowFilter = useApp((s) => s.setRowFilter)

  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)
  const [sel, setSel] = useState<Cell | null>(null)
  const [menu, setMenu] = useState<(Cell & { x: number; y: number }) | null>(null)

  const rowH = density === 'compact' ? 33 : 41
  const pad = density === 'compact' ? 24 : 32
  // Sized from the unfiltered result, so filtering never makes columns jump.
  const widths = useMemo(() => columnWidths(columns, allRows, pad), [columns, allRows, pad])
  const numW = Math.max(48, String(rows.length).length * CH + pad + 4)
  const tableWidth = numW + widths.reduce((a, b) => a + b, 0)

  useLayoutEffect(() => {
    const el = scroller.current!
    const ro = new ResizeObserver(() => setViewport(el.clientHeight))
    ro.observe(el)
    setViewport(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // New result: back to the top. New filter: keep position but drop the selection.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0, left: 0 })
    setScrollTop(0)
  }, [columns])
  useEffect(() => {
    setSel(null)
    setMenu(null)
  }, [rows])

  // Hand focus back to the grid so arrow keys and copy shortcuts keep working.
  const closeMenu = useCallback(() => {
    setMenu(null)
    scroller.current?.focus({ preventScroll: true })
  }, [])

  const total = rows.length
  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / rowH) + OVERSCAN)

  const copy = (text: string, done: string) =>
    copyText(text).then(
      () => toast(done),
      () => toast('Couldn’t copy to the clipboard', 'danger'),
    )
  const copyCell = (cell: Cell) => {
    const col = columns[cell.c]
    void copy(displayValue(rows[cell.r][cell.c], col.kind), `Copied ${col.name}`)
  }
  const copyRow = (r: number, as: 'tsv' | 'json') => {
    const text = as === 'tsv' ? rowAsTsv(rows[r], columns) : rowAsJson(rows[r], columns)
    void copy(text, as === 'tsv' ? `Copied row ${formatCount(r + 1)}` : `Copied row ${formatCount(r + 1)} as JSON`)
  }

  const scrollCellIntoView = ({ r, c }: Cell) => {
    const el = scroller.current
    if (!el) return
    const top = r * rowH
    const head = rowH
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + rowH > el.scrollTop + el.clientHeight - head) el.scrollTop = top + rowH + head - el.clientHeight
    const left = numW + widths.slice(0, c).reduce((a, b) => a + b, 0)
    const right = left + widths[c]
    if (left - numW < el.scrollLeft) el.scrollLeft = left - numW
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = isMac ? e.metaKey : e.ctrlKey
    if (mod && e.key.toLowerCase() === 'c' && sel) {
      e.preventDefault()
      if (e.shiftKey) copyRow(sel.r, 'tsv')
      else copyCell(sel)
      return
    }
    if (e.key === 'Escape') {
      setSel(null)
      return
    }
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    const move = moves[e.key]
    if (!move || total === 0) return
    e.preventDefault()
    const from = sel ?? { r: 0, c: 0 }
    const next = sel
      ? { r: Math.min(total - 1, Math.max(0, from.r + move[0])), c: Math.min(columns.length - 1, Math.max(0, from.c + move[1])) }
      : from
    setSel(next)
    scrollCellIntoView(next)
  }

  return (
    <div
      ref={scroller}
      className={dimmed ? 'grid-scroll dimmed' : 'grid-scroll'}
      tabIndex={0}
      role="region"
      aria-label={`Results, ${formatCount(total)} rows`}
      onScroll={(e) => {
        setScrollTop(e.currentTarget.scrollTop)
        if (menu) setMenu(null)
      }}
      onKeyDown={onKeyDown}
    >
      <table className="grid" style={{ width: tableWidth, minWidth: '100%' }} aria-rowcount={total + 1}>
        <colgroup>
          <col style={{ width: numW }} />
          {widths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
          <col />
        </colgroup>
        <thead>
          <tr>
            <th className="num-col">#</th>
            {columns.map((c, i) => (
              <th key={i} title={c.typeName ? `${c.name} · ${c.typeName}` : c.name}>
                <span className="head">
                  <span className="col-name">{c.name}</span>
                  {c.typeName && <span className="col-type">{c.typeName}</span>}
                </span>
              </th>
            ))}
            <th className="filler" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {start > 0 && (
            <tr className="spacer" aria-hidden>
              <td colSpan={columns.length + 2} style={{ height: start * rowH }} />
            </tr>
          )}
          {rows.slice(start, end).map((row, i) => {
            const r = start + i
            return (
              <tr key={r} className={zebra && r % 2 === 1 ? 'zebra' : undefined} aria-rowindex={r + 2}>
                <td className="num-col">{r + 1}</td>
                {row.map((v, c) => {
                  const kind = columns[c]?.kind ?? 'text'
                  const text = displayValue(v, kind)
                  const selected = sel?.r === r && sel.c === c
                  const cls = (v === null ? 'v-null' : `v-${kind}`) + (selected ? ' selected' : '')
                  return (
                    <td
                      key={c}
                      className={cls}
                      title={text.length > 40 ? text.slice(0, 2000) : undefined}
                      onMouseDown={(e) => {
                        if (e.button === 0) setSel({ r, c })
                      }}
                      onDoubleClick={() => copyCell({ r, c })}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setSel({ r, c })
                        setMenu({ r, c, x: e.clientX, y: e.clientY })
                      }}
                    >
                      {text.length > MAX_RENDERED_CHARS ? text.slice(0, MAX_RENDERED_CHARS) + '…' : text}
                    </td>
                  )
                })}
                <td className="filler" aria-hidden />
              </tr>
            )
          })}
          {end < total && (
            <tr className="spacer" aria-hidden>
              <td colSpan={columns.length + 2} style={{ height: (total - end) * rowH }} />
            </tr>
          )}
        </tbody>
      </table>
      {total === 0 && <p className="grid-empty">{filtering ? 'No rows match that filter.' : 'The query returned no rows.'}</p>}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            { label: 'Copy value', hint: `${MOD}C`, run: () => copyCell(menu) },
            { label: 'Copy row', hint: `⇧${MOD}C`, run: () => copyRow(menu.r, 'tsv') },
            { label: 'Copy row as JSON', run: () => copyRow(menu.r, 'json') },
            { label: 'Copy column name', run: () => void copy(columns[menu.c].name, 'Copied column name') },
            'separator',
            {
              label: 'Filter rows by this value',
              run: () => setRowFilter(displayValue(rows[menu.r][menu.c], columns[menu.c].kind)),
              disabled: rows[menu.r][menu.c] === null,
            },
          ]}
        />
      )}
    </div>
  )
}

type MenuItem = { label: string; hint?: string; run(): void; disabled?: boolean } | 'separator'

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current!
    const { width, height } = el.getBoundingClientRect()
    setPos({ left: Math.min(x, window.innerWidth - width - 8), top: Math.min(y, window.innerHeight - height - 8) })
    el.querySelector('button')?.focus()
  }, [x, y])

  useEffect(() => {
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <ul ref={ref} className="context-menu" role="menu" style={pos} onKeyDown={(e) => e.stopPropagation()}>
      {items.map((item, i) =>
        item === 'separator' ? (
          <li key={i} role="separator">
            <hr />
          </li>
        ) : (
          <li key={i} role="none">
            <button
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.run()
                onClose()
              }}
            >
              {item.label}
              {item.hint && <span className="kbd-hint">{item.hint}</span>}
            </button>
          </li>
        ),
      )}
    </ul>
  )
}
