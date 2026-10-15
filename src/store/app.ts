import { create } from 'zustand'

import { api, toAppError } from '../lib/api'
import { changedRange } from '../lib/diff'
import { editorBridge, type EditorHandle } from '../lib/editorBridge'
import { fixTarget, lineCol } from '../lib/fix'
import { previewQuery } from '../lib/format'
import { shortcut } from '../lib/platform'
import { load, loadList, loadString, save, saveString } from '../lib/storage'
import { DEFAULT_TEMPLATE_VARS, parseTemplateVars } from '../lib/template'
import type {
  AiInput,
  AiStatus,
  AppError,
  ConnectionInput,
  ConnectionProfile,
  FunctionInfo,
  Loadable,
  RelationKind,
  RelationRef,
  RunResult,
  SchemaInfo,
  SchemaObjects,
  ServerInfo,
  TableDetails,
  TxState,
} from '../lib/types'

// ------------------------------------------------------------------ types

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export const statusLabel: Record<ConnStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Not connected',
  error: 'Connection failed',
}

export interface ConnState {
  status: ConnStatus
  info?: ServerInfo
  error?: string
  tx: TxState
}

/** A table or view the editor is currently "about". */
export interface Target {
  connId: string
  schema: string
  name: string
  kind: RelationKind
}

export interface Doc {
  title: string
  fileName: string
  savedId?: string
  target?: Target
}

export interface SavedQuery {
  id: string
  name: string
  sql: string
  updatedAt: number
}

export type Density = 'comfortable' | 'compact'

export interface Settings {
  accent: string
  density: Density
  zebra: boolean
  editorHeight: number
  /** Render the editor as a Jinja template before running it. */
  jinja: boolean
  /** Show the chat panel beside the editor. */
  chatOpen: boolean
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  /** Assistant: the editor contents it proposed, and what the editor held when it was asked. */
  sql?: string
  before?: string
  /** Assistant: the editor changed while the reply was on its way, so it wasn't applied. */
  stale?: boolean
}

export interface ChatState {
  messages: ChatMessage[]
  status: 'idle' | 'working'
  /** Why the last request failed; it can be retried. */
  error?: AppError
  /** The message whose SQL the chat last put in the editor. */
  appliedId?: number
}

export type FixState = { status: 'working' } | { status: 'applied'; explanation: string } | { status: 'error'; error: AppError }

export interface RunState {
  status: 'idle' | 'running' | 'done' | 'error'
  connId?: string
  startedAt?: number
  /** The SQL that was run, and where it starts in the editor. */
  sql?: string
  offset?: number
  /** With Jinja on: `sql` rendered, which is what reached Postgres. */
  rendered?: string
  /** Last successful result; kept visible while the next run is going. */
  result?: RunResult
  error?: AppError
  /** 1-based editor line/column the error points at. */
  errorAt?: { line: number; col: number }
  /** "Fix with AI" for this run's error. */
  fix?: FixState
}

export interface TreeData {
  schemas?: Loadable<SchemaInfo[]>
  objects: Record<string, Loadable<SchemaObjects>>
  /** Keyed by detailsKey(schema, name). */
  details: Record<string, Loadable<TableDetails>>
  relations?: RelationRef[]
}

export type DialogState = { kind: 'connection'; id?: string } | { kind: 'saveQuery' } | { kind: 'ai' } | { kind: 'templateVars' } | null

export interface Toast {
  id: number
  text: string
  tone?: 'danger'
}

export type ResultView = 'data' | 'structure'
export type TreeGroup = 'tables' | 'views' | 'functions'

// ------------------------------------------------------------------ keys

const SETTINGS_KEY = 'zusk.settings'
const SAVED_KEY = 'zusk.savedQueries'
const LAST_CONN_KEY = 'zusk.lastConnection'
const TEMPLATE_VARS_KEY = 'zusk.templateVars'

export const ACCENTS = ['#F2A33A', '#6FB6F0', '#5CC8A8', '#E58FB8']

const DEFAULT_SETTINGS: Settings = { accent: ACCENTS[0], density: 'comfortable', zebra: true, editorHeight: 196, jinja: false, chatOpen: false }

export const nodeKey = (...parts: string[]) => parts.map(encodeURIComponent).join('/')
export const detailsKey = (schema: string, name: string) => `${schema}\u0000${name}`

const emptyTree = (): TreeData => ({ objects: {}, details: {} })

let runSeq = 0
let toastSeq = 0
let queryCounter = 1
let chatMessageSeq = 0
let chatSeq = 0

function message(e: unknown): string {
  return toAppError(e).message
}

// ------------------------------------------------------------------ store

export interface AppStore {
  settings: Settings
  readOnly: boolean
  profiles: ConnectionProfile[]
  conns: Record<string, ConnState>
  activeId: string | null
  tree: Record<string, TreeData>
  expanded: Record<string, boolean>
  treeFilter: string
  doc: Doc
  run: RunState
  view: ResultView
  rowFilter: string
  saved: SavedQuery[]
  dialog: DialogState
  toasts: Toast[]
  /** The saved AI provider, or null when it isn't set up. */
  ai: AiStatus | null
  /** JSON text of the Jinja template variables, as the user typed it. */
  templateVars: string
  chat: ChatState

  init(): Promise<void>
  updateSettings(patch: Partial<Settings>): void
  setReadOnly(value: boolean): Promise<void>
  toast(text: string, tone?: 'danger'): void
  setDialog(dialog: DialogState): void

  // connections
  saveConnection(input: ConnectionInput): Promise<ConnectionProfile>
  deleteConnection(id: string): Promise<void>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  setActive(id: string): void

  // explorer
  setTreeFilter(value: string): void
  toggleConnection(id: string): void
  toggleSchema(id: string, schema: string): void
  toggleGroup(id: string, schema: string, group: TreeGroup): void
  toggleTable(id: string, schema: string, name: string): void
  collapseAll(): void
  refresh(): Promise<void>
  loadDetails(id: string, schema: string, name: string, force?: boolean): Promise<void>
  loadRelations(id: string): Promise<RelationRef[]>

  // editor & results
  openTable(target: Target): void
  openFunction(id: string, schema: string, fn: FunctionInfo): Promise<void>
  newQuery(): void
  runQuery(): Promise<void>
  cancelQuery(): Promise<void>
  setView(view: ResultView): void
  setRowFilter(value: string): void
  setTemplateVars(text: string): void

  // AI
  saveAiSettings(input: AiInput): Promise<AiStatus>
  fixQuery(): Promise<void>

  // chat
  toggleChat(open?: boolean): void
  sendChat(text: string): Promise<void>
  retryChat(): Promise<void>
  /** Puts a reply's SQL in the editor again, e.g. one that arrived after the editor changed. */
  applyChat(id: number): void
  /** Puts back what the editor held before a reply, if nothing changed since. */
  revertChat(id: number): void
  clearChat(): void

  // saved queries
  saveCurrentQuery(): void
  saveQueryAs(name: string): void
  openSaved(id: string): void
  deleteSaved(id: string): void
}

export const useApp = create<AppStore>((set, get) => {
  const patchConn = (id: string, patch: Partial<ConnState>) =>
    set((s) => ({ conns: { ...s.conns, [id]: { ...(s.conns[id] ?? { status: 'disconnected', tx: 'idle' }), ...patch } } }))

  const patchTree = (id: string, fn: (t: TreeData) => TreeData) =>
    set((s) => ({ tree: { ...s.tree, [id]: fn(s.tree[id] ?? emptyTree()) } }))

  const expand = (key: string, open = true) => set((s) => ({ expanded: { ...s.expanded, [key]: open } }))

  const persistSaved = (saved: SavedQuery[]) => {
    save(SAVED_KEY, saved)
    set({ saved })
  }

  async function loadSchemas(id: string): Promise<SchemaInfo[]> {
    patchTree(id, (t) => ({ ...t, schemas: { state: 'loading' } }))
    try {
      const data = await api.listSchemas(id)
      patchTree(id, (t) => ({ ...t, schemas: { state: 'ready', data } }))
      return data
    } catch (e) {
      patchTree(id, (t) => ({ ...t, schemas: { state: 'error', error: message(e) } }))
      return []
    }
  }

  async function loadObjects(id: string, schema: string): Promise<void> {
    patchTree(id, (t) => ({ ...t, objects: { ...t.objects, [schema]: { state: 'loading' } } }))
    try {
      const data = await api.listSchemaObjects(id, schema)
      patchTree(id, (t) => ({ ...t, objects: { ...t.objects, [schema]: { state: 'ready', data } } }))
    } catch (e) {
      patchTree(id, (t) => ({ ...t, objects: { ...t.objects, [schema]: { state: 'error', error: message(e) } } }))
    }
  }

  function markDisconnectedIfGone(id: string, e: AppError) {
    if (e.kind === 'notConnected') patchConn(id, { status: 'disconnected', info: undefined })
  }

  /** Puts `sql` in the editor as one undoable edit that touches only what differs. */
  function putInEditor(editor: EditorHandle, sql: string) {
    const { from, to, text } = changedRange(editor.getText(), sql)
    editor.replaceRange(from, to, text, { select: false })
  }

  /** Sends the conversation, ending with the user's request, and applies the reply. */
  async function askChat() {
    const { ai, activeId, conns, settings, chat } = get()
    const editor = editorBridge.get()
    if (!editor) return
    if (!ai) {
      set({ dialog: { kind: 'ai' } })
      return
    }
    const before = editor.getText()
    const seq = ++chatSeq
    const patchChat = (patch: Partial<ChatState>) => set((s) => (seq === chatSeq ? { chat: { ...s.chat, ...patch } } : {}))
    patchChat({ status: 'working', error: undefined })
    try {
      const connId = activeId && conns[activeId]?.status === 'connected' ? activeId : null
      const turns = chat.messages.map(({ role, text, sql }) => ({ role, text, sql }))
      const result = await api.chatSql(connId, { sql: before, turns, jinja: settings.jinja })
      if (seq !== chatSeq) return
      const message: ChatMessage = { id: ++chatMessageSeq, role: 'assistant', text: result.reply }
      let appliedId = get().chat.appliedId
      if (result.sql != null) {
        message.sql = result.sql
        message.before = before
        // Only rewrite the editor if it still holds what the model saw.
        const current = editorBridge.get()
        if (current?.getText() === before) {
          putInEditor(current, result.sql)
          appliedId = message.id
        } else {
          message.stale = true
        }
      }
      patchChat({ status: 'idle', messages: [...get().chat.messages, message], appliedId })
    } catch (e) {
      patchChat({ status: 'idle', error: toAppError(e) })
    }
  }

  return {
    settings: load(SETTINGS_KEY, DEFAULT_SETTINGS),
    readOnly: true,
    profiles: [],
    conns: {},
    activeId: null,
    tree: {},
    expanded: {},
    treeFilter: '',
    doc: { title: 'query_1', fileName: 'query_1.sql' },
    run: { status: 'idle' },
    view: 'data',
    rowFilter: '',
    saved: loadList<SavedQuery>(SAVED_KEY),
    dialog: null,
    toasts: [],
    ai: null,
    templateVars: loadString(TEMPLATE_VARS_KEY) ?? DEFAULT_TEMPLATE_VARS,
    chat: { messages: [], status: 'idle' },

    async init() {
      try {
        const [profiles, readOnly, ai] = await Promise.all([api.listConnections(), api.getReadOnly(), api.getAiSettings()])
        set({ profiles, readOnly, ai })
        const last = loadString(LAST_CONN_KEY)
        const initial = profiles.find((p) => p.id === last) ?? (profiles.length === 1 ? profiles[0] : undefined)
        if (initial) {
          set({ activeId: initial.id })
          await get().connect(initial.id)
        }
      } catch (e) {
        get().toast(message(e), 'danger')
      }
    },

    updateSettings(patch) {
      const settings = { ...get().settings, ...patch }
      save(SETTINGS_KEY, settings)
      set({ settings })
    },

    async setReadOnly(value) {
      try {
        await api.setReadOnly(value)
        set((s) => ({
          readOnly: value,
          conns: Object.fromEntries(
            Object.entries(s.conns).map(([id, c]) => [id, { ...c, tx: value ? 'readOnly' : 'idle' } as ConnState]),
          ),
        }))
        get().toast(value ? 'Read-only mode is on' : 'Writes enabled — statements now commit')
      } catch (e) {
        get().toast(message(e), 'danger')
      }
    },

    toast(text, tone) {
      const id = ++toastSeq
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }))
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'danger' ? 5000 : 2400)
    },

    setDialog(dialog) {
      set({ dialog })
    },

    // -------------------------------------------------------------- connections

    async saveConnection(input) {
      const profile = await api.saveConnection(input)
      set((s) => {
        const exists = s.profiles.some((p) => p.id === profile.id)
        return { profiles: exists ? s.profiles.map((p) => (p.id === profile.id ? profile : p)) : [...s.profiles, profile] }
      })
      // The backend drops the live session when settings change; reconnect.
      patchConn(profile.id, { status: 'disconnected', info: undefined })
      void get().connect(profile.id)
      return profile
    },

    async deleteConnection(id) {
      await api.deleteConnection(id)
      set((s) => {
        const { [id]: _c, ...conns } = s.conns
        const { [id]: _t, ...tree } = s.tree
        const profiles = s.profiles.filter((p) => p.id !== id)
        const activeId = s.activeId === id ? (profiles.find((p) => conns[p.id]?.status === 'connected')?.id ?? null) : s.activeId
        const doc = s.doc.target?.connId === id ? { ...s.doc, target: undefined } : s.doc
        return { conns, tree, profiles, activeId, doc }
      })
      if (loadString(LAST_CONN_KEY) === id) saveString(LAST_CONN_KEY, null)
    },

    async connect(id) {
      patchConn(id, { status: 'connecting', error: undefined })
      expand(nodeKey('c', id))
      try {
        const info = await api.connect(id)
        patchConn(id, { status: 'connected', info, tx: get().readOnly ? 'readOnly' : 'idle' })
        set((s) => ({ tree: { ...s.tree, [id]: emptyTree() }, activeId: s.activeId ?? id }))
        if (get().activeId === id) saveString(LAST_CONN_KEY, id)
        const schemas = await loadSchemas(id)
        // Open public, or else the first schema that has any tables or views.
        const first = (schemas.find((s) => s.name === 'public' && s.relationCount > 0) ?? schemas.find((s) => s.relationCount > 0))?.name
        if (first) {
          expand(nodeKey('s', id, first))
          expand(nodeKey('g', id, first, 'tables'))
          await loadObjects(id, first)
        }
      } catch (e) {
        patchConn(id, { status: 'error', error: message(e), info: undefined })
      }
    },

    async disconnect(id) {
      await api.disconnect(id).catch(() => {})
      patchConn(id, { status: 'disconnected', info: undefined, error: undefined })
      set((s) => {
        const { [id]: _t, ...tree } = s.tree
        return { tree }
      })
    },

    setActive(id) {
      if (get().activeId === id) return
      set({ activeId: id })
      saveString(LAST_CONN_KEY, id)
    },

    // -------------------------------------------------------------- explorer

    setTreeFilter(value) {
      set({ treeFilter: value })
      if (!value.trim()) return
      // Filtering searches every schema, so load the ones not opened yet (once).
      const { conns, tree } = get()
      for (const [id, conn] of Object.entries(conns)) {
        const schemas = tree[id]?.schemas
        if (conn.status !== 'connected' || schemas?.state !== 'ready') continue
        for (const schema of schemas.data) {
          if (schema.relationCount > 0 && !tree[id].objects[schema.name]) void loadObjects(id, schema.name)
        }
      }
    },

    toggleConnection(id) {
      const key = nodeKey('c', id)
      const open = !get().expanded[key]
      expand(key, open)
      const conn = get().conns[id]
      if (open && conn?.status === 'connected' && !get().tree[id]?.schemas) void loadSchemas(id)
    },

    toggleSchema(id, schema) {
      const key = nodeKey('s', id, schema)
      const open = !get().expanded[key]
      expand(key, open)
      if (open && !get().tree[id]?.objects[schema]) {
        expand(nodeKey('g', id, schema, 'tables'))
        void loadObjects(id, schema)
      }
    },

    toggleGroup(id, schema, group) {
      const key = nodeKey('g', id, schema, group)
      expand(key, !get().expanded[key])
    },

    toggleTable(id, schema, name) {
      const key = nodeKey('t', id, schema, name)
      const open = !get().expanded[key]
      expand(key, open)
      if (open && !get().tree[id]?.details[detailsKey(schema, name)]) void get().loadDetails(id, schema, name)
    },

    collapseAll() {
      set({ expanded: {} })
    },

    async refresh() {
      const { conns, expanded, doc } = get()
      const connected = Object.keys(conns).filter((id) => conns[id].status === 'connected')
      await Promise.all(
        connected.map(async (id) => {
          set((s) => ({ tree: { ...s.tree, [id]: emptyTree() } }))
          const schemas = await loadSchemas(id)
          await Promise.all(
            schemas.filter((s) => expanded[nodeKey('s', id, s.name)]).map((s) => loadObjects(id, s.name)),
          )
          const tablePrefix = `${nodeKey('t', id)}/`
          const reloads = Object.keys(expanded)
            .filter((k) => expanded[k] && k.startsWith(tablePrefix))
            .map((k) => k.slice(tablePrefix.length).split('/').map(decodeURIComponent))
          if (doc.target?.connId === id) reloads.push([doc.target.schema, doc.target.name])
          await Promise.all(reloads.map(([schema, name]) => get().loadDetails(id, schema, name, true)))
        }),
      )
      if (connected.length) get().toast('Schema refreshed')
    },

    async loadDetails(id, schema, name, force = false) {
      const key = detailsKey(schema, name)
      const current = get().tree[id]?.details[key]
      if (!force && current && current.state !== 'error') return
      patchTree(id, (t) => ({ ...t, details: { ...t.details, [key]: { state: 'loading' } } }))
      try {
        const data = await api.describeTable(id, schema, name)
        patchTree(id, (t) => ({ ...t, details: { ...t.details, [key]: { state: 'ready', data } } }))
      } catch (e) {
        markDisconnectedIfGone(id, toAppError(e))
        patchTree(id, (t) => ({ ...t, details: { ...t.details, [key]: { state: 'error', error: message(e) } } }))
      }
    },

    async loadRelations(id) {
      const cached = get().tree[id]?.relations
      if (cached) return cached
      const relations = await api.listRelations(id)
      patchTree(id, (t) => ({ ...t, relations }))
      return relations
    },

    // -------------------------------------------------------------- editor

    openTable(target) {
      get().setActive(target.connId)
      set({
        doc: { title: target.name, fileName: `query_${target.name}.sql`, target },
        rowFilter: '',
      })
      editorBridge.get()?.setText(previewQuery(target.schema, target.name))
      void get().loadDetails(target.connId, target.schema, target.name)
      void get().runQuery()
    },

    async openFunction(id, schema, fn) {
      get().setActive(id)
      try {
        const definition = await api.functionDefinition(id, fn.oid)
        set({ doc: { title: `${fn.name}()`, fileName: `${schema}.${fn.name}.sql` } })
        editorBridge.get()?.setText(definition.trimEnd() + '\n')
        editorBridge.get()?.focus()
      } catch (e) {
        get().toast(message(e), 'danger')
      }
    },

    newQuery() {
      const n = ++queryCounter
      set({ doc: { title: `query_${n}`, fileName: `query_${n}.sql` }, run: { status: 'idle' }, rowFilter: '', view: 'data' })
      const editor = editorBridge.get()
      editor?.setText('')
      editor?.focus()
    },

    async runQuery() {
      const { activeId, conns, run, settings } = get()
      const editor = editorBridge.get()
      if (!editor) return
      if (!activeId || conns[activeId]?.status !== 'connected') {
        get().toast('Connect to a database first', 'danger')
        return
      }
      const selection = editor.getSelection()
      const sql = selection?.text ?? editor.getText()
      const offset = selection?.from ?? 0
      if (!sql.trim()) {
        get().toast('Nothing to run')
        return
      }
      if (run.status === 'running' && run.connId) await api.cancelQuery(run.connId).catch(() => {})

      const seq = ++runSeq
      editor.showError(null)
      set((s) => ({ run: { status: 'running', connId: activeId, startedAt: performance.now(), sql, offset, result: s.run.result } }))
      let rendered: string | undefined
      try {
        if (settings.jinja) {
          const parsed = parseTemplateVars(get().templateVars)
          if (!parsed.ok) throw { kind: 'template', message: parsed.error, hint: 'Fix them under Variables.' } satisfies AppError
          rendered = await api.renderTemplate(sql, parsed.vars)
          if (seq !== runSeq) return
        }
        const result = await api.runQuery(activeId, rendered ?? sql)
        if (seq !== runSeq) return
        set({ run: { status: 'done', connId: activeId, sql, offset, rendered, result } })
        patchConn(activeId, { tx: result.transaction })
      } catch (e) {
        if (seq !== runSeq) return
        const error = toAppError(e)
        // Once rendered, error positions point into the rendered SQL, which
        // isn't what the editor shows; the error panel shows that instead.
        const range = error.kind === 'cancelled' || rendered != null ? null : errorRange(sql, error)
        const errorAt = range ? lineCol(editor.getText(), offset + range[0]) : undefined
        set((s) => ({ run: { status: 'error', connId: activeId, sql, offset, rendered, error, errorAt, result: s.run.result } }))
        if (error.transaction) patchConn(activeId, { tx: error.transaction })
        markDisconnectedIfGone(activeId, error)
        if (range) editor.showError({ from: offset + range[0], to: offset + range[1], message: error.message })
      }
    },

    async cancelQuery() {
      const { run } = get()
      if (run.status !== 'running' || !run.connId) return
      await api.cancelQuery(run.connId).catch((e) => get().toast(message(e), 'danger'))
    },

    setView(view) {
      set({ view })
    },

    setRowFilter(value) {
      set({ rowFilter: value })
    },

    setTemplateVars(text) {
      saveString(TEMPLATE_VARS_KEY, text)
      set({ templateVars: text })
    },

    // -------------------------------------------------------------- AI

    async saveAiSettings(input) {
      const ai = await api.saveAiSettings(input)
      set({ ai })
      return ai
    },

    async fixQuery() {
      const { run, ai } = get()
      const editor = editorBridge.get()
      const { error, sql, offset = 0, connId } = run
      if (run.status !== 'error' || error?.kind !== 'database' || sql == null || !connId || !editor) return
      // The failing statement only exists in the rendered SQL, not in the editor.
      if (run.rendered != null) return
      if (run.fix?.status === 'working') return
      if (!ai) {
        set({ dialog: { kind: 'ai' } })
        return
      }

      // Only touch the editor if the failed statement is still where it was.
      const target = fixTarget(sql, error)
      const from = offset + target.from
      const to = offset + target.to
      const unchanged = () => editor.getText().slice(from, to) === target.text
      if (!unchanged()) {
        get().toast('The editor changed since this run. Run it again, then fix.')
        return
      }

      const seq = runSeq
      const setFix = (fix: FixState) => set((s) => (seq === runSeq ? { run: { ...s.run, fix } } : {}))
      setFix({ status: 'working' })
      try {
        const result = await api.fixSql(connId, {
          sql: target.text,
          message: error.message,
          detail: error.detail,
          hint: error.hint,
          code: error.code,
          line: target.line,
          col: target.col,
        })
        if (seq !== runSeq) return
        if (!unchanged()) {
          setFix({ status: 'error', error: { kind: 'invalid', message: 'The editor changed while the fix was on its way, so it wasn’t applied.' } })
          return
        }
        editor.replaceRange(from, to, result.sql)
        editor.focus()
        setFix({ status: 'applied', explanation: result.explanation })
      } catch (e) {
        setFix({ status: 'error', error: toAppError(e) })
      }
    },

    // -------------------------------------------------------------- chat

    toggleChat(open) {
      get().updateSettings({ chatOpen: open ?? !get().settings.chatOpen })
    },

    async sendChat(text) {
      const request = text.trim()
      if (!request || get().chat.status === 'working') return
      const message: ChatMessage = { id: ++chatMessageSeq, role: 'user', text: request }
      set((s) => ({ chat: { ...s.chat, messages: [...s.chat.messages, message] } }))
      await askChat()
    },

    async retryChat() {
      if (get().chat.status !== 'working') await askChat()
    },

    applyChat(id) {
      const message = get().chat.messages.find((m) => m.id === id)
      const editor = editorBridge.get()
      if (message?.sql == null || !editor) return
      putInEditor(editor, message.sql)
      set((s) => ({
        chat: { ...s.chat, appliedId: id, messages: s.chat.messages.map((m) => (m.id === id ? { ...m, stale: false } : m)) },
      }))
    },

    revertChat(id) {
      const message = get().chat.messages.find((m) => m.id === id)
      const editor = editorBridge.get()
      if (message?.sql == null || message.before == null || !editor) return
      // Don't throw away edits made after the reply.
      if (editor.getText() !== message.sql) {
        get().toast(`The editor changed since. Undo in the editor with ${shortcut('Z')} instead.`)
        return
      }
      putInEditor(editor, message.before)
      set((s) => ({ chat: { ...s.chat, appliedId: undefined } }))
    },

    clearChat() {
      // Drops a reply that is still on its way.
      chatSeq++
      set({ chat: { messages: [], status: 'idle' } })
    },

    // -------------------------------------------------------------- saved queries

    saveCurrentQuery() {
      const { doc, saved } = get()
      const sql = editorBridge.get()?.getText() ?? ''
      const existing = doc.savedId ? saved.find((q) => q.id === doc.savedId) : undefined
      if (!existing) {
        set({ dialog: { kind: 'saveQuery' } })
        return
      }
      persistSaved(saved.map((q) => (q.id === existing.id ? { ...q, sql, updatedAt: Date.now() } : q)))
      get().toast(`Saved “${existing.name}”`)
    },

    saveQueryAs(name) {
      const sql = editorBridge.get()?.getText() ?? ''
      const query: SavedQuery = { id: crypto.randomUUID(), name, sql, updatedAt: Date.now() }
      persistSaved([query, ...get().saved])
      set((s) => ({ doc: { ...s.doc, title: name, fileName: `${slug(name)}.sql`, savedId: query.id }, dialog: null }))
      get().toast(`Saved “${name}”`)
    },

    openSaved(id) {
      const query = get().saved.find((q) => q.id === id)
      if (!query) return
      set({ doc: { title: query.name, fileName: `${slug(query.name)}.sql`, savedId: query.id } })
      const editor = editorBridge.get()
      editor?.setText(query.sql)
      editor?.focus()
    },

    deleteSaved(id) {
      persistSaved(get().saved.filter((q) => q.id !== id))
      set((s) => (s.doc.savedId === id ? { doc: { ...s.doc, savedId: undefined } } : {}))
    },
  }
})

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'query'
  )
}

/** The part of `sql` to underline for an error, relative to `sql`. */
export function errorRange(sql: string, error: AppError): [number, number] | null {
  if (error.position != null) {
    const from = Math.min(error.position, sql.length)
    let to = from
    while (to < sql.length && /[\w$."]/.test(sql[to])) to++
    return [from, Math.max(to, Math.min(from + 1, sql.length))]
  }
  return error.statementRange ?? null
}
