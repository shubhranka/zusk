import { writeText } from '@tauri-apps/plugin-clipboard-manager'

export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text)
  } catch {
    // Outside Tauri (plain browser during UI work) fall back to the web API.
    await navigator.clipboard.writeText(text)
  }
}
