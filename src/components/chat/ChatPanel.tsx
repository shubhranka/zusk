import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { toAppError } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { diffLines, withContext } from '../../lib/diff'
import { editorBridge } from '../../lib/editorBridge'
import { plural } from '../../lib/format'
import { shortcut } from '../../lib/platform'
import { useApp, type ChatMessage, type ChatMode } from '../../store/app'
import { CheckIcon, CloseIcon, PlusIcon, SendIcon, SparkleIcon, StopIcon } from '../Icons'
import { AgentThread } from './AgentThread'

/** What's typed but not sent survives closing the panel, per tab. */
const drafts: Record<ChatMode, string> = { edit: '', agent: '' }

export function ChatPanel() {
  const ai = useApp((s) => s.ai)
  const mode = useApp((s) => s.settings.chatMode)
  const canClear = useApp((s) => {
    const { messages, status, error } = mode === 'agent' ? s.agent : s.chat
    return messages.length > 0 || status === 'working' || !!error
  })
  const { toggleChat, clearChat, clearAgent, setChatMode, setDialog } = useApp.getState()

  return (
    <aside className="chat" aria-label="Chat">
      <div className="chat-head">
        <SparkleIcon />
        <div className="chat-modes" role="tablist" aria-label="Chat mode">
          <button role="tab" aria-selected={mode === 'edit'} onClick={() => setChatMode('edit')} title="Rewrite the SQL in the editor">
            Edit SQL
          </button>
          <button
            role="tab"
            aria-selected={mode === 'agent'}
            onClick={() => setChatMode('agent')}
            title="Ask anything about your data; the agent explores your connections read-only"
          >
            Agent
          </button>
        </div>
        <span className="model" title={ai?.model}>
          {ai?.model}
        </span>
        <button
          className="btn-ghost-icon"
          onClick={mode === 'agent' ? clearAgent : clearChat}
          disabled={!canClear}
          aria-label="New chat"
          title="New chat"
        >
          <PlusIcon size={15} />
        </button>
        <button
          className="btn-ghost-icon"
          onClick={() => {
            toggleChat(false)
            editorBridge.get()?.focus()
          }}
          aria-label="Close chat"
          title={`Close (${shortcut('J')})`}
        >
          <CloseIcon />
        </button>
      </div>
      {ai ? (
        <>
          {mode === 'agent' ? <AgentThread /> : <Thread />}
          <Composer key={mode} mode={mode} />
        </>
      ) : (
        <div className="chat-thread">
          <div className="chat-empty">
            <strong>Set up an AI provider</strong>
            <span>
              {mode === 'agent'
                ? 'The agent answers questions about your databases by exploring them with read-only queries, with Anthropic, Gemini or any OpenAI-compatible server.'
                : 'The chat rewrites the SQL in the editor from plain-language requests, with Anthropic, Gemini or any OpenAI-compatible server.'}
            </span>
            <button className="btn-secondary small" onClick={() => setDialog({ kind: 'ai' })}>
              Set up AI…
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}

function Thread() {
  const chat = useApp((s) => s.chat)
  const { retryChat, setDialog } = useApp.getState()
  const scroller = useRef<HTMLDivElement>(null)

  // Keep the latest message in view.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.messages.length, chat.status, chat.error])

  return (
    <div ref={scroller} className="chat-thread" role="log">
      {chat.messages.length === 0 && !chat.error && (
        <div className="chat-empty">
          <strong>Ask for a change</strong>
          <span>Say what the SQL should do, like “only orders from the last 30 days” or “add the customer’s email”, or ask what it does.</span>
          <span>Changes go straight into the editor. Nothing runs until you run it.</span>
        </div>
      )}
      {chat.messages.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} className="chat-msg user">
            {m.text}
          </div>
        ) : (
          <div key={m.id} className="chat-msg">
            <div className="text">{m.text}</div>
            {m.sql != null && <Change message={m} applied={chat.appliedId === m.id} />}
          </div>
        ),
      )}
      {chat.status === 'working' && (
        <div className="chat-working">
          <span className="dot connecting" />
          Thinking…
        </div>
      )}
      {chat.error && (
        <div className="fix-note error" role="alert">
          <span>
            {chat.error.message}
            {chat.error.hint ? ` ${chat.error.hint}` : ''}
          </span>
          <span className="actions">
            {chat.error.kind === 'ai' && (
              <button className="link-btn" onClick={() => setDialog({ kind: 'ai' })}>
                AI settings
              </button>
            )}
            <button className="link-btn" onClick={() => void retryChat()}>
              Retry
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

/** What a reply changed, as a line diff against the editor it was asked about. */
function Change({ message, applied }: { message: ChatMessage; applied: boolean }) {
  const { applyChat, revertChat, toast } = useApp.getState()
  const sql = message.sql!
  const lines = useMemo(() => diffLines(message.before ?? '', sql), [message.before, sql])
  const rows = useMemo(() => lines && withContext(lines), [lines])
  const added = lines?.filter((l) => l.kind === 'add').length ?? 0
  const removed = lines?.filter((l) => l.kind === 'del').length ?? 0

  const copy = async () => {
    try {
      await copyText(sql)
      toast('SQL copied')
    } catch (e) {
      toast(toAppError(e).message, 'danger')
    }
  }

  return (
    <div className="chat-change">
      <pre className="chat-diff" aria-label="Changes to the SQL">
        {rows ? (
          rows.map((r, i) =>
            r.kind === 'skip' ? (
              <div key={i} className="skip">
                {plural(r.count, 'unchanged line')}
              </div>
            ) : (
              <div key={i} className={r.kind}>
                {r.text || ' '}
              </div>
            ),
          )
        ) : (
          <div className="same">{sql}</div>
        )}
      </pre>
      {message.stale && !applied && (
        <div className="chat-stale">The editor changed while this was on its way, so it wasn’t applied. Apply replaces the editor, including those changes.</div>
      )}
      <div className="foot">
        {applied ? (
          <>
            <span className="applied">
              <CheckIcon />
              Applied
            </span>
            <button className="link-btn" onClick={() => revertChat(message.id)} title="Put back what the editor held before">
              Undo
            </button>
          </>
        ) : (
          <button className="btn-secondary small" onClick={() => applyChat(message.id)} title="Put this SQL in the editor">
            Apply
          </button>
        )}
        {lines && (
          <span className="counts" aria-label={`${plural(added, 'line')} added, ${plural(removed, 'line')} removed`}>
            <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
          </span>
        )}
        <button className="link-btn copy" onClick={() => void copy()}>
          Copy
        </button>
      </div>
    </div>
  )
}

function Composer({ mode }: { mode: ChatMode }) {
  const working = useApp((s) => (mode === 'agent' ? s.agent.status : s.chat.status) === 'working')
  const { sendChat, sendAgent, stopAgent } = useApp.getState()
  const [text, setText] = useState(drafts[mode])
  const input = useRef<HTMLTextAreaElement>(null)
  const agent = mode === 'agent'

  // Grow with the text, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const edit = (value: string) => {
    drafts[mode] = value
    setText(value)
  }
  const send = () => {
    if (!text.trim() || working) return
    void (agent ? sendAgent(text) : sendChat(text))
    edit('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line, and Mod+Enter still runs the editor.
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="chat-composer">
      <div className="box">
        <textarea
          id="chat-input"
          ref={input}
          className="chat-input input-bare"
          rows={1}
          value={text}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={agent ? 'Ask about your data…' : 'Ask for a change…'}
          aria-label="Message"
          autoFocus
        />
        {agent && working ? (
          <button className="chat-send stop" onClick={stopAgent} aria-label="Stop" title="Stop">
            <StopIcon />
          </button>
        ) : (
          <button className="chat-send" onClick={send} disabled={!text.trim() || working} aria-label="Send" title="Send (↵)">
            <SendIcon />
          </button>
        )}
      </div>
      <div className="hint">
        ↵ send · ⇧↵ new line · {agent ? 'read-only, across your connections' : `${shortcut('↵')} run the editor`}
      </div>
    </div>
  )
}
