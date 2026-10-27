import { useEffect } from 'react'

import { AiSettingsDialog } from './components/AiSettingsDialog'
import { ChatPanel } from './components/chat/ChatPanel'
import { ConnectionDialog } from './components/connections/ConnectionDialog'
import { Explorer } from './components/explorer/Explorer'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { SaveQueryDialog } from './components/SaveQueryDialog'
import { TemplateVarsDialog } from './components/TemplateVarsDialog'
import { Workspace } from './components/Workspace'
import { editorBridge } from './lib/editorBridge'
import { focusChatInput, focusJumpBox, isMac } from './lib/platform'
import { useApp } from './store/app'

let started = false

export function App() {
  const accent = useApp((s) => s.settings.accent)
  const density = useApp((s) => s.settings.density)
  const dialog = useApp((s) => s.dialog)
  const toasts = useApp((s) => s.toasts)
  const chatOpen = useApp((s) => s.settings.chatOpen)

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent)
  }, [accent])

  useEffect(() => {
    document.documentElement.dataset.density = density
  }, [density])

  useEffect(() => {
    // StrictMode mounts twice in development; connect only once.
    if (started) return
    started = true
    void useApp.getState().init()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod || e.altKey) return
      const key = e.key.toLowerCase()
      const inEditor = (e.target as HTMLElement | null)?.closest?.('.cm-editor')
      if (key === 'k') {
        e.preventDefault()
        focusJumpBox()
      } else if (key === 's' && !inEditor) {
        e.preventDefault()
        useApp.getState().saveCurrentQuery()
      } else if (key === 'enter' && !inEditor && !useApp.getState().dialog) {
        e.preventDefault()
        void useApp.getState().runQuery()
      } else if (key === 'j') {
        // Open the chat, focus it if it's open, or close it from inside.
        e.preventDefault()
        const { settings, toggleChat } = useApp.getState()
        if (!settings.chatOpen) toggleChat(true)
        else if (!(e.target as HTMLElement | null)?.closest?.('.chat')) focusChatInput()
        else {
          toggleChat(false)
          editorBridge.get()?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <Header />
      <div className="app-body">
        <Explorer />
        <Workspace />
        {chatOpen && <ChatPanel />}
      </div>
      <Footer />

      {dialog?.kind === 'connection' && <ConnectionDialog key={dialog.id ?? 'new'} id={dialog.id} />}
      {dialog?.kind === 'saveQuery' && <SaveQueryDialog />}
      {dialog?.kind === 'ai' && <AiSettingsDialog />}
      {dialog?.kind === 'templateVars' && <TemplateVarsDialog />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={t.tone === 'danger' ? 'toast danger' : 'toast'}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
