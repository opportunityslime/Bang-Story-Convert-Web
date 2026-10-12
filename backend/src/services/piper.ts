import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { VoiceOption, WordTiming } from '@shared/types'
import { backendRoot } from '../paths'

/**
 * Local text-to-speech with the bundled Piper binary and an Indonesian voice model.
 * Free and offline: used as the default narration voice on the web backend.
 */

/** Folder with the Piper binary and voice files; overridable with BANG_PIPER_DIR (tests/dev). */
export function piperDir(): string {
  return process.env.BANG_PIPER_DIR || join(backendRoot(), 'resources', 'piper')
}

/** The bundled Indonesian voice model. */
export function piperVoiceModel(): string {
  return join(piperDir(), 'id_ID-news_tts-medium.onnx')
}

export function listPiperVoices(): VoiceOption[] {
  return [{ id: 'id_ID-news_tts-medium', name: 'Bahasa Indonesia — Piper (lokal)', description: 'Suara lokal, gratis, tanpa internet' }]
}

/**
 * Speaks `text` with Piper into a WAV file (`outWav`). The text goes through stdin.
 * Throws Indonesian messages so the UI can show them directly.
 */
export async function piperTts(text: string, outWav: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Dibatalkan')
  const t = text.trim()
  if (!t) throw new Error('Teks narasi kosong, tidak ada yang disuarakan.')
  await new Promise<void>((resolve, reject) => {
    const p = execFile(
      join(piperDir(), 'piper'),
      ['--model', piperVoiceModel(), '--output_file', outWav],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, _out, stderr) => {
        if (signal?.aborted) return reject(new Error('Dibatalkan'))
        if (err) {
          const detail = String(stderr).trim().split('\n').slice(-2).join(' ')
          return reject(new Error(`Piper gagal membuat suara${detail ? `: ${detail}` : ''}`))
        }
        resolve()
      }
    )
    signal?.addEventListener('abort', () => p.kill('SIGKILL'), { once: true })
    p.stdin?.write(t)
    p.stdin?.end()
  })
}

/**
 * Estimated word timings when there are no real timestamps. This is the exact duration-per-word
 * distribution from `@shared/captions` (longer words and punctuation pauses get more time),
 * duplicated here so this service does not depend on any other module.
 */
export function estimateWordTimings(text: string, durationMs: number): WordTiming[] {
  const durationSec = durationMs / 1000
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || durationSec <= 0) return []
  const lead = Math.min(0.15, durationSec * 0.03)
  const tail = Math.min(0.25, durationSec * 0.05)
  const usable = Math.max(0.1, durationSec - lead - tail)
  const weight = (w: string): number => {
    let v = Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, '').length) + 1.5
    if (/[.!?…]$/.test(w)) v += 4
    else if (/[,;:]$/.test(w)) v += 2
    return v
  }
  const weights = tokens.map(weight)
  const total = weights.reduce((a, b) => a + b, 0)
  let t = lead
  return tokens.map((w, i) => {
    const d = (weights[i] / total) * usable
    const out = { text: w, start: t, end: t + d }
    t += d
    return out
  })
}
