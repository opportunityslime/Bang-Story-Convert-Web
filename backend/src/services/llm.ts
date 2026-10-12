import type { KeyTestResult, ModelList, ModelOption, ModelSource } from '@shared/types'
import { activeEndpoint, getEndpoint, type EndpointWithKey } from '../endpoints'
import { getSettings, readCache, writeCache } from '../settings'
import * as eleven from './elevenlabs'

// Cloudflare sits in front of some APIs and is sensitive to bot signatures.
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const GENERATE_TIMEOUT_MS = 4 * 60 * 1000
const MODELS_CACHE_MS = 60 * 60 * 1000

export class LlmError extends Error {
  constructor(
    message: string,
    public status = 0,
    public detail = ''
  ) {
    super(message)
  }
}

const KEY_PROBLEM = /api key|credential|unauthenticated|unauthori[sz]ed|user not found/i

function friendlyStatus(status: number, detail: string, label: string): string {
  if (status === 401 || (status === 400 && KEY_PROBLEM.test(detail))) return `Kunci ${label} ditolak. Periksa kunci di Pengaturan.`
  if (status === 402) return `Saldo atau limit kredit ${label} habis. Isi ulang lalu coba lagi.`
  if (status === 403) return `${label} menolak permintaan ini: ${detail}`
  if (status === 404) return `Model atau layanan tidak ditemukan di ${label}: ${detail}`
  if (status === 408 || status === 504 || status === 524) return `${label} terlalu lama merespons. Coba lagi atau pilih model yang lebih cepat.`
  if (status === 413) return 'Permintaan terlalu panjang untuk model ini.'
  if (status === 429) return `${label} sedang membatasi permintaan (rate limit). Tunggu sebentar lalu coba lagi.`
  if (status >= 500) return `Server ${label} sedang bermasalah (${status}). Coba lagi nanti.`
  return `${label} menolak permintaan (${status}): ${detail}`
}

/** Short error text for user-facing messages; the raw key never flows through here. */
async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as { error?: { message?: string }; message?: string }
      return j?.error?.message ?? j?.message ?? text.slice(0, 300)
    } catch {
      return text.slice(0, 300)
    }
  } catch {
    return res.statusText
  }
}

async function call<T>(base: string, key: string | null, label: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(init.headers ?? {})
      }
    })
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new LlmError(`${label} terlalu lama merespons.`, 408)
    if ((e as Error).name === 'AbortError') throw e
    throw new LlmError(`Tidak bisa terhubung ke ${label}: ${(e as Error).message}`)
  }
  if (!res.ok) {
    const detail = await readError(res)
    throw new LlmError(friendlyStatus(res.status, detail, label), res.status, detail)
  }
  return (await res.json()) as T
}

// ---------- structured generation ----------

/** Pulls the first JSON object out of a reply that may carry fences or commentary around it. */
function extractJson(text: string): unknown {
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no json')
  return JSON.parse(unfenced.slice(start, end + 1))
}

/** How many times generateJson retries when the model returns malformed JSON. */
const JSON_RETRIES = 3

/**
 * Asks the active LLM endpoint for one JSON object that follows `schema`. The endpoint speaks
 * OpenAI-compatible chat completions; the schema rides along in the system prompt (json_object
 * mode cannot carry a schema field); temperature 0.7 keeps story writing lively. A malformed-JSON
 * reply is retried automatically a few times before surfacing an error.
 */
export async function generateJson<T>(req: {
  system: string
  prompt: string
  schema: object
  name: string
  signal?: AbortSignal
}): Promise<T> {
  const ep = activeLlmEndpoint()
  const label = ep.name
  const model = ep.model.trim()
  if (!model) throw new LlmError(`Endpoint ${label} belum punya model. Isi dulu di Pengaturan.`)
  const system = `${req.system}\n\nReply with ONE JSON object only (no markdown, no commentary) that matches this JSON Schema:\n${JSON.stringify(req.schema)}`
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: req.prompt }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7
  }
  for (let attempt = 1; attempt <= JSON_RETRIES; attempt++) {
    const timeout = AbortSignal.timeout(GENERATE_TIMEOUT_MS)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    const r = await call<{
      choices?: { message?: { content?: unknown; refusal?: string | null } }[]
      error?: { message?: string }
    }>(ep.baseUrl, ep.apiKey, label, '/chat/completions', { method: 'POST', body: JSON.stringify(body), signal })
    const inlineError = r.error?.message
    if (inlineError) throw new LlmError(`${label} gagal: ${inlineError}`, 400, inlineError)
    const refusal = r.choices?.[0]?.message?.refusal
    if (refusal) throw new LlmError(`Model menolak permintaan: ${refusal}`, 403, refusal)
    const content = r.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? content : ''
    if (!text.trim()) throw new LlmError(`Model "${model}" tidak menjawab. Coba lagi.`)
    try {
      return extractJson(text) as T
    } catch {
      if (attempt < JSON_RETRIES) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
    }
  }
  throw new LlmError(`Model "${model}" tidak menghasilkan JSON yang valid setelah ${JSON_RETRIES}x percobaan. Coba lagi.`)
}

// ---------- active endpoint ----------

export interface ActiveLlm {
  endpointId: string
  name: string
  model: string
}

/** Which LLM endpoint writes stories right now: the default chosen in Settings. */
export function activeLlmEndpoint(): EndpointWithKey {
  const s = getSettings()
  return activeEndpoint('llm', s.defaultLlmEndpointId)
}

export function activeLlm(): ActiveLlm {
  const ep = activeLlmEndpoint()
  return { endpointId: ep.id, name: ep.name, model: ep.model }
}

// ---------- model lists ----------

async function openAiModels(base: string, key: string | null, label: string): Promise<ModelOption[]> {
  const r = await call<{ data?: { id: string; owned_by?: string }[] }>(base, key, label, '/models')
  return (r.data ?? [])
    .filter((m) => m.id)
    .map(
      (m): ModelOption => ({
        id: m.id,
        name: m.id,
        description: m.owned_by ? `Pemilik: ${m.owned_by}` : undefined,
        tags: []
      })
    )
}

/** Live model list of one custom LLM endpoint, cached for an hour. */
export async function listEndpointModels(endpointId: string, refresh = false): Promise<ModelList> {
  const ep = getEndpoint(endpointId)
  if (ep.kind !== 'llm') throw new LlmError('Endpoint ini bukan endpoint LLM.')
  const cacheKey = `models:endpoint:${endpointId}`
  const cached = readCache<ModelOption[]>(cacheKey)
  if (cached && !refresh && Date.now() - cached.updatedAt < MODELS_CACHE_MS) return { models: cached.value, fetchedAt: cached.updatedAt }
  const models = await openAiModels(ep.baseUrl, ep.apiKey, ep.name)
  const fetchedAt = writeCache(cacheKey, models)
  return { models, fetchedAt }
}

/**
 * Lists models of an endpoint that is not saved yet (the "load model list" button in the
 * endpoint form). The base URL is validated the same way as on create.
 */
export async function probeEndpointModels(baseUrl: string, key: string | null): Promise<ModelList> {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new LlmError('Base URL harus diawali http:// atau https://')
  const models = await openAiModels(base, key?.trim() ? key.trim() : null, 'Endpoint')
  return { models, fetchedAt: Date.now() }
}

export async function listModels(source: ModelSource): Promise<ModelList> {
  switch (source) {
    case 'elevenlabs': {
      const voices = await eleven.listVoices()
      return {
        models: voices.map(
          (v): ModelOption => ({ id: v.id, name: v.name, description: v.description || undefined, tags: [] })
        ),
        fetchedAt: Date.now()
      }
    }
    case 'piper':
      return {
        models: [{ id: 'id_ID-news_tts-medium', name: 'Bahasa Indonesia — Piper (lokal)', tags: [] }],
        fetchedAt: Date.now()
      }
  }
}

// ---------- endpoint checks ----------

/** Verifies a custom LLM endpoint by listing its models (falls back to a tiny chat call). */
export async function testLlmEndpoint(endpointId: string): Promise<KeyTestResult> {
  const ep = getEndpoint(endpointId)
  try {
    const models = await openAiModels(ep.baseUrl, ep.apiKey, ep.name)
    return { ok: true, message: models.length ? `${ep.name} terhubung · ${models.length} model tersedia` : `${ep.name} terhubung` }
  } catch (e) {
    return { ok: false, message: e instanceof LlmError ? e.message : `${ep.name} tidak bisa dihubungi. Coba lagi.` }
  }
}
