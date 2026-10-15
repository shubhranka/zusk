import { useEffect, useRef, useState } from 'react'

import { shortcut } from '../lib/platform'
import { ACCENTS, statusLabel, useApp } from '../store/app'
import { aiProviderLabel } from './AiSettingsDialog'
import { GearIcon, LogoIcon, PlusIcon } from './Icons'
import { JumpBox } from './JumpBox'

export function Header() {
  const newQuery = useApp((s) => s.newQuery)
  return (
    <header className="app-header">
      <div className="brand">
        <LogoIcon />
        <span className="brand-name">Zusk</span>
      </div>
      <ConnectionPill />
      <JumpBox />
      <div className="header-actions">
        <button className="btn-primary" onClick={newQuery}>
          <PlusIcon />
          New query
        </button>
        <SettingsButton />
      </div>
    </header>
  )
}

function ConnectionPill() {
  const profile = useApp((s) => s.profiles.find((p) => p.id === s.activeId))
  const conn = useApp((s) => (s.activeId ? s.conns[s.activeId] : undefined))
  const setDialog = useApp((s) => s.setDialog)

  if (!profile) {
    return (
      <button className="conn-pill" onClick={() => setDialog({ kind: 'connection' })}>
        <span className="dot disconnected" />
        <span className="meta">Add a connection</span>
      </button>
    )
  }

  const status = conn?.status ?? 'disconnected'
  const info = conn?.info
  const meta = info
    ? `PostgreSQL ${info.version} · ${info.host}:${info.port}${info.ssl ? ' · SSL' : ''}`
    : `${statusLabel[status]} · ${profile.host}:${profile.port}`

  return (
    <button className="conn-pill" onClick={() => setDialog({ kind: 'connection', id: profile.id })} title="Edit connection">
      <span className={`dot ${status === 'connected' ? '' : status}`} />
      <span className="name">{profile.name}</span>
      <span className="meta">{meta}</span>
    </button>
  )
}

function SettingsButton() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const ai = useApp((s) => s.ai)
  const setDialog = useApp((s) => s.setDialog)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn-icon" aria-label="Settings" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <GearIcon />
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Settings">
          <h2>Appearance</h2>
          <div className="field-row">
            <span className="label">Accent</span>
            <div className="swatches" role="radiogroup" aria-label="Accent colour">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  className="swatch"
                  role="radio"
                  aria-checked={settings.accent === c}
                  aria-label={c}
                  style={{ background: c }}
                  onClick={() => updateSettings({ accent: c })}
                />
              ))}
            </div>
          </div>
          <div className="field-row">
            <span className="label">Row density</span>
            <div className="segmented small" role="group" aria-label="Row density">
              <button aria-pressed={settings.density === 'comfortable'} onClick={() => updateSettings({ density: 'comfortable' })}>
                Comfortable
              </button>
              <button aria-pressed={settings.density === 'compact'} onClick={() => updateSettings({ density: 'compact' })}>
                Compact
              </button>
            </div>
          </div>
          <button className="switch-row switch-btn" role="switch" aria-checked={settings.zebra} onClick={() => updateSettings({ zebra: !settings.zebra })}>
            Zebra rows
            <span className="track" aria-hidden />
          </button>
          <h2>AI</h2>
          <div className="field-row">
            <span className="label">{ai ? `${aiProviderLabel(ai)} · ${ai.model}` : 'Not set up. Fix with AI corrects failed queries.'}</span>
            <button
              className="btn-secondary small"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                setOpen(false)
                setDialog({ kind: 'ai' })
              }}
            >
              {ai ? 'Change provider…' : 'Set up…'}
            </button>
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {shortcut('K')} jump · {shortcut('↵')} run · {shortcut('S')} save query
          </span>
        </div>
      )}
    </div>
  )
}
