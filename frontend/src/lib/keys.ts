import type { KeyStatus, TtsProvider } from '@shared/types'

export const TTS_NAMES: Record<TtsProvider, string> = { piper: 'Piper (lokal)', elevenlabs: 'ElevenLabs', flowspeech: 'FlowSpeech (gratis)' }

/**
 * Whether each narrator voice service can be used. Piper runs on the server, so it never needs a key;
 * API services need a saved key that did not fail its last check. `reason` says why not, for disabled options.
 */
export function ttsReadiness(keys: KeyStatus[]): Record<TtsProvider, { ok: boolean; reason: string | null }> {
  const keyed = (provider: 'elevenlabs', label: string): { ok: boolean; reason: string | null } => {
    const k = keys.find((x) => x.provider === provider)
    if (!k?.configured) return { ok: false, reason: `Kunci ${label} belum diisi` }
    if (k.lastOk === false) return { ok: false, reason: `Kunci ${label} tidak valid` }
    return { ok: true, reason: null }
  }
  return {
    piper: { ok: true, reason: null },
    // Guest FlowSpeech needs no key, so it is always usable (its own monthly quota applies).
    flowspeech: { ok: true, reason: null },
    elevenlabs: keyed('elevenlabs', 'ElevenLabs')
  }
}

/** The preferred provider when it is usable, otherwise the first usable one in a fixed order. */
export function usableTts(preferred: TtsProvider, keys: KeyStatus[]): TtsProvider {
  const ready = ttsReadiness(keys)
  if (ready[preferred].ok) return preferred
  for (const p of ['flowspeech', 'elevenlabs', 'piper'] as const) {
    if (ready[p].ok) return p
  }
  return preferred
}
