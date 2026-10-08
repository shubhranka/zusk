import { useApp } from '../../store/app'
import { CollapseIcon, PlusIcon, RefreshIcon, SearchIcon } from '../Icons'
import { ConnectionNode } from './ConnectionNode'
import { SavedQueries } from './SavedQueries'

export function Explorer() {
  const profiles = useApp((s) => s.profiles)
  const treeFilter = useApp((s) => s.treeFilter)
  const setTreeFilter = useApp((s) => s.setTreeFilter)
  const setDialog = useApp((s) => s.setDialog)
  const refresh = useApp((s) => s.refresh)
  const collapseAll = useApp((s) => s.collapseAll)

  return (
    <aside aria-label="Explorer" className="explorer">
      <div className="explorer-head">
        <span className="section-title">Explorer</span>
        <div className="actions">
          <button className="btn-ghost-icon" aria-label="Add connection" title="Add connection" onClick={() => setDialog({ kind: 'connection' })}>
            <PlusIcon strokeWidth={1.8} />
          </button>
          <button className="btn-ghost-icon" aria-label="Refresh schema" title="Refresh schema" onClick={() => void refresh()}>
            <RefreshIcon />
          </button>
          <button className="btn-ghost-icon" aria-label="Collapse all" title="Collapse all" onClick={collapseAll}>
            <CollapseIcon />
          </button>
        </div>
      </div>

      <label className="tree-filter">
        <SearchIcon size={14} />
        <span className="sr">Filter tables</span>
        <input
          className="input-bare"
          type="text"
          value={treeFilter}
          onChange={(e) => setTreeFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setTreeFilter('')}
          placeholder="Filter tables…"
          spellCheck={false}
        />
      </label>

      {profiles.length === 0 ? (
        <div className="explorer-empty">
          <span>No connections yet. Add one to browse its schemas.</span>
          <button className="btn-secondary small" onClick={() => setDialog({ kind: 'connection' })}>
            <PlusIcon size={14} /> Add connection
          </button>
        </div>
      ) : (
        <div role="tree" aria-label="Database explorer" className="tree">
          {profiles.map((p) => (
            <ConnectionNode key={p.id} profile={p} />
          ))}
        </div>
      )}

      <SavedQueries />
    </aside>
  )
}
