import type { AppSettings } from '@shared/types'
import { getDb } from './db'

export const DEFAULT_SETTINGS: AppSettings = {
  defaultTtsProvider: 'flowspeech',
  defaultLanguage: 'id',
  exportFolder: null,
  defaultLlmEndpointId: 'seed-sumopod',
  elevenModel: 'eleven_multilingual_v2',
  defaultImageEndpointId: null,
  defaultVideoEndpointId: null,
  whisperAuto: true,
  autoRetry: false
}

export function getSettings(): AppSettings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const out: AppSettings = { ...DEFAULT_SETTINGS }
  for (const r of rows) {
    if (!(r.key in out)) continue
    const value = JSON.parse(r.value)
    ;(out as unknown as Record<string, unknown>)[r.key] = value
  }
  if (out.defaultTtsProvider !== 'piper' && out.defaultTtsProvider !== 'elevenlabs' && out.defaultTtsProvider !== 'flowspeech') out.defaultTtsProvider = 'flowspeech'
  return out
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const stmt = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  getDb().transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue
      stmt.run(k, JSON.stringify(v))
    }
  })()
  return getSettings()
}

// ---------- small key/value cache (model lists) ----------

export function readCache<T>(key: string): { value: T; updatedAt: number } | null {
  const row = getDb().prepare('SELECT value, updated_at FROM cache WHERE key = ?').get(key) as
    | { value: string; updated_at: number }
    | undefined
  return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null
}

export function writeCache(key: string, value: unknown): number {
  const now = Date.now()
  getDb()
    .prepare('INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), now)
  return now
}

export function dropCache(prefix: string): void {
  getDb().prepare('DELETE FROM cache WHERE key LIKE ?').run(`${prefix}%`)
}
