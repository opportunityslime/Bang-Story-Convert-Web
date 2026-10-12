import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { WHISPER_TIMING, captionNeedsSync, estimateWordTimings } from '@shared/captions'
import { estimateNarrationMs } from '@shared/script'
import { spokenWords, stripVoiceTags } from '@shared/speech'
import type { Clip, Job, Project, TtsProvider, WordTiming } from '@shared/types'
import { emit } from './events'
import { runJob, type QueueName, type Task, type TaskCtx } from './jobs'
import { assetAbsPath, binPath, dataDir } from './paths'
import {
  activeJobFor,
  activeProjectJob,
  clipsOf,
  getAsset,
  getClip,
  getJobRaw,
  getProject,
  insertAsset,
  insertJob,
  patchClip,
  touchProject,
  updateAssetMeta
} from './repo'
import { getSecret } from './secrets'
import { getSettings } from './settings'
import { chooseCuts, cutsFromWords } from './cuts'
import { probeDurationMs } from './services/audio'
import * as eleven from './services/elevenlabs'
import * as flowspeech from './services/flowspeech'
import { FLOWSPEECH_DEFAULT_VOICE } from './services/flowspeech'
import { piperTts } from './services/piper'
import { timeScript, whisperReady } from './whisper'

/**
 * Voices many scenes in one continuous take and cuts it per scene. A single take keeps the voice, pace and
 * intonation consistent, which separate requests per scene do not. Long scripts are voiced in parts of a
 * few minutes each. The default voice is local Piper; ElevenLabs is used only when the project chose it
 * and its API key is available.
 */

const PIPER_PART_SEC = 240
const ELEVEN_PART_CHARS = 2400
// Short takes dodge the guest API's 90s poll timeout and its hiccups on long renders.
const FLOWSPEECH_PART_CHARS = 800
const PIPER_VOICE = 'id_ID-news_tts-medium'

// A take can open with speech that is not the script — FlowSpeech sometimes reads its own
// prompt out loud ("Synthesize speech from the transcript below...") before the text we sent, and the
// same model sometimes drops a stray word at the seam between two scenes. Neither is ours, so anything
// sitting in front of a scene's first script word is dropped. A scene normally starts at once, so only
// a clearly late first word counts as someone else talking.
const LEAD_TRIM_MIN_SEC = 0.5
const LEAD_PAD_SEC = 0.15

interface Segment {
  clip: Clip
  file: string
  durationMs: number
  words: WordTiming[]
  estimated: boolean
  timedBy?: string
}

function ffmpeg(args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile(binPath(ffmpegStatic!), ['-hide_banner', '-nostats', ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, _out, stderr) => {
      if (signal.aborted) return reject(new Error('Dibatalkan'))
      if (err) return reject(new Error(`FFmpeg gagal: ${String(stderr).split('\n').slice(-4).join(' ').trim()}`))
      resolve(String(stderr))
    })
    signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true })
  })
}

async function detectSilences(file: string, signal: AbortSignal): Promise<{ start: number; end: number }[]> {
  const log = await ffmpeg(['-i', file, '-af', 'silencedetect=noise=-38dB:d=0.25', '-f', 'null', '-'], signal)
  const out: { start: number; end: number }[] = []
  let start: number | null = null
  for (const line of log.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (s) start = Math.max(0, Number(s[1]))
    const e = /silence_end:\s*([\d.]+)/.exec(line)
    if (e && start != null) {
      out.push({ start, end: Number(e[1]) })
      start = null
    }
  }
  return out
}

/** Groups scenes into takes that fit one request, keeping the script order. */
function parts(clips: Clip[], provider: TtsProvider): Clip[][] {
  const out: Clip[][] = []
  let cur: Clip[] = []
  let size = 0
  for (const c of clips) {
    const s = provider === 'piper' ? estimateNarrationMs(c.narration) / 1000 : c.narration.length
    const limit =
      provider === 'elevenlabs'
        ? ELEVEN_PART_CHARS
        : provider === 'flowspeech'
            ? FLOWSPEECH_PART_CHARS
            : PIPER_PART_SEC
    if (cur.length && size + s > limit) {
      out.push(cur)
      cur = []
      size = 0
    }
    cur.push(c)
    size += s
  }
  if (cur.length) out.push(cur)
  return out
}

async function cut(src: string, start: number, end: number, dst: string, signal: AbortSignal): Promise<void> {
  await ffmpeg(['-y', '-i', src, '-ss', start.toFixed(3), '-to', end.toFixed(3), '-c:a', 'pcm_s16le', '-ac', '1', dst], signal)
}

/** Word timings for a take from the local Whisper model, or null when it is off, missing or fails. */
async function whisperTimes(
  take: string,
  words: string[],
  p: Project,
  total: number,
  tmp: string,
  ctx: TaskCtx,
  note: () => void,
  issues: string[]
): Promise<WordTiming[] | null> {
  if (!getSettings().whisperAuto || !whisperReady() || !words.length) return null
  note()
  try {
    return await timeScript(take, words, p.language, total, tmp, ctx.signal)
  } catch (e) {
    if (ctx.signal.aborted) throw e
    const message = (e as Error).message
    console.warn('[whisper]', message)
    // Staying quiet here hides a broken Whisper install: the take then gets cut by guesswork, which
    // puts the wrong audio on the wrong scene. Carry the reason onto the finished job instead.
    if (!issues.includes(message)) issues.push(message)
    return null
  }
}

async function piperTake(p: Project, group: Clip[], tmp: string, ctx: TaskCtx, note: () => void, issues: string[]): Promise<Segment[]> {
  // A blank line between scenes reads as a natural pause and gives the cutter a clear gap to find.
  // Voice tags (<sigh>, [whispers], ...) steer ElevenLabs but would be spoken literally here, so strip them.
  const take = join(tmp, `take-${randomUUID()}.wav`)
  await piperTts(group.map((c) => stripVoiceTags(c.narration)).join('\n\n'), take, ctx.signal)
  return splitTake(p, group, take, tmp, ctx, note, issues)
}

function clipName(c: Clip): string {
  return c.title?.trim() || `klip #${c.sort + 1}`
}

/** Guest FlowSpeech renders the take on flowspeech.io; we download the WAV, then cut it like a Piper take. */
// A spent monthly quota never gets better by retrying; anything else might (the reverse-engineered
// API occasionally hiccups on a long take).
const FLOWSPEECH_NO_RETRY = /kuota/i

async function flowspeechTake(
  p: Project,
  voice: string,
  group: Clip[],
  tmp: string,
  ctx: TaskCtx,
  note: () => void,
  issues: string[]
): Promise<Segment[]> {
  // Render chunk by chunk; a chunk the API rejects is halved and retried, so one bad
  // narration doesn't kill the whole batch — and the final error names the exact clip.
  const done: Segment[] = []
  const doomed: Clip[] = []
  let pending: Clip[][] = [group]
  for (let attempt = 0; attempt < 6 && pending.length; attempt++) {
    const failed: Clip[][] = []
    for (const ch of pending) {
      // Voice tags (<sigh>, [whispers], ...) steer ElevenLabs but would be spoken literally here, so strip them.
      const text = ch.map((c) => stripVoiceTags(c.narration)).join('\n\n')
      try {
        const audio = (await flowspeech.speak(text, voice, ctx.signal)).audio
        const take = join(tmp, `take-${randomUUID()}.wav`)
        writeFileSync(take, audio)
        done.push(...(await splitTake(p, ch, take, tmp, ctx, note, issues)))
      } catch (e) {
        const msg = (e as Error).message
        if (FLOWSPEECH_NO_RETRY.test(msg)) throw new Error(`${msg} -- klip: ${ch.map(clipName).join(', ')}`)
        if (ch.length > 1) {
          const mid = Math.ceil(ch.length / 2)
          failed.push(ch.slice(0, mid), ch.slice(mid))
        } else {
          doomed.push(...ch)
        }
      }
    }
    pending = failed
  }
  doomed.push(...pending.flat())
  if (doomed.length) {
    const names = [...new Set(doomed.map(clipName))]
    const sample = doomed[0]?.narration?.trim().slice(0, 200) ?? ''
    const who = names.length === 1 ? `klip "${names[0]}"` : `${names.length} klip (${names.map((n) => `"${n}"`).join(', ')})`
    throw new Error(
      `FlowSpeech ngadat ${who} berulang kali (API-nya, bukan teksnya). ` +
        `Contoh teks: "${sample}${sample.length >= 200 ? '...' : ''}". ` +
        `Tunggu sebentar lalu generate ulang.`
    )
  }
  return done
}

/** Cuts one rendered take WAV into per-scene segments with word timings (Whisper when available). */
async function splitTake(p: Project, group: Clip[], take: string, tmp: string, ctx: TaskCtx, note: () => void, issues: string[]): Promise<Segment[]> {
  const total = (await probeDurationMs(take)) / 1000
  const silences = await detectSilences(take, ctx.signal)

  // With Whisper, every script word gets its real time, and scene ends come from the words themselves.
  const perScene = group.map((c) => spokenWords(c.narration))
  const timed = await whisperTimes(take, perScene.flat(), p, total, tmp, ctx, note, issues)
  const ranges: WordTiming[][] = []
  let gaps: { end: number; start: number }[] | null = null
  if (timed) {
    let at = 0
    for (const w of perScene) {
      ranges.push(timed.slice(at, at + w.length))
      at += w.length
    }
    gaps = []
    for (let k = 0; k < group.length - 1; k++) {
      const end = ranges[k][ranges[k].length - 1]?.end
      const start = ranges[k + 1][0]?.start
      if (end == null || start == null) {
        gaps = null
        break
      }
      gaps.push({ end, start })
    }
  }
  const cuts = gaps ? cutsFromWords(gaps, silences) : chooseCuts(total, group.map((c) => stripVoiceTags(c.narration).length), silences)
  const bounds = [0, ...cuts, total]
  const out: Segment[] = []
  for (let k = 0; k < group.length; k++) {
    const to = bounds[k + 1]
    // Whisper's first word of the scene also says how much audio sits in front of the script: a TTS
    // model reading its own prompt at the top of the take, or a stray word it put at the seam between
    // two scenes. Drop it and keep a short pad, so the scene opens on its own first word.
    const at = timed ? ranges[k][0]?.start : undefined
    const start = at != null && at - bounds[k] > LEAD_TRIM_MIN_SEC && at - bounds[k] < (to - bounds[k]) * 0.6 ? at - LEAD_PAD_SEC : bounds[k]
    const len = to - start
    const file = join(tmp, `seg-${randomUUID()}.wav`)
    await cut(take, start, to, file, ctx.signal)
    let words: WordTiming[]
    if (timed) {
      words = ranges[k].map((w) => ({ ...w, start: Math.min(len, Math.max(0, w.start - start)), end: Math.min(len, Math.max(0, w.end - start)) }))
    } else {
      // Spread the words over the spoken part only, not the pauses around it.
      const lead = silences.find((s) => s.start <= start + 0.01 && s.end > start)?.end ?? start
      const tail = silences.find((s) => s.start < to && s.end >= to - 0.01)?.start ?? to
      words = estimateWordTimings(stripVoiceTags(group[k].narration), Math.max(0.3, tail - lead)).map((w) => ({
        ...w,
        start: w.start + (lead - start),
        end: w.end + (lead - start)
      }))
    }
    out.push({ clip: group[k], file, durationMs: Math.round(len * 1000), words, estimated: !timed, timedBy: timed ? WHISPER_TIMING : undefined })
  }
  return out
}

async function elevenTake(
  p: Project,
  voice: string,
  group: Clip[],
  context: { previous?: string; next?: string },
  tmp: string,
  ctx: TaskCtx
): Promise<Segment[]> {
  const r = await eleven.speak(group.map((c) => c.narration.trim()).join('\n\n'), voice, p.language, ctx.signal, context)
  const take = join(tmp, `take-${randomUUID()}.mp3`)
  writeFileSync(take, r.audio)
  const total = (await probeDurationMs(take)) / 1000
  // The alignment gives every spoken word; count them off per scene to find where each one starts and ends.
  const counts = group.map((c) => spokenWords(c.narration).length)
  const expected = counts.reduce((a, b) => a + b, 0)
  const scale = expected ? r.words.length / expected : 1
  const ranges: { first: WordTiming | undefined; last: WordTiming | undefined; words: WordTiming[] }[] = []
  let at = 0
  for (const n of counts) {
    const from = Math.round(at * scale)
    at += n
    const to = Math.max(from, Math.round(at * scale))
    const words = r.words.slice(from, to)
    ranges.push({ first: words[0], last: words[words.length - 1], words })
  }
  const bounds = [0]
  for (let k = 0; k < group.length - 1; k++) {
    const a = ranges[k].last?.end
    const b = ranges[k + 1].first?.start
    bounds.push(a != null && b != null ? (a + b) / 2 : (total * (k + 1)) / group.length)
  }
  bounds.push(total)
  const out: Segment[] = []
  for (let k = 0; k < group.length; k++) {
    const start = bounds[k]
    const end = Math.max(start + 0.3, bounds[k + 1])
    const file = join(tmp, `seg-${randomUUID()}.wav`)
    await cut(take, start, end, file, ctx.signal)
    const words = ranges[k].words.map((w) => ({ ...w, start: Math.max(0, w.start - start), end: Math.max(0, w.end - start) }))
    out.push({ clip: group[k], file, durationMs: Math.round((end - start) * 1000), words, estimated: false })
  }
  return out
}

function store(p: Project, s: Segment, voice: string, takeId: string, bytes: Buffer, provider: TtsProvider): void {
  const rel = `audio/${randomUUID()}.wav`
  const abs = assetAbsPath(p.id, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  const asset = insertAsset({
    projectId: p.id,
    clipId: s.clip.id,
    kind: 'audio',
    provider,
    model: provider === 'elevenlabs' ? getSettings().elevenModel : provider === 'flowspeech' ? voice : PIPER_VOICE,
    prompt: s.clip.narration,
    localPath: rel,
    durationMs: s.durationMs,
    meta: { words: s.words, estimatedTimings: s.estimated, voice, take: takeId, ...(s.timedBy ? { timedBy: s.timedBy } : {}) }
  })
  emit.asset(asset)
  // Each piece already carries half of the pause on either side, so the pieces play back as the one take.
  const durationMs = Math.max(1500, s.durationMs)
  // A new take starts untrimmed at the clip's start.
  const patch = { audioAssetId: asset.id, durationMs, voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
  patchClip(s.clip.id, patch)
  emit.clip({ clipId: s.clip.id, patch })
}

/** Voices the scenes that need it ("missing") or every scene ("all") as one continuous take. */
export function generateNarration(projectId: string, mode: 'missing' | 'all', attempt = 1): Job {
  const running = activeProjectJob(projectId, 'narration')
  if (running) return running
  const project = getProject(projectId)
  const targets = clipsOf(projectId).filter((c) => c.narration.trim() && (mode === 'all' || !c.audioAssetId))
  if (!targets.length) throw new Error('Tidak ada naskah narasi yang perlu disuarakan.')
  // API providers only when the project chose them and their key is available; otherwise Piper (free, local).
  // Guest FlowSpeech needs no key.
  const chosen = project.ttsProvider
  const provider: TtsProvider =
    chosen === 'flowspeech'
        ? 'flowspeech'
        : chosen === 'elevenlabs' && getSecret('elevenlabs')
          ? 'elevenlabs'
          : 'piper'
  const job = insertJob({ projectId, kind: 'narration', provider, payload: { mode, clipIds: targets.map((c) => c.id) } })
  emit.job(job)
  const makeTask = (): Task => narrationTask(projectId, mode, provider)
  return runJob(job, 'tts', makeTask(), { retry: { makeTask, attempt } })
}

function narrationTask(projectId: string, mode: 'missing' | 'all', provider: TtsProvider): Task {
  return async (ctx) => {
    const p = getProject(projectId)
    const voice = p.ttsVoice || (provider === 'flowspeech' ? FLOWSPEECH_DEFAULT_VOICE : provider === 'elevenlabs' ? '' : PIPER_VOICE)
    if (provider === 'elevenlabs' && !voice) throw new Error('Pilih suara ElevenLabs dulu di langkah Ide cerita.')
    // Recomputed here (not captured at creation) so retries and requeues see the current clips.
    const clips = clipsOf(projectId).filter((c) => c.narration.trim() && (mode === 'all' || !c.audioAssetId))
    const groups = parts(clips, provider)
    const tmp = join(dataDir(), 'tmp', `narration-${ctx.jobId}`)
    mkdirSync(tmp, { recursive: true })
    const takeId = randomUUID()
    // Anything that went wrong on the way (Whisper not timing the take) is reported on the job.
    const issues: string[] = []
    try {
      let done = 0
      // FlowSpeech takes are I/O-bound (waiting on the guest API), so two parts render
      // side by side. Other providers stay sequential: Piper is CPU-bound locally and
      // paid APIs should not be hammered harder than before.
      const takeConcurrency = provider === 'flowspeech' ? 2 : 1
      const renderGroup = async (group: Clip[], g: number): Promise<Segment[]> => {
        const note = (): void =>
          ctx.progress(0.05 + 0.85 * ((done + group.length * 0.6) / clips.length), 'Menyinkronkan caption dengan Whisper')
        return provider === 'elevenlabs'
          ? elevenTake(
              p,
              voice,
              group,
              { previous: groups[g - 1]?.map((c) => c.narration).join('\n\n'), next: groups[g + 1]?.map((c) => c.narration).join('\n\n') },
              tmp,
              ctx
            )
          : provider === 'flowspeech'
              ? flowspeechTake(p, voice, group, tmp, ctx, note, issues)
              : piperTake(p, group, tmp, ctx, note, issues)
      }
      for (let i = 0; i < groups.length; i += takeConcurrency) {
        const batch = groups.slice(i, i + takeConcurrency)
        ctx.progress(
          0.05 + 0.85 * (done / clips.length),
          groups.length > 1 ? `Membuat suara bagian ${i + 1}-${i + batch.length} dari ${groups.length}` : 'Membuat suara narasi'
        )
        const settled = await Promise.allSettled(batch.map((group, bi) => renderGroup(group, i + bi)))
        let firstError: unknown = null
        for (let bi = 0; bi < settled.length; bi++) {
          const r = settled[bi]
          if (r.status === 'fulfilled') {
            ctx.progress(0.05 + 0.85 * ((done + batch[bi].length * 0.9) / clips.length), 'Memotong suara per adegan')
            for (const s of r.value) store(p, s, voice, takeId, readFileSync(s.file), provider)
            done += batch[bi].length
          } else if (firstError === null) {
            firstError = r.reason
          }
        }
        if (firstError !== null) throw firstError
      }
      touchProject(projectId)
      const message = `${clips.length} adegan disuarakan dalam satu rekaman`
      return { message: issues.length ? `${message}. Caption pakai perkiraan — ${issues[0]}` : message }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

/**
 * Voices a single clip with the project's chosen TTS provider (FlowSpeech / ElevenLabs / Piper).
 * The old per-clip path hardcoded Piper; this keeps it consistent with generateNarration.
 */
export function generateClipNarration(clipId: string, attempt = 1): Job {
  const existing = activeJobFor({ clipId }, 'tts')
  if (existing) return existing
  const clip = getClip(clipId)
  const project = getProject(clip.projectId)
  // API providers only when the project chose them and their key is available; otherwise Piper (free, local).
  const provider: TtsProvider =
    project.ttsProvider === 'flowspeech'
        ? 'flowspeech'
        : project.ttsProvider === 'elevenlabs' && getSecret('elevenlabs')
          ? 'elevenlabs'
          : 'piper'
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'tts', provider })
  emit.job(job)
  const makeTask = (): Task => clipNarrationTask(clipId, provider, job)
  return runJob(job, 'tts', makeTask(), { retry: { makeTask, attempt } })
}

function clipNarrationTask(clipId: string, provider: TtsProvider, job: Job): Task {
  return async (ctx) => {
    const p = getProject(job.projectId)
    const fresh = getClip(clipId)
    const text = fresh.narration.trim()
    if (!text) throw new Error('Naskah klip ini masih kosong')
    const voice = p.ttsVoice || (provider === 'flowspeech' ? FLOWSPEECH_DEFAULT_VOICE : provider === 'elevenlabs' ? '' : PIPER_VOICE)
    if (provider === 'elevenlabs' && !voice) throw new Error('Pilih suara ElevenLabs dulu di langkah Ide cerita.')
    const tmp = join(dataDir(), 'tmp', `clip-tts-${ctx.jobId}`)
    mkdirSync(tmp, { recursive: true })
    const takeId = randomUUID()
    const issues: string[] = []
    try {
      ctx.progress(0.2, 'Membuat suara')
      const note = (): void => ctx.progress(0.6, 'Menyiapkan kata per kata')
      const segments =
        provider === 'elevenlabs'
          ? await elevenTake(p, voice, [fresh], {}, tmp, ctx)
          : provider === 'flowspeech'
              ? await flowspeechTake(p, voice, [fresh], tmp, ctx, note, issues)
              : await piperTake(p, [fresh], tmp, ctx, note, issues)
      ctx.progress(0.85, 'Menyimpan suara')
      for (const s of segments) store(p, s, voice, takeId, readFileSync(s.file), provider)
      touchProject(job.projectId)
      const message = 'Suara klip dibuat'
      return { message: issues.length ? `${message}. Caption pakai perkiraan — ${issues[0]}` : message }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

/**
 * Re-times caption words with the local Whisper model on each scene's audio: scenes whose timings are
 * estimates or came from an older Whisper method, or every Piper-voiced scene with "all".
 */
export function syncCaptions(projectId: string, mode: 'stale' | 'all' = 'stale', attempt = 1): Job {
  const running = activeProjectJob(projectId, 'align')
  if (running) return running
  if (!whisperReady()) throw new Error('Model Whisper belum diunduh. Unduh dulu di Pengaturan, bagian Caption akurat.')
  const targets = clipsOf(projectId).filter((c) => {
    const a = getAsset(c.audioAssetId)
    return !!a && (mode === 'all' ? a.provider !== 'elevenlabs' : captionNeedsSync(a))
  })
  if (!targets.length) throw new Error('Semua caption sudah memakai waktu dari suara aslinya.')
  const job = insertJob({ projectId, kind: 'align', provider: 'whisper', payload: { mode } })
  emit.job(job)
  const makeTask = (): Task => alignTask(projectId, mode)
  return runJob(job, 'whisper', makeTask(), { retry: { makeTask, attempt } })
}

function alignTask(projectId: string, mode: 'stale' | 'all'): Task {
  return async (ctx) => {
    const project = getProject(projectId)
    // Recomputed here so retries and requeues see the current clips.
    const targets = clipsOf(projectId).filter((c) => {
      const a = getAsset(c.audioAssetId)
      return !!a && (mode === 'all' ? a.provider !== 'elevenlabs' : captionNeedsSync(a))
    })
    const tmp = join(dataDir(), 'tmp', `align-${ctx.jobId}`)
    try {
      for (let i = 0; i < targets.length; i++) {
        ctx.progress(0.03 + 0.95 * (i / targets.length), `Menyinkronkan klip ${i + 1} dari ${targets.length}`)
        const asset = getAsset(getClip(targets[i].id).audioAssetId)
        if (!asset) continue
        const words = spokenWords(asset.prompt ?? targets[i].narration)
        if (!words.length) continue
        const seconds = (asset.durationMs ?? targets[i].durationMs) / 1000
        const timed = await timeScript(assetAbsPath(projectId, asset.localPath), words, project.language, seconds, tmp, ctx.signal)
        updateAssetMeta(asset.id, { ...asset.meta, words: timed, estimatedTimings: false, timedBy: WHISPER_TIMING })
        emit.asset(getAsset(asset.id)!)
      }
      return { message: `${targets.length} klip disinkronkan` }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

/**
 * Rebuilds the task for an interrupted narration/tts/align job so resumeJobs()
 * can run it again on the same row. Null when the kind is not owned here.
 */
export function narrationRequeuer(job: Job): { queue: QueueName; makeTask: () => Task } | null {
  const payload = ((): Record<string, unknown> => {
    try {
      return JSON.parse((getJobRaw(job.id)?.payload_json as string) ?? '{}') as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  switch (job.kind) {
    case 'narration': {
      const mode = payload['mode'] === 'all' ? 'all' : 'missing'
      const provider = job.provider as TtsProvider
      return { queue: 'tts', makeTask: () => narrationTask(job.projectId, mode, provider) }
    }
    case 'tts': {
      if (!job.clipId) return null
      const provider = job.provider as TtsProvider
      return { queue: 'tts', makeTask: () => clipNarrationTask(job.clipId as string, provider, job) }
    }
    case 'align': {
      const mode = payload['mode'] === 'all' ? 'all' : 'stale'
      return { queue: 'whisper', makeTask: () => alignTask(job.projectId, mode) }
    }
    default:
      return null
  }
}
