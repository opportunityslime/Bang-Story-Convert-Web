import type { EndpointWithKey } from '../endpoints'
import { alignModelShape, resolveDialect } from './dialects'
import { LlmError } from './llm'

/**
 * Images from a user-managed endpoint. The dialect is auto-detected per endpoint:
 * - 'openai': POST {baseUrl}/images/generations with
 *   {model, prompt, size, n: 1, response_format: 'b64_json'} → {data: [{b64_json|url}]}
 * - 'gemini' (Gemini-style): POST {v1beta}/models/{model}:generateContent with
 *   {contents: [{parts: [{text: prompt}]}]} → {candidates: [{content: {parts: [{inlineData}]}}]}
 * A URL answer is downloaded so the pipeline always works on local bytes.
 */

const IMAGE_TIMEOUT_MS = 4 * 60 * 1000
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function authHeaders(endpoint: EndpointWithKey): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {})
  }
}

function sizeFor(aspectRatio: '1:1' | '16:9' | '9:16'): string {
  switch (aspectRatio) {
    case '9:16':
      return '1024x1792'
    case '16:9':
      return '1792x1024'
    default:
      return '1024x1024'
  }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function openaiImage(opts: {
  endpoint: EndpointWithKey
  prompt: string
  aspectRatio: '1:1' | '16:9' | '9:16'
  signal?: AbortSignal
}): Promise<{ image: Buffer; model: string }> {
  const { endpoint, prompt } = opts
  const model = endpoint.model.trim()
  if (!model) throw new LlmError(`Endpoint ${endpoint.name} belum punya model. Isi dulu di Pengaturan.`)
  let res: Response
  try {
    res = await fetch(`${endpoint.baseUrl}/images/generations`, {
      method: 'POST',
      signal: withTimeout(opts.signal, IMAGE_TIMEOUT_MS),
      headers: { ...authHeaders(endpoint), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, size: sizeFor(opts.aspectRatio), n: 1, response_format: 'b64_json' })
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError' && !opts.signal?.aborted)
      throw new LlmError(`${endpoint.name} tidak menjawab dalam 4 menit, percobaan ini dibatalkan.`, 408)
    if ((e as Error).name === 'AbortError') throw e
    throw new LlmError(`Tidak bisa terhubung ke ${endpoint.name}: ${(e as Error).message}`)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText)
    throw new LlmError(`${endpoint.name} gagal membuat gambar (${res.status}): ${detail.slice(0, 300)}`, res.status, detail)
  }
  const data = (await res.json().catch(() => null)) as { data?: { b64_json?: unknown; url?: unknown }[] } | null
  const first = data?.data?.[0]
  if (typeof first?.b64_json === 'string' && first.b64_json) {
    return { image: Buffer.from(first.b64_json, 'base64'), model }
  }
  if (typeof first?.url === 'string' && first.url) {
    const dl = await fetch(first.url, { signal: opts.signal })
    if (!dl.ok) throw new LlmError(`${endpoint.name} mengembalikan URL gambar yang tidak bisa diunduh (${dl.status}).`)
    return { image: Buffer.from(await dl.arrayBuffer()), model }
  }
  throw new LlmError(`${endpoint.name} tidak mengembalikan gambar (bukan b64_json maupun url).`)
}

/** Gemini-style speaks Gemini-style under /v1beta; the base URL usually ends with /v1. */
function v1betaRoot(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '')
  return /\/v\d+$/i.test(b) ? b.replace(/\/v\d+$/i, '/v1beta') : `${b}/v1beta`
}

interface GeminiPart {
  text?: unknown
  inlineData?: { mimeType?: unknown; data?: unknown }
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[]
  error?: { message?: unknown }
}

async function geminiImage(opts: {
  endpoint: EndpointWithKey
  prompt: string
  aspectRatio: '1:1' | '16:9' | '9:16'
  signal?: AbortSignal
}): Promise<{ image: Buffer; model: string }> {
  const { endpoint, prompt } = opts
  const raw = endpoint.model.trim()
  if (!raw) throw new LlmError(`Endpoint ${endpoint.name} belum punya model. Isi dulu di Pengaturan.`)
  // The ratio lives in the model name; align it with the requested aspect ratio.
  const model = alignModelShape(raw, opts.aspectRatio)
  let res: Response
  try {
    res = await fetch(`${v1betaRoot(endpoint.baseUrl)}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: withTimeout(opts.signal, IMAGE_TIMEOUT_MS),
      headers: { ...authHeaders(endpoint), 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError' && !opts.signal?.aborted)
      throw new LlmError(`${endpoint.name} tidak menjawab dalam 4 menit, percobaan ini dibatalkan.`, 408)
    if ((e as Error).name === 'AbortError') throw e
    throw new LlmError(`Tidak bisa terhubung ke ${endpoint.name}: ${(e as Error).message}`)
  }
  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  if (!res.ok) {
    const detail = typeof data?.error?.message === 'string' ? data.error.message : res.statusText
    throw new LlmError(`${endpoint.name} gagal membuat gambar (${res.status}): ${String(detail).slice(0, 300)}`, res.status)
  }
  const parts = data?.candidates?.[0]?.content?.parts ?? []
  for (const p of parts) {
    if (typeof p.inlineData?.data === 'string' && p.inlineData.data) {
      return { image: Buffer.from(p.inlineData.data, 'base64'), model }
    }
  }
  const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join(' ').trim()
  throw new LlmError(
    `${endpoint.name} tidak mengembalikan gambar${text ? `: "${text.slice(0, 200)}"` : '. Periksa nama modelnya.'}`
  )
}

export async function customImage(opts: {
  endpoint: EndpointWithKey
  prompt: string
  aspectRatio: '1:1' | '16:9' | '9:16'
  signal?: AbortSignal
}): Promise<{ image: Buffer; model: string }> {
  const dialect = await resolveDialect(opts.endpoint)
  if (dialect === 'gemini') return geminiImage(opts)
  return openaiImage(opts)
}
