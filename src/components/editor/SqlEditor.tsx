import { useEffect, useRef } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands'
import { PostgreSQL, sql, SQLDialect, type SQLNamespace } from '@codemirror/lang-sql'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { setDiagnostics } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'

import { editorBridge } from '../../lib/editorBridge'
import { shortcut } from '../../lib/platform'
import { detailsKey, useApp, type TreeData } from '../../store/app'
import { editorTheme, qualifierHighlight, sqlHighlight } from './theme'

/** Tables, views and (already loaded) columns, for autocompletion. */
function namespaceFor(tree: TreeData | undefined): SQLNamespace {
  const ns: Record<string, Record<string, string[]>> = {}
  if (!tree) return ns
  for (const [schema, objects] of Object.entries(tree.objects)) {
    if (objects.state !== 'ready') continue
    const tables: Record<string, string[]> = {}
    for (const rel of [...objects.data.tables, ...objects.data.views]) {
      const details = tree.details[detailsKey(schema, rel.name)]
      tables[rel.name] = details?.state === 'ready' ? details.data.columns.map((c) => c.name) : []
    }
    ns[schema] = tables
  }
  return ns
}

// lang-sql's PostgreSQL dialect counts hundreds of non-reserved words (id,
// name, type, value, version, …) as keywords, which paints ordinary column
// names lilac. Keep its types and quoting rules, with a tighter keyword list.
const KEYWORDS =
  'abort add all alter always analyze and any array as asc at begin between both by call cascade case cast check ' +
  'collate column commit concurrently conflict constraint copy create cross current_date current_time ' +
  'current_timestamp current_user database deallocate declare default deferrable delete desc distinct do drop else ' +
  'end escape except exclude execute exists explain extension false fetch filter first following for foreign from ' +
  'full function generated grant group having identity if ilike in index inner insert intersect interval into is ' +
  'isnull join key language last lateral left like limit local localtime localtimestamp lock materialized natural ' +
  'next no not nothing notnull nowait null nulls of offset on only or order outer over overriding partition placing ' +
  'preceding prepare primary procedure range recursive references refresh release rename replace reset restrict ' +
  'return returning returns revoke right rollback row rows savepoint schema select sequence session_user set share ' +
  'show similar skip some start stored table tablesample temp temporary then ties to transaction trigger true ' +
  'truncate unbounded union unique unlogged until update user using vacuum values variadic verbose view when where ' +
  'window with within without zone'

const dialect = SQLDialect.define({ ...PostgreSQL.spec, keywords: KEYWORDS })

function sqlLanguage(schema: SQLNamespace) {
  return sql({ dialect, schema, defaultSchema: 'public', upperCaseKeywords: true })
}

export function SqlEditor({ onSelectionChange }: { onSelectionChange(hasSelection: boolean): void }) {
  const host = useRef<HTMLDivElement>(null)
  const selectionCallback = useRef(onSelectionChange)
  selectionCallback.current = onSelectionChange

  useEffect(() => {
    const language = new Compartment()
    const runKeys = Prec.highest(
      keymap.of([
        { key: 'Mod-Enter', run: () => (void useApp.getState().runQuery(), true) },
        { key: 'Mod-s', run: () => (useApp.getState().saveCurrentQuery(), true), preventDefault: true },
      ]),
    )

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: '',
        extensions: [
          runKeys,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, icons: false }),
          highlightSelectionMatches(),
          language.of(sqlLanguage({})),
          sqlHighlight,
          qualifierHighlight,
          editorTheme,
          placeholder(`-- Write SQL, then press ${shortcut('↵')} to run it. Select text to run just that part.`),
          EditorView.contentAttributes.of({ 'aria-label': 'SQL editor', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.selectionSet || u.docChanged) selectionCallback.current(!u.state.selection.main.empty)
          }),
        ],
      }),
    })

    editorBridge.register({
      getText: () => view.state.doc.toString(),
      getSelection: () => {
        const { from, to } = view.state.selection.main
        return from === to ? null : { text: view.state.sliceDoc(from, to), from }
      },
      setText: (text) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
          scrollIntoView: true,
        })
        view.dispatch(setDiagnostics(view.state, []))
      },
      replaceRange: (from, to, text) => {
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from, head: from + text.length },
          scrollIntoView: true,
          // Its own undo step, even when it lands right after typing.
          annotations: isolateHistory.of('full'),
        })
        view.dispatch(setDiagnostics(view.state, []))
      },
      focus: () => view.focus(),
      showError: (d) => {
        if (!d) {
          view.dispatch(setDiagnostics(view.state, []))
          return
        }
        const len = view.state.doc.length
        const from = Math.min(d.from, len)
        const to = Math.min(Math.max(d.to, from), len)
        view.dispatch(setDiagnostics(view.state, [{ from, to, severity: 'error', message: d.message }]))
        view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'nearest' }) })
      },
    })

    // Keep autocompletion in step with what the explorer has loaded.
    let lastTree: TreeData | undefined
    const syncSchema = (state: ReturnType<typeof useApp.getState>) => {
      const tree = state.activeId ? state.tree[state.activeId] : undefined
      if (tree === lastTree) return
      lastTree = tree
      view.dispatch({ effects: language.reconfigure(sqlLanguage(namespaceFor(tree))) })
    }
    syncSchema(useApp.getState())
    const unsubscribe = useApp.subscribe(syncSchema)

    return () => {
      unsubscribe()
      editorBridge.register(null)
      view.destroy()
    }
  }, [])

  return <div ref={host} style={{ height: '100%' }} />
}
