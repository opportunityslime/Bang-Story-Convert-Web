import { randomUUID } from 'node:crypto'
import type { CustomEndpoint, EndpointDialect, EndpointKind, NewEndpointInput } from '@shared/types'
import { getDb } from './db'
import { decrypt, encrypt } from './secrets'

/**
 * User-managed AI endpoints. Instead of hardcoded providers, every LLM / image / video
 * service is a row here: a name, a base URL, an encrypted API key and a model.
 *
 * Contracts:
 * - llm:   OpenAI-compatible. POST {baseUrl}/chat/completions with
 *          {model, messages, response_format: {type: 'json_object'}}.
 * - image: OpenAI-compatible. POST {baseUrl}/images/generations with
 *          {model, prompt, size, n: 1, response_format: 'b64_json'}.
 * - video: Bang Story contract. POST {baseUrl}/generate with
 *          {model, prompt, ratio, imageBase64?, imageUrl?, durationSec?}
 *          answers {videoUrl} (sync) or {taskId} (async); then
 *          GET {baseUrl}/status?taskId=... answers
 *          {status: 'pending'|'done'|'failed', videoUrl?, error?}.
 */

export const ENDPOINT_KINDS: EndpointKind[] = ['llm', 'image', 'video']

/** The Sumopod entry seeded on first run; kept as plain data so the user can delete it. */
export const SEED_SUMOPOD_ID = 'seed-sumopod'

interface EndpointRow {
  id: string
  kind: EndpointKind
  name: string
  base_url: string
  api_key: Buffer
  model: string
  dialect: EndpointDialect
  detected_dialect: EndpointDialect | null
  created_at: number
  updated_at: number
}

const DIALECTS: EndpointDialect[] = ['auto', 'openai', 'bangstory', 'gemini']

function cleanDialect(raw: unknown): EndpointDialect {
  return DIALECTS.includes(raw as EndpointDialect) ? (raw as EndpointDialect) : 'auto'
}

export interface EndpointWithKey extends CustomEndpoint {
  apiKey: string | null
}

function toPublic(r: EndpointRow): CustomEndpoint {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    baseUrl: r.base_url,
    model: r.model,
    dialect: cleanDialect(r.dialect),
    detectedDialect: r.detected_dialect && DIALECTS.includes(r.detected_dialect) ? r.detected_dialect : null,
    hasKey: r.api_key.length > 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function toFull(r: EndpointRow): EndpointWithKey {
  const key = r.api_key.length ? decrypt(r.api_key) : null
  if (r.api_key.length && key == null) {
    throw new Error(
      `Kunci endpoint "${r.name}" tersimpan tapi tidak bisa dibuka lagi (biasanya karena file kunci di folder data hilang atau rusak). Masukkan ulang kuncinya di Pengaturan.`
    )
  }
  return { ...toPublic(r), apiKey: key }
}

function cleanBaseUrl(raw: string): string {
  const u = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(u)) throw new Error('Base URL harus diawali http:// atau https://')
  return u
}

export function listEndpoints(kind?: EndpointKind): CustomEndpoint[] {
  const rows = (
    kind
      ? getDb().prepare('SELECT * FROM custom_endpoints WHERE kind = ? ORDER BY created_at').all(kind)
      : getDb().prepare('SELECT * FROM custom_endpoints ORDER BY kind, created_at').all()
  ) as EndpointRow[]
  return rows.map(toPublic)
}

export function getEndpoint(id: string): EndpointWithKey {
  const r = getDb().prepare('SELECT * FROM custom_endpoints WHERE id = ?').get(id) as EndpointRow | undefined
  if (!r) throw new Error('Endpoint tidak ditemukan.')
  return toFull(r)
}

export function createEndpoint(input: NewEndpointInput): CustomEndpoint {
  const name = input.name.trim()
  if (!name) throw new Error('Nama endpoint wajib diisi.')
  if (!ENDPOINT_KINDS.includes(input.kind)) throw new Error('Jenis endpoint tidak dikenal.')
  const baseUrl = cleanBaseUrl(input.baseUrl)
  const model = input.model.trim()
  const now = Date.now()
  const id = randomUUID()
  const key = (input.apiKey ?? '').trim()
  getDb()
    .prepare(
      `INSERT INTO custom_endpoints (id, kind, name, base_url, api_key, model, dialect, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.kind, name, baseUrl, key ? encrypt(key) : Buffer.alloc(0), model, cleanDialect(input.dialect), now, now)
  return getEndpoint(id)
}

export function updateEndpoint(
  id: string,
  patch: Partial<{ name: string; baseUrl: string; model: string; dialect: EndpointDialect; apiKey: string | null }>
): CustomEndpoint {
  const cur = getEndpoint(id) // throws when missing
  const name = patch.name != null ? patch.name.trim() : cur.name
  if (!name) throw new Error('Nama endpoint wajib diisi.')
  const baseUrl = patch.baseUrl != null ? cleanBaseUrl(patch.baseUrl) : cur.baseUrl
  const model = patch.model != null ? patch.model.trim() : cur.model
  const dialect = patch.dialect != null ? cleanDialect(patch.dialect) : cur.dialect
  getDb()
    .prepare('UPDATE custom_endpoints SET name = ?, base_url = ?, model = ?, dialect = ?, detected_dialect = ?, updated_at = ? WHERE id = ?')
    .run(name, baseUrl, model, dialect, dialect === cur.dialect ? cur.detectedDialect : null, Date.now(), id)
  if (patch.apiKey !== undefined) setEndpointKey(id, patch.apiKey ?? '')
  return getEndpoint(id)
}

/** Stores the auto-detection result for an endpoint. */
export function setDetectedDialect(id: string, dialect: EndpointDialect): void {
  getDb().prepare('UPDATE custom_endpoints SET detected_dialect = ?, updated_at = ? WHERE id = ?').run(dialect, Date.now(), id)
}

export function deleteEndpoint(id: string): boolean {
  return getDb().prepare('DELETE FROM custom_endpoints WHERE id = ?').run(id).changes > 0
}

/** Empty string clears the stored key. */
export function setEndpointKey(id: string, key: string): void {
  getEndpoint(id) // throws when missing
  const k = key.trim()
  getDb().prepare('UPDATE custom_endpoints SET api_key = ?, updated_at = ? WHERE id = ?').run(k ? encrypt(k) : Buffer.alloc(0), Date.now(), id)
}

/**
 * Which endpoint of a kind does the work: the preferred id when it still exists,
 * else the app default for the kind, else the oldest one. Throws a friendly
 * Indonesian error when there is nothing to use.
 */
export function activeEndpoint(kind: EndpointKind, preferredId?: string | null): EndpointWithKey {
  const all = listEndpoints(kind)
  if (!all.length) {
    const what = kind === 'llm' ? 'LLM' : kind === 'image' ? 'gambar' : 'video'
    throw new Error(`Belum ada endpoint ${what}. Tambahkan dulu di Pengaturan.`)
  }
  const pick = all.find((e) => e.id === preferredId) ?? all[0]
  return getEndpoint(pick.id)
}

/** Full key for the "show key" button; null when missing or unreadable. */
export function revealEndpointKey(id: string): string | null {
  const r = getDb().prepare('SELECT api_key FROM custom_endpoints WHERE id = ?').get(id) as { api_key: Buffer } | undefined
  return r && r.api_key.length ? decrypt(r.api_key) : null
}
