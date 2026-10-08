// CodeMirror look matching the design: JetBrains Mono 13.5/24, line numbers
// in #5E656C, a 2px accent caret, keywords lilac, identifiers off-white,
// schema qualifiers blue, numbers amber.

import { RangeSetBuilder } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

export const editorTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--text)',
      backgroundColor: 'transparent',
      height: '100%',
      fontSize: '13.5px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '24px',
      overflow: 'auto',
    },
    '.cm-content': { padding: '14px 0', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 16px 0 0' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'var(--text-faint)',
      userSelect: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 16px', minWidth: '0' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.022)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
    '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    },
    '.cm-content ::selection': { backgroundColor: 'transparent' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(255, 255, 255, 0.07)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(255, 255, 255, 0.08)',
      outline: '1px solid var(--line-strong)',
    },
    '.cm-placeholder': { color: 'var(--text-faint)', fontStyle: 'normal' },
    '.cm-qualifier': { color: 'var(--c-ident)' },

    '.cm-tooltip': {
      border: '1px solid var(--line-strong)',
      backgroundColor: 'var(--surface-3)',
      borderRadius: '8px',
      overflow: 'hidden',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
    },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12.5px', maxHeight: '16em' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px !important', lineHeight: '20px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--accent-tint)',
      color: 'var(--text-bright)',
    },
    '.cm-completionDetail': { color: 'var(--text-dim)', fontStyle: 'normal', marginLeft: '12px' },
    '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)' },
    '.cm-completionIcon': { opacity: '0.55', width: '1.2em' },

    '.cm-lintRange-error': {
      backgroundImage: 'none',
      textDecoration: 'underline wavy var(--danger)',
      textDecorationSkipInk: 'none',
      textUnderlineOffset: '4px',
      backgroundColor: 'var(--danger-tint)',
    },
    '.cm-tooltip-lint': { padding: '0' },
    '.cm-diagnostic': { padding: '8px 12px', fontFamily: 'var(--font-sans)', fontSize: '12.5px' },
    '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)', color: 'var(--text)' },

    '.cm-panels': { backgroundColor: 'var(--surface-bar)', color: 'var(--text-2)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
    '.cm-panel.cm-search': { fontFamily: 'var(--font-sans)', fontSize: '12.5px', padding: '6px 10px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': {
      fontFamily: 'inherit',
      fontSize: '12.5px',
      borderRadius: '6px',
      border: '1px solid var(--line-strong)',
      backgroundColor: 'var(--bg)',
      color: 'var(--text)',
      backgroundImage: 'none',
    },
    '.cm-panel.cm-search label': { fontSize: '12.5px' },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' },
  },
  { dark: true },
)

export const sqlHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.bool, t.null], color: 'var(--c-keyword)' },
    { tag: t.typeName, color: 'var(--c-ident)' },
    { tag: t.number, color: 'var(--c-number)' },
    { tag: t.string, color: 'var(--c-string)' },
    { tag: t.special(t.string), color: 'var(--text)' },
    { tag: t.special(t.name), color: 'var(--c-number)' },
    { tag: t.standard(t.name), color: '#e7c99a' },
    { tag: [t.lineComment, t.blockComment], color: 'var(--null)', fontStyle: 'italic' },
    { tag: t.operator, color: 'var(--text-2)' },
    { tag: [t.punctuation, t.paren, t.squareBracket, t.brace], color: 'var(--text-muted)' },
    // Plain identifiers are left unstyled so they inherit the text colour
    // (and the schema-qualifier colour below).
  ]),
)

/** Colours the `public` in `public.orders` like the design does. */
const qualifierMark = Decoration.mark({ class: 'cm-qualifier' })

export const qualifierHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = this.build(update.view)
      }
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>()
      const { doc } = view.state
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter(node) {
            if ((node.name === 'Identifier' || node.name === 'QuotedIdentifier') && doc.sliceString(node.to, node.to + 1) === '.') {
              builder.add(node.from, node.to, qualifierMark)
            }
          },
        })
      }
      return builder.finish()
    }
  },
  { decorations: (v) => v.decorations },
)
