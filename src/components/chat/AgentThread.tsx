import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { activityLabel, agentTurns, arg, namedConnection, providerName, queryConnection, type AgentActivity, type AgentTurn } from '../../lib/agent'
import { toAppError } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { formatCount, plural } from '../../lib/format'
import type { ConnectionProfile, QueryPreview } from '../../lib/types'
import { displayValue } from '../../lib/values'
import { useApp } from '../../store/app'
import { ChevronIcon, LockIcon } from '../Icons'
import { Markdown } from './Markdown'

/** Rows of a query result shown under its step. */
const PREVIEW_ROWS = 50

const EXAMPLES = ['What’s in this database?', 'Which tables are the largest?', 'Find the columns that hold email addresses']

export function AgentThread() {
  const agent = useApp((s) => s.agent)
  const profiles = useApp((s) => s.profiles)
  const { retryAgent, setDialog } = useApp.getState()
  const turns = useMemo(() => agentTurns(agent.messages), [agent.messages])
  const scroller = useRef<HTMLDivElement>(null)
  const last = turns.at(-1)
  const working = agent.status === 'working'

  // Keep the latest step in view.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [agent.messages.length, agent.status, agent.error])

  return (
    <div ref={scroller} className="chat-thread" role="log">
      {turns.length === 0 && !agent.error && <Empty />}
      {turns.map((turn) => (
        <Turn key={turn.index} turn={turn} live={working && turn === last} profiles={profiles} />
      ))}
      {working && (
        <div className="chat-working">
          <span className="dot connecting" />
          {last?.steps.length ? 'Working…' : 'Thinking…'}
        </div>
      )}
      {agent.stopped && !working && !last?.answer && (
        <div className="agent-stopped">
          Stopped.
          <button className="link-btn" onClick={() => void retryAgent()}>
            Continue
          </button>
        </div>
      )}
      {agent.error && (
        <div className="fix-note error" role="alert">
          <span>
            {agent.error.message}
            {agent.error.hint ? ` ${agent.error.hint}` : ''}
          </span>
          <span className="actions">
            {agent.error.kind === 'ai' && (
              <button className="link-btn" onClick={() => setDialog({ kind: 'ai' })}>
                AI settings
              </button>
            )}
            <button className="link-btn" onClick={() => void retryAgent()}>
              Retry
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

function Empty() {
  const ai = useApp((s) => s.ai)
  const { sendAgent } = useApp.getState()
  return (
    <div className="chat-empty">
      <strong>Ask about your data</strong>
      <span>
        The agent works it out on its own: it finds the tables, reads how they fit together and runs queries, across your saved
        connections, then answers in plain language.
      </span>
      <div className="agent-examples">
        {EXAMPLES.map((q) => (
          <button key={q} className="agent-example" onClick={() => void sendAgent(q)}>
            {q}
          </button>
        ))}
      </div>
      <span className="agent-privacy">
        <LockIcon size={13} />
        <span>
          Read-only: it can’t change anything. What it finds, including rows, is sent to {ai ? providerName(ai) : 'your AI provider'}.
        </span>
      </span>
    </div>
  )
}

function Turn({ turn, live, profiles }: { turn: AgentTurn; live: boolean; profiles: ConnectionProfile[] }) {
  return (
    <>
      <div className="chat-msg user">{turn.question}</div>
      {turn.steps.length > 0 && <Activity steps={turn.steps} live={live} profiles={profiles} />}
      {turn.answer && (
        <div className="chat-msg">
          <Markdown text={turn.answer} connFor={(sql) => queryConnection(turn, sql, profiles)} />
        </div>
      )}
    </>
  )
}

/** The steps taken for a question: open while it's being worked on, folded after. */
function Activity({ steps, live, profiles }: { steps: AgentActivity[]; live: boolean; profiles: ConnectionProfile[] }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const shown = open ?? live
  const queries = steps.filter((s) => s.call.name === 'run_query').length
  const failed = steps.filter((s) => s.result?.isError).length

  return (
    <div className="agent-activity">
      <button className="agent-activity-head" onClick={() => setOpen(!shown)} aria-expanded={shown}>
        <ChevronIcon open={shown} size={12} />
        <span>
          {plural(steps.length, 'step')}
          {queries > 0 && ` · ${plural(queries, 'query', 'queries')}`}
          {failed > 0 && ` · ${failed} failed`}
        </span>
      </button>
      {shown && (
        <ol className="agent-steps">
          {steps.map((step) => (
            <Step key={step.call.id} step={step} profiles={profiles} />
          ))}
        </ol>
      )}
    </div>
  )
}

function Step({ step, profiles }: { step: AgentActivity; profiles: ConnectionProfile[] }) {
  const [open, setOpen] = useState(false)
  const { call, result, note } = step
  const state = !result ? 'pending' : result.isError ? 'error' : 'ok'

  return (
    <li className="agent-step">
      {note && <div className="agent-note">{note}</div>}
      <button className="agent-step-head" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!result}>
        <span className={`agent-step-dot ${state}`} />
        <span className="label">{activityLabel(call, profiles, result?.preview?.connId)}</span>
        {result && <span className={state === 'error' ? 'summary error' : 'summary'}>{result.summary}</span>}
      </button>
      {open && result && (
        <StepDetail sql={call.name === 'run_query' ? arg(call, 'sql') : undefined} content={result.content} isError={result.isError} preview={result.preview} connId={result.preview?.connId ?? namedConnection(call, profiles)?.id} />
      )}
    </li>
  )
}

function StepDetail({ sql, content, isError, preview, connId }: { sql?: string; content: string; isError: boolean; preview?: QueryPreview; connId?: string }) {
  const { openSql, toast } = useApp.getState()
  if (!sql) return <pre className={isError ? 'agent-output error' : 'agent-output'}>{content}</pre>

  const copy = async () => {
    try {
      await copyText(sql)
      toast('SQL copied')
    } catch (e) {
      toast(toAppError(e).message, 'danger')
    }
  }

  return (
    <div className="agent-detail">
      <pre className="agent-sql">{sql}</pre>
      {isError ? <pre className="agent-output error">{content}</pre> : preview && <Preview preview={preview} />}
      <div className="foot">
        <button className="link-btn" onClick={() => openSql(sql, connId)} title="Put this query in the editor">
          Open in editor
        </button>
        <button className="link-btn" onClick={() => void copy()}>
          Copy SQL
        </button>
      </div>
    </div>
  )
}

function Preview({ preview }: { preview: QueryPreview }) {
  const { result } = preview
  if (!result.hasResultSet) return <div className="agent-more">{result.command}</div>
  if (result.rows.length === 0) return <div className="agent-more">No rows.</div>
  const rows = result.rows.slice(0, PREVIEW_ROWS)
  const total = result.truncated ? `${formatCount(result.rowCount)}+` : formatCount(result.rowCount)

  return (
    <>
      <div className="agent-table">
        <table>
          <thead>
            <tr>
              {result.columns.map((c, i) => (
                <th key={i} title={c.typeName}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((value, i) => {
                  const kind = result.columns[i]?.kind ?? 'text'
                  const text = displayValue(value, kind)
                  return (
                    <td key={i} className={value === null ? 'null' : kind === 'num' ? 'num' : undefined} title={text.length > 40 ? text : undefined}>
                      {text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length < result.rowCount && (
        <div className="agent-more">
          {formatCount(rows.length)} of {total} rows shown. Open it in the editor for the rest.
        </div>
      )}
    </>
  )
}
