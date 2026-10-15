import { useState, type FormEvent } from 'react'

import { api, toAppError } from '../lib/api'
import type { AiInput, AiProvider, AiStatus } from '../lib/types'
import { useApp } from '../store/app'
import { Dialog } from './Dialog'
import { EyeIcon } from './Icons'

const PROVIDERS: { value: AiProvider; label: string; help: string }[] = [
  { value: 'anthropic', label: 'Anthropic', help: 'Claude models through the Anthropic API.' },
  { value: 'gemini', label: 'Gemini', help: 'Google Gemini models. Get a key in Google AI Studio.' },
  { value: 'openai', label: 'OpenAI-compatible', help: 'OpenAI, OpenRouter, Ollama, LM Studio, or any server with a /chat/completions endpoint.' },
]

/** Common OpenAI-compatible servers; each just fills in the base URL. */
const PRESETS = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
]

const DEFAULTS: Record<AiProvider, { baseUrl: string; model: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.8-flash' },
  openai: { baseUrl: PRESETS[0].baseUrl, model: '' },
}

/** "Anthropic", "Gemini", or the host of an OpenAI-compatible server ("openrouter.ai"). */
export function aiProviderLabel(ai: Pick<AiStatus, 'provider' | 'baseUrl'>): string {
  if (ai.provider === 'anthropic') return 'Anthropic'
  if (ai.provider === 'gemini') return 'Gemini'
  try {
    return new URL(ai.baseUrl).host
  } catch {
    return 'OpenAI-compatible'
  }
}

type Message = { tone: 'ok' | 'error' | 'info'; text: string } | null

export function AiSettingsDialog() {
  const saved = useApp((s) => s.ai)
  const { setDialog, saveAiSettings, toast } = useApp.getState()
  const close = () => setDialog(null)

  const initial = saved ?? { provider: 'anthropic' as const, ...DEFAULTS.anthropic }
  const [provider, setProvider] = useState<AiProvider>(initial.provider)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [model, setModel] = useState(initial.model)
  const [apiKey, setApiKey] = useState('')
  const [forgetKey, setForgetKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [message, setMessage] = useState<Message>(null)

  // Each provider has its own keychain entry; we only know about the saved one's.
  const hasSavedKey = !!saved?.hasKey && saved.provider === provider

  const switchProvider = (next: AiProvider) => {
    const values = saved?.provider === next ? saved : DEFAULTS[next]
    setProvider(next)
    setBaseUrl(values.baseUrl)
    setModel(values.model)
    setForgetKey(false)
    setMessage(null)
  }

  const input = (): AiInput => ({
    provider,
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    // Blank keeps the keychain entry; "Forget" sends '' to remove it.
    apiKey: apiKey.trim() ? apiKey.trim() : forgetKey ? '' : undefined,
  })

  const test = async () => {
    setBusy('test')
    setMessage({ tone: 'info', text: `Asking ${model.trim() || 'the model'}…` })
    try {
      setMessage({ tone: 'ok', text: await api.testAi(input()) })
    } catch (e) {
      const err = toAppError(e)
      setMessage({ tone: 'error', text: err.hint ? `${err.message} ${err.hint}` : err.message })
    } finally {
      setBusy(null)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy('save')
    try {
      await saveAiSettings(input())
      toast('AI settings saved')
      close()
    } catch (err) {
      setMessage({ tone: 'error', text: toAppError(err).message })
      setBusy(null)
    }
  }

  const providerInfo = PROVIDERS.find((p) => p.value === provider)!
  const keyPlaceholder = hasSavedKey
    ? forgetKey
      ? 'Will be removed from the keychain'
      : 'Leave blank to keep the saved key'
    : provider === 'openai'
      ? 'Optional for local servers like Ollama'
      : provider === 'gemini'
        ? 'AIza…'
        : 'sk-ant-…'

  return (
    <Dialog
      title="AI provider"
      description="Fix with AI sends the failing statement, its error and table/column names to this provider, never row data. The key is stored in your system keychain."
      onClose={close}
    >
      <form onSubmit={submit}>
        <div className="dialog-body">
          <label className="field full">
            <span>Provider</span>
            <select className="select-input" value={provider} onChange={(e) => switchProvider(e.target.value as AiProvider)}>
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="help">{providerInfo.help}</span>
          </label>
          <div className="field full">
            <label className="field">
              <span>Base URL</span>
              <input
                className="text-input mono"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                spellCheck={false}
                autoCapitalize="off"
              />
            </label>
            {provider === 'openai' && (
              <div className="presets" role="group" aria-label="Base URL presets">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className="btn-secondary small"
                    aria-pressed={baseUrl.trim().replace(/\/+$/, '') === p.baseUrl}
                    onClick={() => setBaseUrl(p.baseUrl)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <label className="field full">
            <span>Model</span>
            <input
              className="text-input mono"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              required
              placeholder={DEFAULTS[provider].model || 'The model id your provider lists'}
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <label className="field full">
            <span>API key</span>
            <span className="password-wrap">
              <input
                className="text-input mono"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setForgetKey(false)
                }}
                placeholder={keyPlaceholder}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="btn-ghost-icon" aria-label={showKey ? 'Hide key' : 'Show key'} onClick={() => setShowKey((v) => !v)}>
                <EyeIcon size={15} off={showKey} />
              </button>
            </span>
            {hasSavedKey && !apiKey && (
              <span className="help">
                <button type="button" className="link-btn" onClick={() => setForgetKey((v) => !v)}>
                  {forgetKey ? 'Keep the saved key' : 'Forget the saved key'}
                </button>
              </span>
            )}
          </label>
          {message && (
            <div className={`form-message ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
              {message.text}
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <span className="spacer" />
          <button type="button" className="btn-secondary" onClick={() => void test()} disabled={busy !== null}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          <button type="button" className="btn-secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" style={{ minHeight: 36, borderRadius: 8 }} disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
