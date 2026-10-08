import { relativeTime } from '../../lib/format'
import { shortcut } from '../../lib/platform'
import { useApp } from '../../store/app'
import { CloseIcon } from '../Icons'

export function SavedQueries() {
  const saved = useApp((s) => s.saved)
  const activeId = useApp((s) => s.doc.savedId)
  const { openSaved, deleteSaved } = useApp.getState()

  return (
    <section className="saved" aria-label="Saved queries">
      <span className="section-title">Saved queries</span>
      {saved.length === 0 && <span className="saved-empty">Press {shortcut('S')} in the editor to save the current query.</span>}
      {saved.map((q) => (
        <div className="saved-item" key={q.id}>
          <button className={q.id === activeId ? 'saved-card active' : 'saved-card'} onClick={() => openSaved(q.id)} title={q.sql}>
            <span className="name">{q.name}</span>
            <span className="meta">Edited {relativeTime(q.updatedAt)}</span>
          </button>
          <button className="btn-ghost-icon remove" aria-label={`Delete saved query ${q.name}`} title="Delete" onClick={() => deleteSaved(q.id)}>
            <CloseIcon size={12} />
          </button>
        </div>
      ))}
    </section>
  )
}
