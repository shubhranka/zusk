import { useState, type FormEvent } from 'react'

import { useApp } from '../store/app'
import { Dialog } from './Dialog'

export function SaveQueryDialog() {
  const docTitle = useApp((s) => s.doc.title)
  const { setDialog, saveQueryAs } = useApp.getState()
  const [name, setName] = useState(docTitle.startsWith('query_') ? '' : docTitle)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) saveQueryAs(name.trim())
  }

  return (
    <Dialog title="Save query" description="Saved queries are kept on this computer and listed in the explorer." onClose={() => setDialog(null)}>
      <form onSubmit={submit}>
        <div className="dialog-body">
          <label className="field full">
            <span>Name</span>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Refunds this week" required />
          </label>
        </div>
        <div className="dialog-foot">
          <span className="spacer" />
          <button type="button" className="btn-secondary" onClick={() => setDialog(null)}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" style={{ minHeight: 36, borderRadius: 8 }} disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}
