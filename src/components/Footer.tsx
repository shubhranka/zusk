import { formatEncoding } from '../lib/format'
import type { TxState } from '../lib/types'
import { statusLabel, useApp } from '../store/app'
import { LockIcon } from './Icons'

const txLabel: Record<TxState, string> = {
  readOnly: 'read-only, rolled back after each run',
  idle: 'auto-commit',
  inTransaction: 'open — COMMIT or ROLLBACK to finish',
  failed: 'aborted — run ROLLBACK',
}

export function Footer() {
  const conn = useApp((s) => (s.activeId ? s.conns[s.activeId] : undefined))
  const readOnly = useApp((s) => s.readOnly)
  const running = useApp((s) => s.run.status === 'running')
  const setReadOnly = useApp((s) => s.setReadOnly)
  const status = conn?.status ?? 'disconnected'
  const connected = status === 'connected'

  return (
    <footer className="app-footer">
      <span className="item">
        <span className={`dot small ${connected ? '' : status}`} />
        {statusLabel[status]}
      </span>
      <button
        className={readOnly ? 'footer-btn' : 'footer-btn danger'}
        onClick={() => void setReadOnly(!readOnly)}
        disabled={running}
        title={readOnly ? 'Click to allow writes' : 'Click to go back to read-only'}
      >
        <LockIcon size={12} open={!readOnly} />
        {readOnly ? 'Read-only session' : 'Writes enabled'}
      </button>
      {conn?.info && <span>{formatEncoding(conn.info.encoding)}</span>}
      {conn?.info && (
        <span>
          {conn.info.user}@{conn.info.database}
        </span>
      )}
      <span className={`end ${conn?.tx === 'failed' ? 'danger' : conn?.tx === 'inTransaction' ? 'warn' : ''}`}>
        Transaction: {connected && conn ? txLabel[readOnly ? 'readOnly' : conn.tx] : '—'}
      </span>
    </footer>
  )
}
