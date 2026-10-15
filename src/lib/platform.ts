export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Label for the primary modifier key: "⌘" on macOS, "Ctrl+" elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl+'

export const shortcut = (key: string) => `${MOD}${key}`

/** Focuses the ⌘K "jump to" box in the header. */
export const focusJumpBox = () => document.getElementById('jump-input')?.focus()

/** Focuses the chat panel's message box, when it's open. */
export const focusChatInput = () => document.getElementById('chat-input')?.focus()
