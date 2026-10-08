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
