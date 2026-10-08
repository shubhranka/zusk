import type { ReactNode } from 'react'

import { formatCount } from '../../lib/format'
import type { ColumnInfo, FunctionInfo, RelationInfo } from '../../lib/types'
import { detailsKey, nodeKey, useApp, type TreeGroup } from '../../store/app'
import {
  ChevronIcon,
  ColumnIcon,
  FolderIcon,
  FunctionIcon,
  KeyIcon,
  LinkIcon,
  SchemaIcon,
  TableIcon,
  ViewIcon,
} from '../Icons'

function matches(name: string, needle: string): boolean {
  return !needle || name.toLowerCase().includes(needle)
}

export function SchemaNode({ connId, schema }: { connId: string; schema: string }) {
  const expanded = useApp((s) => !!s.expanded[nodeKey('s', connId, schema)])
  const objects = useApp((s) => s.tree[connId]?.objects[schema])
  const needle = useApp((s) => s.treeFilter.trim().toLowerCase())
  const toggleSchema = useApp((s) => s.toggleSchema)
  const filtering = !!needle

  const data = objects?.state === 'ready' ? objects.data : undefined
  const tables = data?.tables.filter((t) => matches(t.name, needle)) ?? []
  const views = data?.views.filter((v) => matches(v.name, needle)) ?? []
  const functions = data?.functions.filter((f) => matches(f.name, needle)) ?? []
  const hits = tables.length + views.length + functions.length

  // While filtering, only schemas with matches are shown, and they open by themselves.
  if (filtering && hits === 0) return null
  const open = expanded || filtering

  let body: ReactNode = null
  if (open) {
    if (!objects || objects.state === 'loading') body = <span className="tree-note">Loading…</span>
    else if (objects.state === 'error') body = <span className="tree-note error">{objects.error}</span>
    else {
      body = (
        <>
          {(!filtering || tables.length > 0) && (
            <Group connId={connId} schema={schema} group="tables" label="Tables" total={data!.tables.length} filtering={filtering}>
              <TableList connId={connId} schema={schema} tables={tables} filtering={filtering} />
            </Group>
          )}
          {(!filtering || views.length > 0) && (
            <Group connId={connId} schema={schema} group="views" label="Views" total={data!.views.length} filtering={filtering}>
              <ViewList connId={connId} schema={schema} views={views} filtering={filtering} />
            </Group>
          )}
          {(!filtering || functions.length > 0) && (
            <Group connId={connId} schema={schema} group="functions" label="Functions" total={data!.functions.length} filtering={filtering}>
              <FunctionList connId={connId} schema={schema} functions={functions} filtering={filtering} />
            </Group>
          )}
        </>
      )
    }
  }

  return (
    <div role="treeitem" aria-expanded={open}>
      <div className="tree-row">
        <button className="tree-btn" onClick={() => toggleSchema(connId, schema)}>
          <ChevronIcon open={open} />
          <SchemaIcon />
          <span className="label">{schema}</span>
        </button>
      </div>
      {open && (
        <div role="group" className="tree-group">
          {body}
        </div>
      )}
    </div>
  )
}

function Group(props: {
  connId: string
  schema: string
  group: TreeGroup
  label: string
  total: number
  filtering: boolean
  children: ReactNode
}) {
  const { connId, schema, group, label, total, filtering, children } = props
  const expanded = useApp((s) => !!s.expanded[nodeKey('g', connId, schema, group)])
  const toggleGroup = useApp((s) => s.toggleGroup)
  // While filtering, every group shows its matches.
  const open = expanded || filtering

  return (
    <div role="treeitem" aria-expanded={open}>
      <div className="tree-row">
        <button className="tree-btn secondary" onClick={() => toggleGroup(connId, schema, group)}>
          <ChevronIcon open={open} />
          <FolderIcon />
          <span className="label">{label}</span>
          <span className="count">{total}</span>
        </button>
      </div>
      {open && (
        <div role="group" className={group === 'tables' ? 'tree-group' : 'tree-group leaves'}>
          {children}
        </div>
      )}
    </div>
  )
}

function emptyNote(kind: string, filtering: boolean) {
  return <span className="tree-note">{filtering ? `No ${kind} match.` : `No ${kind}.`}</span>
}

function TableList({ connId, schema, tables, filtering }: { connId: string; schema: string; tables: RelationInfo[]; filtering: boolean }) {
  if (tables.length === 0) return emptyNote('tables', filtering)
  return (
    <>
      {tables.map((t) => (
        <TableNode key={t.name} connId={connId} schema={schema} table={t} />
      ))}
    </>
  )
}

function useIsSelected(connId: string, schema: string, name: string) {
  return useApp((s) => {
    const t = s.doc.target
    return !!t && t.connId === connId && t.schema === schema && t.name === name
  })
}

function TableNode({ connId, schema, table }: { connId: string; schema: string; table: RelationInfo }) {
  const open = useApp((s) => !!s.expanded[nodeKey('t', connId, schema, table.name)])
  const details = useApp((s) => s.tree[connId]?.details[detailsKey(schema, table.name)])
  const selected = useIsSelected(connId, schema, table.name)
  const { toggleTable, openTable } = useApp.getState()

  return (
    <div role="treeitem" aria-expanded={open} aria-selected={selected} className="tree-table">
      <div className={selected ? 'tree-table-row selected' : 'tree-table-row'}>
        <button className="tree-toggle" aria-label={`${open ? 'Collapse' : 'Expand'} ${table.name}`} onClick={() => toggleTable(connId, schema, table.name)}>
          <ChevronIcon open={open} />
        </button>
        <button
          className="tree-pick"
          title={`${schema}.${table.name} — click to preview`}
          onClick={() => openTable({ connId, schema, name: table.name, kind: table.kind })}
        >
          <TableIcon />
          <span className="label">{table.name}</span>
          {table.rowEstimate != null && <span className="count">{formatCount(table.rowEstimate)}</span>}
        </button>
      </div>
      {open && (
        <div role="group" className="tree-columns">
          {(!details || details.state === 'loading') && <span className="tree-note">Loading columns…</span>}
          {details?.state === 'error' && <span className="tree-note error">{details.error}</span>}
          {details?.state === 'ready' && details.data.columns.map((c) => <ColumnRow key={c.name} column={c} />)}
        </div>
      )}
    </div>
  )
}

function ColumnRow({ column }: { column: ColumnInfo }) {
  const icon = column.isPrimaryKey ? <KeyIcon /> : column.isForeignKey ? <LinkIcon /> : <ColumnIcon />
  const title = [column.name, column.dataType, column.isPrimaryKey && 'primary key', column.references && `→ ${column.references}`]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="tree-col" title={title}>
      {icon}
      <span className="label">{column.name}</span>
      <span className="type">{column.dataType}</span>
    </div>
  )
}

function ViewList({ connId, schema, views, filtering }: { connId: string; schema: string; views: RelationInfo[]; filtering: boolean }) {
  if (views.length === 0) return emptyNote('views', filtering)
  return (
    <>
      {views.map((v) => (
        <ViewLeaf key={v.name} connId={connId} schema={schema} view={v} />
      ))}
    </>
  )
}

function ViewLeaf({ connId, schema, view }: { connId: string; schema: string; view: RelationInfo }) {
  const selected = useIsSelected(connId, schema, view.name)
  const openTable = useApp((s) => s.openTable)
  const materialized = view.kind === 'materializedView'
  return (
    <button
      role="treeitem"
      aria-selected={selected}
      className={selected ? 'tree-leaf selected' : 'tree-leaf'}
      title={`${schema}.${view.name}${materialized ? ' (materialized view)' : ''} — click to preview`}
      onClick={() => openTable({ connId, schema, name: view.name, kind: view.kind })}
    >
      <ViewIcon />
      <span className="label">{view.name}</span>
      {materialized && <span className="count">mat</span>}
    </button>
  )
}

function FunctionList({ connId, schema, functions, filtering }: { connId: string; schema: string; functions: FunctionInfo[]; filtering: boolean }) {
  const openFunction = useApp((s) => s.openFunction)
  if (functions.length === 0) return emptyNote('functions', filtering)
  return (
    <>
      {functions.map((f) => (
        <button
          key={f.oid}
          role="treeitem"
          className="tree-leaf"
          title={`${f.isProcedure ? 'procedure' : 'function'} ${schema}.${f.name}(${f.arguments})${f.result ? ` → ${f.result}` : ''} — click to open its definition`}
          onClick={() => void openFunction(connId, schema, f)}
        >
          <FunctionIcon />
          <span className="label">
            {f.name}({f.arguments ? '…' : ''})
          </span>
        </button>
      ))}
    </>
  )
}
