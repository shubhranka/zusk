// The CodeMirror view lives inside <SqlEditor>; store actions reach it
// through this small bridge instead of mirroring the document into state
// on every keystroke.

export interface EditorDiagnostic {
  from: number
  to: number
  message: string
}

export interface EditorHandle {
  getText(): string
  /** Selected text and where it starts, or null when nothing is selected. */
  getSelection(): { text: string; from: number } | null
  setText(text: string): void
  /**
   * Replaces `from`–`to` with `text` as one undoable edit, and selects it.
   * With `select: false` the cursor goes after it instead.
   */
  replaceRange(from: number, to: number, text: string, options?: { select?: boolean }): void
  focus(): void
  showError(diagnostic: EditorDiagnostic | null): void
}

let handle: EditorHandle | null = null

export const editorBridge = {
  register(h: EditorHandle | null) {
    handle = h
  },
  get(): EditorHandle | null {
    return handle
  },
}
