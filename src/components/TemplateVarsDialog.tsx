import { useState, type FormEvent, type KeyboardEvent } from 'react'

import { api, toAppError } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { editorBridge } from '../lib/editorBridge'
import { lineCol } from '../lib/fix'
import { isMac, shortcut } from '../lib/platform'
import { DEFAULT_TEMPLATE_VARS, parseTemplateVars } from '../lib/template'
import type { AppError } from '../lib/types'
import { useApp } from '../store/app'
import { Dialog } from './Dialog'

type Message = { tone: 'error' | 'info'; text: string } | null

/** "Line 4: Undefined value: …" for a template error in `sql`. */
function describeError(err: AppError, sql: string): string {
  const at = err.statementRange ? lineCol(sql, err.statementRange[0]) : null
  const text = [err.message, err.detail, err.hint].filter(Boolean).join(' ')
  return at ? `Line ${at.line}: ${text}` : text
}

/** For reading only: templates leave runs of blank lines where their tags were. */
function tidy(sql: string): string {
  return sql.replace(/^(?:[ \t]*\n)+/, '').replace(/\n(?:[ \t]*\n)+/g, '\n\n').trimEnd()
}

export function TemplateVarsDialog() {
  const saved = useApp((s) => s.templateVars)
  const { setDialog, setTemplateVars, toast } = useApp.getState()
  const close = () => setDialog(null)
  const [text, setText] = useState(saved)
  const [message, setMessage] = useState<Message>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const runPreview = async () => {
    const parsed = parseTemplateVars(text)
    if (!parsed.ok) return setMessage({ tone: 'error', text: parsed.error })
    const editor = editorBridge.get()
    const sql = editor?.getSelection()?.text ?? editor?.getText() ?? ''
    if (!sql.trim()) return setMessage({ tone: 'info', text: 'The editor is empty, so there’s nothing to preview.' })
    setBusy(true)
    try {
      setPreview(await api.renderTemplate(sql, parsed.vars))
      setMessage(null)
    } catch (e) {
      setPreview(null)
      setMessage({ tone: 'error', text: describeError(toAppError(e), sql) })
    } finally {
      setBusy(false)
    }
  }

  const copy = async (sql: string) => {
    try {
      await copyText(sql)
      toast('Rendered SQL copied')
    } catch (e) {
      toast(toAppError(e).message, 'danger')
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault()
      void runPreview()
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = parseTemplateVars(text)
    if (!parsed.ok) return setMessage({ tone: 'error', text: parsed.error })
    setTemplateVars(text)
    toast('Template variables saved')
    close()
  }

  return (
    <Dialog
      wide
      title="Template variables"
      description="With Jinja on, the editor is rendered with these values before it runs, the way Superset’s SQL Lab does it."
      onClose={close}
    >
      <form onSubmit={submit}>
        <div className="dialog-body">
          <label className="field full">
            <span>Variables (JSON)</span>
            <textarea
              className="text-input mono code-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={12}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          <ul className="help-list full">
            <li>
              <code>from_dttm</code>, <code>to_dttm</code>: the time range as text, like <code>"2025-01-01 00:00:00"</code>, or{' '}
              <code>null</code>.
            </li>
            <li>
              <code>filters</code>: column → values, for <code>filter_values()</code> and <code>get_filters()</code>. A list means IN, as in{' '}
              <code>{'"Construction Stage": ["Removal"]'}</code>. For another operator use <code>{'{"op": "ILIKE", "val": "%wall%"}'}</code>.
            </li>
            <li>
              <code>url_params</code>: values for <code>url_param()</code>. Any other key is a plain variable, like <code>{'{{ limit }}'}</code>.
            </li>
          </ul>
          {message && (
            <div className={`form-message ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
              {message.text}
            </div>
          )}
          {preview != null && (
            <div className="field full">
              <div className="preview-head">
                <span>Rendered SQL</span>
                <span className="note">blank lines collapsed</span>
                <button type="button" className="link-btn" onClick={() => void copy(preview)}>
                  Copy
                </button>
              </div>
              <pre className="sql-preview">{tidy(preview) || '(empty)'}</pre>
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setText(DEFAULT_TEMPLATE_VARS)
              setMessage(null)
              setPreview(null)
            }}
          >
            Reset
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void runPreview()}
            disabled={busy}
            title={`Render what’s in the editor with these values (${shortcut('↵')})`}
          >
            {busy ? 'Rendering…' : 'Preview SQL'}
          </button>
          <button type="button" className="btn-secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" style={{ minHeight: 36, borderRadius: 8 }}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}
