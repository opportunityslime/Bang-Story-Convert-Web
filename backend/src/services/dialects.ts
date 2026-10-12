import type { EndpointDialect } from '@shared/types'
import { getEndpoint, setDetectedDialect, type EndpointWithKey } from '../endpoints'

/**
 * API-style auto-detection. Different providers speak different dialects:
 * - 'openai'    LLM + images via OpenAI paths (/chat/completions, /images/generations)
 * - 'bangstory' video via the Bang Story contract (POST /generate, GET /status)
 * - 'gemini'     Gemini-style style (Gemini :generateContent for images, streaming
 *               chat/completions for video)
 *
 * Detection is cheap: one GET /models (no credits spent). The result is stored
 * on the endpoint row so it is detected once, not on every generation.
 */

/** Model-name hints that an endpoint speaks the Gemini-style style. */
const GEMINI_STYLE_HINT = /gemini-3\.\d+-(flash|pro)-image|imagen-|abra_[tiv]2v|veo_3_1/i

async function fetchModelIds(ep: EndpointWithKey): Promise<string[]> {
  const res = await fetch(`${ep.baseUrl}/models`, {
    headers: {
      Accept: 'application/json',
      ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {})
    },
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null
  return (data?.data ?? []).map((m) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean)
}

const SHAPE_BY_RATIO: Record<string, string> = { '9:16': 'portrait', '16:9': 'landscape', '1:1': 'square' }

/**
 * Gemini-style models encode the output ratio in the model name
 * (…-portrait / …-landscape / …-square, also _portrait mid-name like
 * veo_3_1_t2v_fast_portrait_ultra). Aligns that segment with the project's
 * aspect ratio so one saved model works for every project. Names without a
 * shape segment are left untouched.
 */
export function alignModelShape(model: string, ratio: string): string {
  const shape = SHAPE_BY_RATIO[ratio]
  if (!shape) return model
  return model.replace(/[-_](portrait|landscape|square)(?=[-_]|$)/i, (m) => `${m[0]}${shape}`)
}

/** Default dialect per kind when nothing hints otherwise. */
export function defaultDialect(kind: EndpointWithKey['kind']): EndpointDialect {
  return kind === 'video' ? 'bangstory' : 'openai'
}

/** Detects the API style of an endpoint without spending credits. Never throws. */
export async function detectDialect(ep: EndpointWithKey): Promise<EndpointDialect> {
  const fallback = defaultDialect(ep.kind)
  try {
    const ids = await fetchModelIds(ep)
    if (ids.some((id) => GEMINI_STYLE_HINT.test(id))) return 'gemini'
    if (ids.length) return fallback
  } catch {
    // Unreachable or no model list; fall back to the kind's default.
  }
  return fallback
}

/**
 * Effective dialect: the user's pin, or the cached auto-detection
 * (detecting once on first use when never checked).
 */
export async function resolveDialect(ep: EndpointWithKey): Promise<EndpointDialect> {
  if (ep.dialect !== 'auto') return ep.dialect
  if (ep.detectedDialect && ep.detectedDialect !== 'auto') return ep.detectedDialect
  const detected = await detectDialect(ep)
  try {
    setDetectedDialect(ep.id, detected)
  } catch {
    // Cache write failing must not break generation.
  }
  // Re-read so callers see the stored value.
  try {
    return getEndpoint(ep.id).detectedDialect ?? detected
  } catch {
    return detected
  }
}
