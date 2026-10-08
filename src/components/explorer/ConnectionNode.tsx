import type { ConnectionProfile } from '../../lib/types'
import { nodeKey, statusLabel, useApp, type ConnState } from '../../store/app'
import { ChevronIcon, DatabaseIcon, PencilIcon, UnplugIcon } from '../Icons'
import { SchemaNode } from './SchemaNode'

const DISCONNECTED: ConnState = { status: 'disconnected', tx: 'idle' }

export function ConnectionNode({ profile }: { profile: ConnectionProfile }) {
  const id = profile.id
  const conn = useApp((s) => s.conns[id]) ?? DISCONNECTED
  const open = useApp((s) => !!s.expanded[nodeKey('c', id)])
  const active = useApp((s) => s.activeId === id)
  const schemas = useApp((s) => s.tree[id]?.schemas)
  const filtering = useApp((s) => s.treeFilter.trim() !== '')
  const { toggleConnection, setActive, connect, disconnect, setDialog } = useApp.getState()

  const connected = conn.status === 'connected'

  return (
    <div role="treeitem" aria-expanded={open} aria-selected={active}>
      <div className="tree-row">
        <button
          className={connected ? 'tree-btn' : 'tree-btn muted'}
          onClick={() => {
            toggleConnection(id)
            if (connected) setActive(id)
          }}
          title={`${profile.user}@${profile.host}:${profile.port}/${profile.database}`}
        >
          <ChevronIcon open={open} />
          <DatabaseIcon color={connected ? 'var(--accent)' : 'var(--text-dim)'} />
          <span className="label" style={{ fontWeight: active && connected ? 500 : 400 }}>
            {profile.name}
          </span>
        </button>
        <div className="row-actions">
          {connected && (
            <button className="btn-ghost-icon" aria-label={`Disconnect ${profile.name}`} title="Disconnect" onClick={() => void disconnect(id)}>
              <UnplugIcon size={13} />
            </button>
          )}
          <button
            className="btn-ghost-icon"
            aria-label={`Edit ${profile.name}`}
            title="Edit connection"
            onClick={() => setDialog({ kind: 'connection', id })}
          >
            <PencilIcon size={13} />
          </button>
        </div>
        <span className={`dot small ${conn.status === 'connected' ? '' : conn.status}`} style={{ marginRight: 8 }} title={statusLabel[conn.status]} />
      </div>

      {open && conn.status === 'connecting' && <div className="tree-connect">Connecting…</div>}

      {open && conn.status === 'disconnected' && (
        <div className="tree-connect">
          <span className="msg">Not connected</span>
          <button className="btn-secondary small" onClick={() => void connect(id)}>
            Connect
          </button>
        </div>
      )}

      {open && conn.status === 'error' && (
        <div className="tree-connect" style={{ alignItems: 'flex-start' }}>
          <span className="msg error">{conn.error}</span>
          <button className="btn-secondary small" onClick={() => void connect(id)}>
            Retry
          </button>
        </div>
      )}

      {open && connected && (
        <div role="group" className="tree-group">
          {(!schemas || schemas.state === 'loading') && <span className="tree-note">Loading schemas…</span>}
          {schemas?.state === 'error' && <span className="tree-note error">{schemas.error}</span>}
          {schemas?.state === 'ready' && schemas.data.length === 0 && <span className="tree-note">No schemas you can see.</span>}
          {schemas?.state === 'ready' && schemas.data.map((schema) => <SchemaNode key={schema.name} connId={id} schema={schema.name} />)}
          {filtering && schemas?.state === 'ready' && <NoMatches connId={id} />}
        </div>
      )}
    </div>
  )
}

/** "No tables match." when a filter hides every schema of a connection. */
function NoMatches({ connId }: { connId: string }) {
  const none = useApp((s) => {
    const tree = s.tree[connId]
    const needle = s.treeFilter.trim().toLowerCase()
    if (!tree?.schemas || tree.schemas.state !== 'ready') return false
    return tree.schemas.data.every((schema) => {
      const objects = tree.objects[schema.name]
      if (objects?.state !== 'ready') return objects?.state !== 'loading'
      const { tables, views, functions } = objects.data
      return ![...tables, ...views, ...functions].some((o) => o.name.toLowerCase().includes(needle))
    })
  })
  return none ? <span className="tree-note">No tables match.</span> : null
}
