import { useEffect, useMemo, useRef, useState } from 'react'

import { shortcut } from '../lib/platform'
import type { RelationRef } from '../lib/types'
import { useApp } from '../store/app'
import { SearchIcon, TableIcon, ViewIcon } from './Icons'

type Item =
  | { kind: 'relation'; key: string; relation: RelationRef }
  | { kind: 'saved'; key: string; id: string; name: string }

function score(text: string, needle: string): number {
  const name = text.toLowerCase()
  if (name === needle) return 0
  if (name.startsWith(needle)) return 1
  if (name.includes(needle)) return 2
  return -1
}

export function JumpBox() {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const [relations, setRelations] = useState<RelationRef[]>([])
  const activeId = useApp((s) => s.activeId)
  const connected = useApp((s) => (s.activeId ? s.conns[s.activeId]?.status === 'connected' : false))
  const relationsCache = useApp((s) => (s.activeId ? s.tree[s.activeId]?.relations : undefined))
  const saved = useApp((s) => s.saved)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (!open || !activeId || !connected) return
    if (relationsCache) {
      setRelations(relationsCache)
      return
    }
    useApp
      .getState()
      .loadRelations(activeId)
      .then(setRelations)
      .catch(() => setRelations([]))
  }, [open, activeId, connected, relationsCache])

  const items = useMemo<Item[]>(() => {
    const needle = query.trim().toLowerCase()
    const rels = relations
      .map((r) => ({ r, s: needle ? Math.min(...[score(r.name, needle), score(`${r.schema}.${r.name}`, needle)].map((x) => (x < 0 ? 99 : x))) : 1 }))
      .filter((x) => x.s < 99)
      .sort((a, b) => a.s - b.s)
      .slice(0, 40)
      .map<Item>(({ r }) => ({ kind: 'relation', key: `r:${r.schema}.${r.name}`, relation: r }))
    const queries = saved
      .filter((q) => !needle || q.name.toLowerCase().includes(needle))
      .slice(0, 8)
      .map<Item>((q) => ({ kind: 'saved', key: `q:${q.id}`, id: q.id, name: q.name }))
    return [...rels, ...queries]
  }, [query, relations, saved])

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (item: Item | undefined) => {
    if (!item) return
    const state = useApp.getState()
    if (item.kind === 'relation' && activeId) {
      const r = item.relation
      state.openTable({ connId: activeId, schema: r.schema, name: r.name, kind: r.kind })
    } else if (item.kind === 'saved') {
      state.openSaved(item.id)
    }
    setQuery('')
    setOpen(false)
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  return (
    <div className="search-box">
      <label>
        <SearchIcon />
        <span className="sr">Jump to a table, view or query</span>
        <input
          id="jump-input"
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls="jump-list"
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          placeholder="Jump to a table, view or query"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(items.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(items[index])
            } else if (e.key === 'Escape') {
              setQuery('')
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        <span className="kbd">{shortcut('K')}</span>
      </label>
      {open && (
        <ul id="jump-list" ref={listRef} className="jump-list" role="listbox">
          {!connected && relations.length === 0 && saved.length === 0 && <li className="jump-empty">Connect to a database to search its tables.</li>}
          {(connected || saved.length > 0) && items.length === 0 && <li className="jump-empty">Nothing matches “{query}”.</li>}
          {items.map((item, i) => (
            <li
              key={item.key}
              role="option"
              aria-selected={i === index}
              className="jump-item"
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(item)
              }}
            >
              {item.kind === 'relation' ? (
                <>
                  {item.relation.kind === 'view' || item.relation.kind === 'materializedView' ? <ViewIcon /> : <TableIcon />}
                  <span className="name">{item.relation.name}</span>
                  <span className="hint">{item.relation.schema}</span>
                </>
              ) : (
                <>
                  <SearchIcon size={14} />
                  <span className="name">{item.name}</span>
                  <span className="hint">saved query</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
