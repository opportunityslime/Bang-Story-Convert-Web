import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiProvider, KeyStatus } from '@shared/types'
import { getDb } from './db'
import { dataDir } from './paths'

const PROVIDERS: ApiProvider[] = ['elevenlabs']

export const PROVIDER_NAMES: Record<ApiProvider, string> = {
  elevenlabs: 'ElevenLabs'
}

interface SecretRow {
  provider: ApiProvider
  value: Buffer
  last_ok: number | null
  last_message: string | null
  checked_at: number | null
}

// Stored value layout: iv (12 bytes) | auth tag (16 bytes) | ciphertext.
const IV_LEN = 12
const TAG_LEN = 16

/** The 32-byte master key lives in the data dir (0600); generated on first use. */
function loadMasterKey(): Buffer {
  const file = join(dataDir(), '.secret')
  if (existsSync(file)) {
    const raw = readFileSync(file)
    if (raw.length === 32) return raw
    // Corrupt key file: regenerate so new secrets stay usable (old rows become unreadable).
  }
  const key = randomBytes(32)
  writeFileSync(file, key, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows ignores POSIX modes; the file already sits in the user's own data dir.
  }
  return key
}

let cachedKey: Buffer | null = null
const masterKey = (): Buffer => (cachedKey ??= loadMasterKey())

/**
 * Replaces Electron's safeStorage (DPAPI). Called once at server start so the master key file is
 * on disk long before the user saves an API key; a crash right after saving cannot orphan it.
 */
export function warmUpEncryption(): void {
  try {
    masterKey()
  } catch {
    // Encryption unavailable; keys fall back to plain storage below.
  }
}

export function encrypt(value: string): Buffer {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

export function decrypt(value: Buffer): string | null {
  try {
    if (value.length < IV_LEN + TAG_LEN + 1) return null
    const iv = value.subarray(0, IV_LEN)
    const tag = value.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const ciphertext = value.subarray(IV_LEN + TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

function mask(key: string): string {
  if (key.length <= 10) return '•'.repeat(Math.max(4, key.length))
  return `${key.slice(0, Math.min(8, Math.floor(key.length / 3)))}${'•'.repeat(10)}${key.slice(-4)}`
}

function row(provider: ApiProvider): SecretRow | undefined {
  return getDb().prepare('SELECT * FROM secrets WHERE provider = ?').get(provider) as SecretRow | undefined
}

export function setSecret(provider: ApiProvider, value: string): void {
  const enc = encrypt(value)
  getDb()
    .prepare(
      `INSERT INTO secrets (provider, value) VALUES (?, ?)
       ON CONFLICT(provider) DO UPDATE SET value = excluded.value, last_ok = NULL, last_message = NULL, checked_at = NULL`
    )
    .run(provider, enc)
}

export function getSecret(provider: ApiProvider): string | null {
  const r = row(provider)
  if (!r || r.value.length === 0) return null
  const value = decrypt(r.value)
  if (value == null)
    throw new Error(
      `Kunci ${PROVIDER_NAMES[provider]} tersimpan tapi tidak bisa dibuka lagi (biasanya karena file kunci di folder data hilang atau rusak). Masukkan ulang kuncinya di Pengaturan.`
    )
  return value
}

export function requireSecret(provider: ApiProvider): string {
  const key = getSecret(provider)
  if (!key) throw new Error(`Kunci API ${PROVIDER_NAMES[provider]} belum diatur. Buka Pengaturan untuk menambahkannya.`)
  return key
}

/** Full key for the "show key" button; null when missing or unreadable. */
export function revealSecret(provider: ApiProvider): string | null {
  const r = row(provider)
  return r && r.value.length ? decrypt(r.value) : null
}

export function clearSecret(provider: ApiProvider): void {
  getDb().prepare('DELETE FROM secrets WHERE provider = ?').run(provider)
}

export function recordCheck(provider: ApiProvider, ok: boolean, message: string): void {
  const now = Date.now()
  const res = getDb()
    .prepare('UPDATE secrets SET last_ok = ?, last_message = ?, checked_at = ? WHERE provider = ?')
    .run(ok ? 1 : 0, message, now, provider)
  if (res.changes === 0) {
    getDb()
      .prepare('INSERT INTO secrets (provider, value, last_ok, last_message, checked_at) VALUES (?, ?, ?, ?, ?)')
      .run(provider, Buffer.alloc(0), ok ? 1 : 0, message, now)
  }
}

export function keyStatuses(): KeyStatus[] {
  const rows = getDb().prepare('SELECT * FROM secrets').all() as SecretRow[]
  return PROVIDERS.map((provider) => {
    const r = rows.find((x) => x.provider === provider)
    const hasKey = !!r && r.value.length > 0
    const value = hasKey ? decrypt(r!.value) : null
    const unreadable = hasKey && value == null
    return {
      provider,
      configured: hasKey,
      lastOk: unreadable ? false : r?.last_ok == null ? null : r.last_ok === 1,
      lastMessage: unreadable ? 'Kunci tersimpan tapi tidak bisa dibuka lagi. Masukkan ulang kuncinya.' : (r?.last_message ?? null),
      checkedAt: r?.checked_at ?? null,
      preview: value ? mask(value) : null,
      unreadable
    }
  })
}
