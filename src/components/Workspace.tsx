import { useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { toAppError } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { formatCount, formatMs, plural } from '../lib/format'
import { MOD, shortcut } from '../lib/platform'
import { excerpt, looksLikeTemplate } from '../lib/template'
import type { AppError, RunResult } from '../lib/types'
import { filterRows } from '../lib/values'
import { detailsKey, errorRange, useApp, type RunState } from '../store/app'
import { SqlEditor } from './editor/SqlEditor'
import { AlertIcon, BracesIcon, FilterIcon, LockIcon, PlayIcon, SparkleIcon, StopIcon } from './Icons'
import { ResultsGrid } from './results/ResultsGrid'
import { StructureTable } from './results/StructureTable'

const EMPTY_ROWS: (string | null)[][] = []

/** "100 rows", or "100,000+ rows" when the result was cut off at the cap. */
function rowsLabel(r: RunResult): string {
  return r.truncated && r.rowCount <= r.rows.length ? `${formatCount(r.rows.length)}+ rows` : plural(r.rowCount, 'row')
}
const AFFECTS_ROWS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'WITH'])

export function Workspace() {
  const [hasSelection, setHasSelection] = useState(false)
  const run = useApp((s) => s.run)
  const result = run.result
  const view = useApp((s) => s.view)
  const rowFilter = useApp((s) => s.rowFilter)
  const deferredFilter = useDeferredValue(rowFilter)

  const rows = useMemo(
    () => (result ? filterRows(result.rows, result.columns, deferredFilter) : EMPTY_ROWS),
    [result, deferredFilter],
  )

  return (
    <main className="main">
      <TitleRow result={result} />

      <EditorCard run={run} hasSelection={hasSelection} onSelectionChange={setHasSelection} />

      <Toolbar result={result} shown={rows.length} />

      <section className="results" aria-label={view === 'data' ? 'Results' : 'Structure'}>
        {view === 'data' ? <DataView run={run} rows={rows} /> : <StructureView />}
      </section>
    </main>
  )
}

// ------------------------------------------------------------------ title

function TitleRow({ result }: { result?: RunResult }) {
  const doc = useApp((s) => s.doc)
  const profile = useApp((s) => s.profiles.find((p) => p.id === (s.doc.target?.connId ?? s.activeId)))
  const details = useApp((s) => {
    const t = s.doc.target
    return t ? s.tree[t.connId]?.details[detailsKey(t.schema, t.name)] : undefined
  })
  const target = doc.target
  const ready = details?.state === 'ready' ? details.data : undefined

  const crumbs = [profile?.name ?? 'No connection', target?.schema].filter(Boolean).join(' / ') + ' /'
  const stats = target
    ? [
        { label: 'Rows', value: ready ? formatCount(ready.rowEstimate) : '…', title: 'Estimated from table statistics (pg_class.reltuples)' },
        { label: 'Indexes', value: ready ? formatCount(ready.indexCount) : '…' },
      ]
    : [
        { label: 'Rows', value: result?.hasResultSet ? rowsLabel(result).replace(/ rows?$/, '') : '—' },
        { label: 'Columns', value: result?.hasResultSet ? formatCount(result.columns.length) : '—' },
      ]

  return (
    <div className="title-row">
      <div className="crumbs">
        <span className="crumb">{crumbs}</span>
        <h1 title={ready?.comment ?? doc.title}>{doc.title}</h1>
      </div>
      <div className="stats">
        {stats.map((s) => (
          <div key={s.label} className="stat" title={s.title}>
            <span className="label">{s.label}</span>
            <span className="value">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ editor

function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(performance.now()), 100)
    return () => clearInterval(id)
  }, [active])
  return now
}

function statusText(run: RunState, now: number): string {
  switch (run.status) {
    case 'idle':
      return ''
    case 'running':
      return `Running… ${formatMs(now - (run.startedAt ?? now))}`
    case 'error':
      if (run.error?.kind === 'cancelled') return `Cancelled after ${formatMs(run.error.elapsedMs ?? 0)}`
      return run.error?.elapsedMs != null ? `Failed after ${formatMs(run.error.elapsedMs)}` : 'Failed'
    case 'done': {
      const r = run.result!
      const prefix = r.statementCount > 1 ? `${r.statementCount} statements · ` : ''
      if (r.hasResultSet) return `${prefix}${rowsLabel(r)} in ${formatMs(r.elapsedMs)}`
      if (AFFECTS_ROWS.has(r.command)) return `${prefix}${plural(r.rowCount, 'row')} affected in ${formatMs(r.elapsedMs)}`
      return `${prefix}${r.command} in ${formatMs(r.elapsedMs)}`
    }
  }
}

function EditorCard({ run, hasSelection, onSelectionChange }: { run: RunState; hasSelection: boolean; onSelectionChange(v: boolean): void }) {
  const doc = useApp((s) => s.doc)
  const editorHeight = useApp((s) => s.settings.editorHeight)
  const readOnly = useApp((s) => s.readOnly)
  const jinja = useApp((s) => s.settings.jinja)
  const chatOpen = useApp((s) => s.settings.chatOpen)
  const { runQuery, cancelQuery, setReadOnly, updateSettings, setDialog, toggleChat } = useApp.getState()
  const running = run.status === 'running'
  const now = useNow(running)
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef<{ y: number; h: number } | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStart.current = { y: e.clientY, h: editorHeight }
    setDragging(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return
    const max = Math.max(160, window.innerHeight - 380)
    const h = Math.round(Math.min(max, Math.max(96, dragStart.current.h + e.clientY - dragStart.current.y)))
    updateSettings({ editorHeight: h })
  }
  const onPointerUp = () => {
    dragStart.current = null
    setDragging(false)
  }

  return (
    <section aria-label="SQL editor" className="editor-card">
      <div className="editor-bar">
        <span className="file">{doc.fileName}</span>
        <div className="right">
          <span className={run.status === 'error' && run.error?.kind !== 'cancelled' ? 'status error' : 'status'} aria-live="polite">
            {statusText(run, now)}
          </span>
          <button
            className="chat-toggle"
            aria-pressed={chatOpen}
            onClick={() => toggleChat()}
            title={chatOpen ? `Close the chat (${shortcut('J')})` : `Chat with AI: edit the SQL, or ask the agent about your data (${shortcut('J')})`}
          >
            <SparkleIcon size={13} />
            Chat
          </button>
          <div className="jinja-group">
            <button
              className="jinja-toggle"
              role="switch"
              aria-checked={jinja}
              onClick={() => updateSettings({ jinja: !jinja })}
              title={
                jinja
                  ? 'Jinja is on: the editor is rendered as a template ({{ }}, {% %}) before it runs. Click to run it as plain SQL.'
                  : 'Treat the editor as a Jinja template ({{ }}, {% %}) and render it before running.'
              }
            >
              <BracesIcon size={13} />
              Jinja
              <span className="track" aria-hidden />
            </button>
            {jinja && (
              <button className="jinja-vars" onClick={() => setDialog({ kind: 'templateVars' })} title="Template variables, and a preview of the rendered SQL">
                Variables
              </button>
            )}
          </div>
          <button
            className="ro-toggle"
            role="switch"
            aria-checked={readOnly}
            disabled={running}
            onClick={() => void setReadOnly(!readOnly)}
            title={
              readOnly
                ? 'Read-only: every run happens in a read-only transaction that is rolled back. Click to allow writes.'
                : 'Writes are enabled and statements auto-commit. Click to go back to read-only.'
            }
          >
            <LockIcon size={13} open={!readOnly} />
            Read-only
            <span className="track" aria-hidden />
          </button>
          {running ? (
            <button className="btn-run stop" onClick={() => void cancelQuery()}>
              <StopIcon />
              Stop
            </button>
          ) : (
            <button className="btn-run" onClick={() => void runQuery()} title={hasSelection ? 'Run the selected text' : 'Run the whole editor'}>
              <PlayIcon />
              {hasSelection ? 'Run selection' : 'Run'}
              <span className="kbd-hint">{MOD}↵</span>
            </button>
          )}
        </div>
      </div>
      <div className="editor-host" style={{ height: editorHeight }}>
        <SqlEditor onSelectionChange={onSelectionChange} />
      </div>
      <div
        className={dragging ? 'resize-handle dragging' : 'resize-handle'}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize editor"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => updateSettings({ editorHeight: 196 })}
      />
    </section>
  )
}

// ------------------------------------------------------------------ toolbar

function Toolbar({ result, shown }: { result?: RunResult; shown: number }) {
  const view = useApp((s) => s.view)
  const rowFilter = useApp((s) => s.rowFilter)
  const details = useApp((s) => {
    const t = s.doc.target
    return t ? s.tree[t.connId]?.details[detailsKey(t.schema, t.name)] : undefined
  })
  const { setView, setRowFilter } = useApp.getState()
  const hasRows = !!result?.hasResultSet

  let label = ''
  let warn = false
  let title: string | undefined
  if (view === 'data' && hasRows) {
    label = `${formatCount(shown)} of ${formatCount(result!.rows.length)} rows`
    if (result!.truncated) {
      label += ' · truncated'
      warn = true
      title = `The query returned more than ${formatCount(result!.rows.length)} rows, so only the first ${formatCount(result!.rows.length)} were kept. Add a LIMIT or WHERE clause to narrow it down.`
    }
  } else if (view === 'structure' && details?.state === 'ready') {
    label = plural(details.data.columns.length, 'column')
  }

  return (
    <div className="toolbar">
      <div role="group" aria-label="Table view" className="segmented">
        <button aria-pressed={view === 'data'} onClick={() => setView('data')}>
          Data
        </button>
        <button aria-pressed={view === 'structure'} onClick={() => setView('structure')}>
          Structure
        </button>
      </div>
      <label className="row-filter">
        <FilterIcon />
        <span className="sr">Filter rows</span>
        <input
          className="input-bare"
          type="text"
          value={rowFilter}
          disabled={view !== 'data' || !hasRows}
          onChange={(e) => setRowFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setRowFilter('')}
          placeholder="Filter rows…"
          spellCheck={false}
        />
      </label>
      <span className={warn ? 'shown-label warn' : 'shown-label'} title={title}>
        {label}
      </span>
    </div>
  )
}

// ------------------------------------------------------------------ results

function DataView({ run, rows }: { run: RunState; rows: (string | null)[][] }) {
  const connected = useApp((s) => (s.activeId ? s.conns[s.activeId]?.status === 'connected' : false))
  const hasProfiles = useApp((s) => s.profiles.length > 0)
  const rowFilter = useApp((s) => s.rowFilter)
  const setDialog = useApp((s) => s.setDialog)
  const result = run.result

  if (run.status === 'error' && run.error) {
    if (run.error.kind === 'cancelled') {
      return (
        <div className="empty-state panel">
          <strong>Query cancelled</strong>
          <span>Nothing was changed. Run it again with {MOD}↵.</span>
        </div>
      )
    }
    return <ErrorPanel run={run} />
  }

  if (!result) {
    if (run.status === 'running') {
      return (
        <div className="empty-state panel">
          <strong>Running query…</strong>
        </div>
      )
    }
    if (!connected) {
      return (
        <div className="empty-state panel">
          <strong>{hasProfiles ? 'Not connected' : 'No connections yet'}</strong>
          <span>{hasProfiles ? 'Pick a connection in the explorer and connect to it.' : 'Add a PostgreSQL connection to start browsing.'}</span>
          {!hasProfiles && (
            <button className="btn-secondary" onClick={() => setDialog({ kind: 'connection' })}>
              Add connection
            </button>
          )}
        </div>
      )
    }
    return (
      <div className="empty-state panel">
        <strong>No results yet</strong>
        <span>
          Click a table in the explorer to preview it, or write SQL above and press {MOD}↵.
        </span>
      </div>
    )
  }

  if (!result.hasResultSet) {
    return (
      <div className="panel command-panel">
        <span className="tag">{result.command}</span>
        <span>
          {AFFECTS_ROWS.has(result.command) ? `${plural(result.rowCount, 'row')} affected` : 'Done'}
          {result.statementCount > 1 ? ` · ${result.statementCount} statements` : ''} · {formatMs(result.elapsedMs)}
          {result.transaction === 'readOnly' ? ' · rolled back (read-only)' : ''}
        </span>
      </div>
    )
  }

  return <ResultsGrid columns={result.columns} rows={rows} allRows={result.rows} filtering={!!rowFilter.trim()} dimmed={run.status === 'running'} />
}

function ErrorPanel({ run }: { run: RunState }) {
  const error = run.error!
  const fix = run.fix
  const jinja = useApp((s) => s.settings.jinja)
  const { fixQuery, setDialog, updateSettings, runQuery } = useApp.getState()
  // A rendered run's failing statement isn't in the editor, so there's nothing to rewrite.
  const canFix = error.kind === 'database' && run.sql != null && run.rendered == null && fix?.status !== 'applied'
  const unrenderedTemplate = !jinja && run.rendered == null && error.kind === 'database' && looksLikeTemplate(run.sql ?? '')
  const heading: Record<string, string> = {
    database: 'Query failed',
    readOnly: 'Blocked by read-only mode',
    connection: 'Connection problem',
    notConnected: 'Not connected',
    template: 'Template error',
  }
  return (
    <div className="error-panel" role="alert">
      <div className="head">
        <AlertIcon />
        <span>{heading[error.kind] ?? 'Something went wrong'}</span>
        {error.code && <span className="code">{error.code}</span>}
        {run.errorAt && (
          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
            line {run.errorAt.line}, column {run.errorAt.col}
          </span>
        )}
        {canFix && (
          <button
            className="btn-secondary small fix-btn"
            onClick={() => void fixQuery()}
            disabled={fix?.status === 'working'}
            title="Ask the AI model to correct the statement that failed"
          >
            <SparkleIcon />
            {fix?.status === 'working' ? 'Fixing…' : 'Fix with AI'}
          </button>
        )}
        {error.kind === 'template' && (
          <button className="btn-secondary small fix-btn" onClick={() => setDialog({ kind: 'templateVars' })}>
            <BracesIcon />
            Variables
          </button>
        )}
      </div>
      <div className="message">{error.message}</div>
      {error.detail && (
        <div className="extra">
          <span>Detail: </span>
          {error.detail}
        </div>
      )}
      {error.hint && (
        <div className="extra">
          <span>Hint: </span>
          {error.hint}
        </div>
      )}
      {error.transaction === 'failed' && (
        <div className="extra">
          <span>Transaction: </span>
          the open transaction is aborted — run ROLLBACK to continue.
        </div>
      )}
      {run.rendered != null && <RenderedSqlAt sql={run.rendered} error={error} />}
      {unrenderedTemplate && (
        <div className="fix-note" role="status">
          <BracesIcon />
          <span>This SQL has Jinja tags, which Postgres can’t read. Turn on Jinja to render them before the query runs.</span>
          <button
            className="link-btn"
            onClick={() => {
              updateSettings({ jinja: true })
              void runQuery()
            }}
          >
            Turn on Jinja and run
          </button>
        </div>
      )}
      {fix?.status === 'applied' && (
        <div className="fix-note" role="status">
          <SparkleIcon />
          <span>
            {fix.explanation} Run it again with {shortcut('↵')}, or undo with {shortcut('Z')}.
          </span>
        </div>
      )}
      {fix?.status === 'error' && (
        <div className="fix-note error" role="alert">
          <span>
            {fix.error.message}
            {fix.error.hint ? ` ${fix.error.hint}` : ''}
          </span>
          {fix.error.kind === 'ai' && (
            <button className="link-btn" onClick={() => setDialog({ kind: 'ai' })}>
              AI settings
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Where a rendered template's SQL failed, since the editor only shows the template. */
function RenderedSqlAt({ sql, error }: { sql: string; error: AppError }) {
  const toast = useApp((s) => s.toast)
  const range = errorRange(sql, error)
  const at = range ? excerpt(sql, range[0]) : null

  const copy = async () => {
    try {
      await copyText(sql)
      toast('Rendered SQL copied')
    } catch (e) {
      toast(toAppError(e).message, 'danger')
    }
  }

  return (
    <div className="rendered-at">
      <div className="caption">
        <span>{at ? `In the rendered SQL, line ${at.line}, column ${at.col}:` : 'The template rendered, then the SQL failed.'}</span>
        <button className="link-btn" onClick={() => void copy()}>
          Copy rendered SQL
        </button>
      </div>
      {at && range && (
        <pre className="sql-excerpt">
          {at.lines.map((l) => {
            if (l.n !== at.line) {
              return (
                <div key={l.n} className="line">
                  <span className="n">{l.n}</span>
                  {l.text}
                </div>
              )
            }
            const start = at.col - 1
            const end = Math.min(l.text.length, start + Math.max(1, range[1] - range[0]))
            return (
              <div key={l.n} className="line hit">
                <span className="n">{l.n}</span>
                {l.text.slice(0, start)}
                <mark>{l.text.slice(start, end) || ' '}</mark>
                {l.text.slice(end)}
              </div>
            )
          })}
        </pre>
      )}
    </div>
  )
}

function StructureView() {
  const target = useApp((s) => s.doc.target)
  const details = useApp((s) => {
    const t = s.doc.target
    return t ? s.tree[t.connId]?.details[detailsKey(t.schema, t.name)] : undefined
  })
  const loadDetails = useApp((s) => s.loadDetails)

  if (!target) {
    return (
      <div className="empty-state panel">
        <strong>No table selected</strong>
        <span>Click a table or view in the explorer to see its columns, keys and defaults.</span>
      </div>
    )
  }
  if (!details || details.state === 'loading') {
    return <div className="empty-state panel">Loading structure…</div>
  }
  if (details.state === 'error') {
    return (
      <div className="empty-state panel">
        <strong>Couldn’t load the structure</strong>
        <span>{details.error}</span>
        <button className="btn-secondary small" onClick={() => void loadDetails(target.connId, target.schema, target.name, true)}>
          Retry
        </button>
      </div>
    )
  }
  return <StructureTable details={details.data} />
}
