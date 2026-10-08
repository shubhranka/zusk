// Small per-machine preferences in localStorage (settings, saved queries,
// last connection). Reads and writes never throw.

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : { ...fallbackObject(fallback), ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

function fallbackObject<T>(fallback: T): object {
  return fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {}
}

export function loadList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    const value = raw == null ? [] : JSON.parse(raw)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function save(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full or blocked — preferences are best effort */
  }
}

export function loadString(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function saveString(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* best effort */
  }
}
