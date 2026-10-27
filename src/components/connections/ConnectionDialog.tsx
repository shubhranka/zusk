import { useState, type FormEvent } from 'react'

import { api, toAppError } from '../../lib/api'
import type { ConnectionInput, SslMode } from '../../lib/types'
import { useApp } from '../../store/app'
import { Dialog } from '../Dialog'
import { EyeIcon } from '../Icons'

const SSL_MODES: { value: SslMode; label: string; help: string }[] = [
  { value: 'disable', label: 'disable', help: 'Never use TLS.' },
  { value: 'prefer', label: 'prefer (default)', help: 'Use TLS when the server offers it. The certificate is not checked.' },
  { value: 'require', label: 'require', help: 'Always use TLS. The certificate is not checked.' },
  { value: 'verify-ca', label: 'verify-ca', help: 'Always use TLS, and the certificate must be signed by a CA your system trusts.' },
  { value: 'verify-full', label: 'verify-full', help: 'Like verify-ca, and the certificate must also match the host name.' },
]

type Message = { tone: 'ok' | 'error' | 'info'; text: string } | null

export function ConnectionDialog({ id }: { id?: string }) {
  const existing = useApp((s) => (id ? s.profiles.find((p) => p.id === id) : undefined))
  const { setDialog, saveConnection, deleteConnection } = useApp.getState()
  const close = () => setDialog(null)

  const [name, setName] = useState(existing?.name ?? '')
  const [host, setHost] = useState(existing?.host ?? 'localhost')
  const [port, setPort] = useState(String(existing?.port ?? 5432))
  const [database, setDatabase] = useState(existing?.database ?? '')
  const [user, setUser] = useState(existing?.user ?? '')
  const [password, setPassword] = useState('')
  const [forgetPassword, setForgetPassword] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [sslMode, setSslMode] = useState<SslMode>(existing?.sslMode ?? 'prefer')
  const [busy, setBusy] = useState<'test' | 'save' | 'delete' | null>(null)
  const [message, setMessage] = useState<Message>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const input = (): ConnectionInput | null => {
    const portNumber = Number(port)
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setMessage({ tone: 'error', text: 'Port must be a number between 1 and 65535.' })
      return null
    }
    return {
      id: existing?.id,
      name: name.trim() || database.trim(),
      host: host.trim(),
      port: portNumber,
      database: database.trim(),
      user: user.trim(),
      sslMode,
      // Blank keeps the keychain entry when editing; "Forget" sends '' to remove it.
      password: password ? password : forgetPassword ? '' : undefined,
    }
  }

  const test = async () => {
    const data = input()
    if (!data) return
    setBusy('test')
    setMessage({ tone: 'info', text: `Connecting to ${data.host}:${data.port}…` })
    try {
      const info = await api.testConnection(data)
      setMessage({ tone: 'ok', text: `Connected · PostgreSQL ${info.version} · ${info.ssl ? 'SSL' : 'no SSL'} · ${info.user}@${info.database}` })
    } catch (e) {
      setMessage({ tone: 'error', text: toAppError(e).message })
    } finally {
      setBusy(null)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const data = input()
    if (!data) return
    setBusy('save')
    try {
      await saveConnection(data)
      close()
    } catch (err) {
      setMessage({ tone: 'error', text: toAppError(err).message })
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!existing) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setBusy('delete')
    try {
      await deleteConnection(existing.id)
      close()
    } catch (err) {
      setMessage({ tone: 'error', text: toAppError(err).message })
      setBusy(null)
    }
  }

  const ssl = SSL_MODES.find((m) => m.value === sslMode)!

  return (
    <Dialog
      title={existing ? `Edit ${existing.name}` : 'New connection'}
      description="PostgreSQL connection. The password is stored in your system keychain, never in a file."
      onClose={close}
    >
      <form onSubmit={submit}>
        <div className="dialog-body">
          <label className="field full">
            <span>Name</span>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={database || 'shop_dev'} />
          </label>
          <label className="field" style={{ gridColumn: '1 / 2' }}>
            <span>Host</span>
            <input className="text-input mono" value={host} onChange={(e) => setHost(e.target.value)} required spellCheck={false} autoCapitalize="off" />
          </label>
          <label className="field">
            <span>Port</span>
            <input className="text-input mono" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" required />
          </label>
          <label className="field">
            <span>Database</span>
            <input
              className="text-input mono"
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              required
              placeholder="postgres"
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label className="field">
            <span>User</span>
            <input
              className="text-input mono"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              required
              placeholder="postgres"
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label className="field full">
            <span>Password</span>
            <span className="password-wrap">
              <input
                className="text-input mono"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  setForgetPassword(false)
                }}
                placeholder={existing ? (forgetPassword ? 'Will be removed from the keychain' : 'Leave blank to keep the saved password') : 'Optional'}
                autoComplete="off"
              />
              <button
                type="button"
                className="btn-ghost-icon"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((v) => !v)}
              >
                <EyeIcon size={15} off={showPassword} />
              </button>
            </span>
            {existing && !password && (
              <span className="help">
                <button
                  type="button"
                  onClick={() => setForgetPassword((v) => !v)}
                  style={{ border: 0, background: 'none', padding: 0, color: 'var(--accent)', fontSize: 12 }}
                >
                  {forgetPassword ? 'Keep the saved password' : 'Forget the saved password'}
                </button>
              </span>
            )}
          </label>
          <label className="field full">
            <span>SSL mode</span>
            <select className="select-input mono" value={sslMode} onChange={(e) => setSslMode(e.target.value as SslMode)}>
              {SSL_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="help">{ssl.help}</span>
          </label>
          {message && (
            <div className={`form-message ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
              {message.text}
            </div>
          )}
        </div>
        <div className="dialog-foot">
          {existing && (
            <button type="button" className="btn-secondary btn-danger" onClick={() => void remove()} disabled={busy !== null}>
              {confirmDelete ? 'Click again to remove' : 'Remove'}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn-secondary" onClick={() => void test()} disabled={busy !== null}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          <button type="button" className="btn-secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" style={{ minHeight: 36, borderRadius: 8 }} disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : existing ? 'Save & reconnect' : 'Save & connect'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
