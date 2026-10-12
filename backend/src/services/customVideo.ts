import type { EndpointWithKey } from '../endpoints'
import { alignModelShape, resolveDialect } from './dialects'
import { LlmError } from './llm'

/**
 * Videos from a user-managed endpoint. The dialect is auto-detected per endpoint:
 * - 'bangstory': POST {baseUrl}/generate {model, prompt, ratio, imageBase64?…}
 *   → {videoUrl} (sync) or {taskId}; then GET {baseUrl}/status?taskId=…
 *   → {status: 'pending'|'done'|'failed', videoUrl?}
 * - 'gemini' (Gemini-style): POST {baseUrl}/chat/completions {model, stream: true, messages}
 *   with the prompt (and reference image as image_url data URI). The SSE stream runs
 *   1–5 minutes; the video arrives as a URL or base64 payload in the stream.
 */

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const VIDEO_STREAM_TIMEOUT_MS = 6 * 60 * 1000

function headers(endpoint: EndpointWithKey): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {})
  }
}

async function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => null)
}

export interface CustomVideoResult {
  videoUrl?: string
  taskId?: string
  /** Gemini-style streams the finished video inline instead of a task id. */
  videoBytes?: Buffer
  model: string
}

// ---------- Bang Story contract ----------

export async function bangstoryVideoCreate(opts: {
  endpoint: EndpointWithKey
  prompt: string
  ratio: string
  imageBase64?: string
  imageUrl?: string
  durationSec?: number
  signal?: AbortSignal
}): Promise<CustomVideoResult> {
  const { endpoint } = opts
  const model = endpoint.model.trim()
  if (!model) throw new LlmError(`Endpoint ${endpoint.name} belum punya model. Isi dulu di Pengaturan.`)
  let res: Response
  try {
    res = await fetch(`${endpoint.baseUrl}/generate`, {
      method: 'POST',
      signal: opts.signal,
      headers: headers(endpoint),
      body: JSON.stringify({
        model,
        prompt: opts.prompt,
        ratio: opts.ratio,
        ...(opts.imageBase64 ? { imageBase64: opts.imageBase64 } : {}),
        ...(opts.imageUrl ? { imageUrl: opts.imageUrl } : {}),
        ...(opts.durationSec ? { durationSec: opts.durationSec } : {})
      })
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new LlmError(`Tidak bisa terhubung ke ${endpoint.name}: ${(e as Error).message}`)
  }
  const data = (await readJson(res)) as { videoUrl?: unknown; taskId?: unknown; error?: unknown; message?: unknown } | null
  if (!res.ok) {
    const detail = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : res.statusText
    throw new LlmError(`${endpoint.name} menolak pembuatan video (${res.status}): ${String(detail).slice(0, 300)}`, res.status)
  }
  if (typeof data?.videoUrl === 'string' && data.videoUrl) return { videoUrl: data.videoUrl, model }
  if (typeof data?.taskId === 'string' && data.taskId) return { taskId: data.taskId, model }
  throw new LlmError(`${endpoint.name} tidak mengembalikan videoUrl maupun taskId. Periksa dialek endpoint di Pengaturan.`)
}

export interface CustomVideoStatus {
  status: 'pending' | 'done' | 'failed'
  videoUrl?: string
  error?: string
}

export async function bangstoryVideoCheck(
  endpoint: EndpointWithKey,
  taskId: string,
  signal?: AbortSignal
): Promise<CustomVideoStatus> {
  let res: Response
  try {
    res = await fetch(`${endpoint.baseUrl}/status?taskId=${encodeURIComponent(taskId)}`, { signal, headers: headers(endpoint) })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new LlmError(`Tidak bisa mengecek status video di ${endpoint.name}: ${(e as Error).message}`)
  }
  const data = (await readJson(res)) as { status?: unknown; videoUrl?: unknown; error?: unknown; message?: unknown } | null
  if (!res.ok) throw new LlmError(`${endpoint.name} gagal mengecek status video (${res.status}).`, res.status)
  const status = data?.status
  if (status === 'done' && typeof data?.videoUrl === 'string') return { status: 'done', videoUrl: data.videoUrl }
  if (status === 'failed') {
    const error = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : undefined
    return { status: 'failed', error }
  }
  return { status: 'pending' }
}

// ---------- Gemini-style (streaming) ----------

/** Walks any JSON value collecting video URLs and base64 video payloads. */
function collectVideoPayloads(value: unknown, out: { urls: string[]; b64: string[] }): void {
  if (typeof value === 'string') {
    if (/^https?:\/\/\S+\.(mp4|mov|webm)(\?\S*)?$/i.test(value)) out.urls.push(value)
    else if (/^[A-Za-z0-9+/=]{100000,}$/.test(value)) out.b64.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectVideoPayloads(v, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'videoUrl' || k === 'video_url' || k === 'url') && typeof v === 'string' && /^https?:\/\//.test(v)) {
        out.urls.push(v)
        continue
      }
      collectVideoPayloads(v, out)
    }
  }
}

/**
 * Gemini-style renders video over one SSE stream (1–5 minutes, no polling).
 * The finished video arrives in the stream as a URL or base64 payload.
 */
async function geminiVideoCreate(opts: {
  endpoint: EndpointWithKey
  prompt: string
  ratio: string
  imageBase64?: string
  imageUrl?: string
  durationSec?: number
  signal?: AbortSignal
}): Promise<CustomVideoResult> {
  const { endpoint } = opts
  const raw = endpoint.model.trim()
  if (!raw) throw new LlmError(`Endpoint ${endpoint.name} belum punya model. Isi dulu di Pengaturan.`)
  const model = alignModelShape(raw, opts.ratio)
  const content: unknown[] = [{ type: 'text', text: opts.prompt }]
  if (opts.imageBase64) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${opts.imageBase64}` } })
  else if (opts.imageUrl) content.push({ type: 'image_url', image_url: { url: opts.imageUrl } })

  const timeout = AbortSignal.timeout(VIDEO_STREAM_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let res: Response
  try {
    res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { ...headers(endpoint), Accept: 'text/event-stream' },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content }] })
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError' && !opts.signal?.aborted)
      throw new LlmError(`${endpoint.name} tidak menyelesaikan video dalam 6 menit.`, 408)
    if ((e as Error).name === 'AbortError') throw e
    throw new LlmError(`Tidak bisa terhubung ke ${endpoint.name}: ${(e as Error).message}`)
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => res.statusText)
    throw new LlmError(`${endpoint.name} menolak pembuatan video (${res.status}): ${detail.slice(0, 300)}`, res.status, detail)
  }

  const found = { urls: [] as string[], b64: [] as string[] }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          collectVideoPayloads(JSON.parse(payload), found)
        } catch {
          // Non-JSON heartbeat; ignore.
        }
      }
      if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    }
  } finally {
    reader.releaseLock()
  }
  if (found.urls.length) return { videoUrl: found.urls[found.urls.length - 1], model }
  if (found.b64.length) return { videoBytes: Buffer.from(found.b64.join(''), 'base64'), model }
  throw new LlmError(`${endpoint.name} menyelesaikan stream tapi tidak ada video di dalamnya. Coba lagi atau periksa modelnya.`)
}

// ---------- dispatcher ----------

export async function customVideoCreate(opts: {
  endpoint: EndpointWithKey
  prompt: string
  ratio: string
  imageBase64?: string
  imageUrl?: string
  durationSec?: number
  signal?: AbortSignal
}): Promise<CustomVideoResult> {
  const dialect = await resolveDialect(opts.endpoint)
  if (dialect === 'gemini') return geminiVideoCreate(opts)
  return bangstoryVideoCreate(opts)
}

export async function customVideoCheck(
  endpoint: EndpointWithKey,
  taskId: string,
  signal?: AbortSignal
): Promise<CustomVideoStatus> {
  const dialect = await resolveDialect(endpoint)
  if (dialect === 'gemini') throw new LlmError('Endpoint Gemini-style tidak memakai polling; videonya langsung jadi dari stream.')
  return bangstoryVideoCheck(endpoint, taskId, signal)
}

/** Cheap liveness probe for the "test" button: the contract has no ping, so a bad-method hit still proves reachability. */
export async function testVideoEndpoint(endpoint: EndpointWithKey): Promise<{ ok: boolean; message: string }> {
  try {
    const dialect = await resolveDialect(endpoint)
    if (dialect === 'gemini') {
      const res = await fetch(`${endpoint.baseUrl}/models`, {
        headers: headers(endpoint),
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) return { ok: false, message: `${endpoint.name} menolak daftar model (${res.status}). Periksa kunci.` }
      return { ok: true, message: `${endpoint.name} terhubung (Gemini-style). Buat video untuk uji penuh.` }
    }
    const res = await fetch(`${endpoint.baseUrl}/status`, { headers: headers(endpoint), signal: AbortSignal.timeout(15000) })
    // Any HTTP answer (even 404/405) means the host is reachable; only network failure counts as down.
    return { ok: true, message: `${endpoint.name} terjangkau (HTTP ${res.status}). Buat video untuk uji penuh.` }
  } catch (e) {
    if ((e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError')
      return { ok: false, message: `${endpoint.name} tidak menjawab dalam 15 detik.` }
    return { ok: false, message: `${endpoint.name} tidak bisa dihubungi: ${(e as Error).message}` }
  }
}
