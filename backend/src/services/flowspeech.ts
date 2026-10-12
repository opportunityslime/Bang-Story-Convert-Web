import { createHash, randomUUID } from 'node:crypto'
import type { KeyTestResult, VoiceOption } from '@shared/types'
import { readError } from './http'

/**
 * FlowSpeech direct (guest) TTS: talks to flowspeech.io with a guest token taken from the
 * site's own public quota endpoint, so no API key is needed. The API is reverse-engineered
 * from the site's web app and may change without notice — errors say so plainly.
 * Guest quota is limited (2000/month, reset at month end); speak() refuses when it runs out.
 */

const BASE = 'https://flowspeech.io'

/** Overridable for tests/dev (e.g. a local stub): FLOWSPEECH_API_BASE. */
function apiBase(): string {
  return (process.env.FLOWSPEECH_API_BASE ?? BASE).replace(/\/+$/, '')
}

// The host sits behind bot detection; a browser-like UA keeps requests from being challenged.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export const FLOWSPEECH_DEFAULT_VOICE = 'Leda'
const VOICES = ['Leda', 'Orion', 'Zephyr', 'Nova', 'Atlas', 'Lyra', 'Kai', 'Aria', 'Sage', 'Ember']

const POLL_INTERVAL_MS = 1500
const POLL_TRIES = 60

interface Quota {
  limit?: number
  used?: number
  remaining?: number
  resetAt?: string
  isGuest?: boolean
}

interface JobResponse {
  code?: number
  message?: string
  data?: {
    id?: string
    state?: string
    resultUrl?: string
    audioUrl?: string
    quota?: Quota
  }
}

// One guest token per process; refreshed when it expires or the API rejects it.
let cachedToken: { value: string; at: number } | null = null
const TOKEN_TTL_MS = 30 * 60 * 1000

function journeyCookie(): string {
  const id = randomUUID()
  const hash = createHash('sha256').update(id + Date.now()).digest('hex')
  return `fs_journey=${id}.${hash}`
}

function setCookieHeaders(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof h.getSetCookie === 'function') return h.getSetCookie()
  const single = res.headers.get('set-cookie')
  return single ? [single] : []
}

function baseHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/json',
    origin: 'https://flowspeech.io',
    referer: 'https://flowspeech.io/',
    'user-agent': UA
  }
  if (token) h.cookie = `fs_guest_token=${token}; ${journeyCookie()}`
  return h
}

async function freshGuestToken(signal?: AbortSignal): Promise<{ token: string; quota?: Quota }> {
  if (cachedToken && Date.now() - cachedToken.at < TOKEN_TTL_MS) return { token: cachedToken.value }
  const res = await fetch(`${apiBase()}/api/ai/text-to-speech/quota?guest=1`, { headers: baseHeaders(), signal })
  if (!res.ok) throw new Error(`FlowSpeech tidak bisa dihubungi (${res.status}). Coba lagi nanti.`)
  const m = /fs_guest_token=([^;]+)/.exec(setCookieHeaders(res).join('; '))
  if (!m) throw new Error('FlowSpeech tidak memberikan token tamu. API-nya mungkin berubah — kabari aku.')
  cachedToken = { value: m[1], at: Date.now() }
  const body = (await res.json().catch(() => null)) as { data?: { quota?: Quota } } | null
  return { token: m[1], quota: body?.data?.quota }
}

function checkQuota(q?: Quota): void {
  if (q && typeof q.remaining === 'number' && q.remaining <= 0) {
    throw new Error('Kuota tamu FlowSpeech habis bulan ini. Coba lagi bulan depan.')
  }
}

async function markStyle(text: string, token: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${apiBase()}/api/ai/text-to-speech/markstyle`, {
    method: 'POST',
    headers: { ...baseHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ content: text }),
    signal
  })
  if (!res.ok) return text
  const j = (await res.json().catch(() => null)) as { result?: string } | null
  return j?.result?.trim() || text
}

async function createJob(text: string, voice: string, token: string, signal?: AbortSignal): Promise<{ id: string; quota?: Quota }> {
  const res = await fetch(`${apiBase()}/api/ai/text-to-speech/jobs`, {
    method: 'POST',
    headers: { ...baseHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), input: { mode: 'single', text, voiceName: voice } }),
    signal
  })
  if (!res.ok) {
    const detail = await readError(res)
    if (res.status === 401 || res.status === 403) {
      cachedToken = null
      throw new Error('TOKEN_EXPIRED')
    }
    throw new Error(`FlowSpeech menolak pekerjaan (${res.status}): ${detail}`)
  }
  const j = (await res.json()) as JobResponse
  const id = j.data?.id
  if (!id) throw new Error('FlowSpeech tidak mengembalikan ID pekerjaan.')
  return { id, quota: j.data?.quota }
}

async function pollJob(id: string, token: string, signal?: AbortSignal): Promise<{ url: string; quota?: Quota }> {
  for (let i = 0; i < POLL_TRIES; i++) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const res = await fetch(`${apiBase()}/api/ai/text-to-speech/jobs/${id}`, { headers: baseHeaders(token), signal })
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        cachedToken = null
        throw new Error('TOKEN_EXPIRED')
      }
      throw new Error(`FlowSpeech gagal dibaca (${res.status}).`)
    }
    const j = (await res.json()) as JobResponse
    const state = j.data?.state ?? ''
    if (state === 'success' || state === 'completed' || state === 'complete') {
      const url = j.data?.resultUrl ?? j.data?.audioUrl
      if (!url) throw new Error('FlowSpeech selesai tapi tidak memberi file suara.')
      return { url, quota: j.data?.quota }
    }
    if (state === 'failed' || state === 'error') throw new Error('FlowSpeech gagal membuat suara. Coba ubah sedikit teksnya lalu ulangi.')
  }
  throw new Error('FlowSpeech kelamaan (lebih dari 90 detik). Coba lagi.')
}

async function download(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal })
  if (!res.ok) throw new Error(`Gagal mengunduh hasil suara FlowSpeech (${res.status}).`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('File suara FlowSpeech kosong.')
  return buf
}

/**
 * Speaks `text` with the guest FlowSpeech API and returns the WAV bytes.
 * There are no word timings from this API; captions fall back to Whisper sync or estimates.
 */
export async function speak(text: string, voice: string, signal?: AbortSignal): Promise<{ audio: Buffer; voice: string }> {
  const t = text.trim()
  if (!t) throw new Error('Teks narasi kosong, tidak ada yang disuarakan.')
  const v = voice.trim() || FLOWSPEECH_DEFAULT_VOICE
  // A stale guest token fails once, then we retry with a fresh one.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { token, quota } = await freshGuestToken(signal)
      checkQuota(quota)
      const finalText = await markStyle(t, token, signal)
      const job = await createJob(finalText, v, token, signal)
      checkQuota(job.quota)
      const done = await pollJob(job.id, token, signal)
      checkQuota(done.quota)
      return { audio: await download(done.url, signal), voice: v }
    } catch (e) {
      if ((e as Error).message === 'TOKEN_EXPIRED' && attempt === 0) continue
      throw e
    }
  }
  throw new Error('FlowSpeech gagal. Coba lagi.')
}

/** Live quota check without spending anything: reports the remaining guest quota. */
export async function testConnection(): Promise<KeyTestResult> {
  try {
    cachedToken = null
    const { quota } = await freshGuestToken()
    checkQuota(quota)
    const rem = quota?.remaining
    const reset = quota?.resetAt ? new Date(quota.resetAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long' }) : ''
    const q = typeof rem === 'number' ? ` · sisa ${rem.toLocaleString('id-ID')} kuota tamu${reset ? ` (reset ${reset})` : ''}` : ''
    return { ok: true, message: `Terhubung${q}` }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

/** The API has no voice catalog endpoint; voices are named directly (e.g. "Leda"). */
export function listVoices(): VoiceOption[] {
  return VOICES.map((v) => ({ id: v, name: v, description: 'Suara FlowSpeech (jalur tamu, gratis)' }))
}
