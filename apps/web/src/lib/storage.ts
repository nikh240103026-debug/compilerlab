// Browser storage can throw or come back empty (private windows, cleared data), so it is only
// ever a cache here. The source of truth is the local server's SQLite database.
export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Still works, just without the cache.
  }
}
