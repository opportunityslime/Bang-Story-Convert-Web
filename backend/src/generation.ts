import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getStyle } from '@shared/styles'
import type { Character, Clip, Job, Project } from '@shared/types'
import { emit } from './events'
import { runJob, setRemoteCanceller, type QueueName, type Task, type TaskCtx } from './jobs'
import { assetAbsPath } from './paths'
import {
  activeJobFor,
  charactersOf,
  clipsOf,
  getAsset,
  getCharacter,
  getClip,
  getJob,
  getProject,
  insertAsset,
  insertJob,
  patchClip,
  setCharacterSheet,
  touchProject,
  unfinishedJobs,
  updateJob
} from './repo'
import { getSettings } from './settings'
import { activeEndpoint, type EndpointWithKey } from './endpoints'
import { probeSize } from './services/audio'
import { downloadTo, sleep } from './services/http'
import { generateClipNarration, narrationRequeuer } from './narration'
import { exportRequeuer } from './exporter'
import { customImage } from './services/customImage'
import { customVideoCheck, customVideoCreate } from './services/customVideo'

// ---------- file helpers ----------

function extFromType(contentType: string, url: string, fallback: string): string {
  if (/png/.test(contentType)) return '.png'
  if (/jpe?g/.test(contentType)) return '.jpg'
  if (/webp/.test(contentType)) return '.webp'
  if (/mp4/.test(contentType)) return '.mp4'
  const m = /\.(png|jpe?g|webp|mp4|mov)(\?|$)/i.exec(url)
  return m ? `.${m[1].toLowerCase()}` : fallback
}

function saveFile(projectId: string, folder: string, ext: string, bytes: Buffer): string {
  const rel = `${folder}/${randomUUID()}${ext}`
  const abs = assetAbsPath(projectId, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return rel
}

// ---------- prompts (verbatim from the desktop app's generation.ts) ----------

function characterLine(c: Character): string {
  return `${c.name}: ${c.description}`
}

/** Splits the storyboard's "Avoid:" line off the scene, so it can be phrased as a clear instruction. */
function splitAvoid(visual: string): { scene: string; avoid: string } {
  const lines = visual.split('\n')
  const i = lines.findIndex((l) => /^\s*avoid\s*:/i.test(l))
  if (i < 0) return { scene: visual.trim(), avoid: '' }
  const avoid = lines[i].replace(/^\s*avoid\s*:\s*/i, '').replace(/\.$/, '').trim()
  lines.splice(i, 1)
  return { scene: lines.join('\n').trim(), avoid }
}

/**
 * The image prompt for a clip. The scene comes first so the model gets the content right, then who the
 * characters are, then the art style. Clothing follows the scene's Wardrobe line when it has one, so a
 * character can change out of the outfit on their reference sheet (no spacesuit indoors).
 */
function clipPrompt(project: Project, clip: Clip, chars: Character[], refNames: string[], limit: number): string {
  const style = getStyle(project.styleId)
  const { scene, avoid } = splitAvoid(clip.visualPrompt)
  const wardrobe = /^\s*wardrobe\s*:/im.test(scene)
  const parts = [`Scene:\n${scene}`]
  if (chars.length)
    parts.push(
      `Recurring characters in this scene. Keep each one's body, face, hair and skin exactly as described${refNames.length ? ' and as on their reference sheet' : ''}.` +
        (wardrobe
          ? ' Their clothing follows the Wardrobe line of the scene: the default outfit only where it says so, otherwise the custom outfit.'
          : ' They wear their default outfit.') +
        `\n${chars.map(characterLine).join('\n')}`
    )
  if (refNames.length)
    parts.push(
      `Reference images are character sheets, in this order: ${refNames.join(', ')}. Use them for each character's identity, proportions and colors. ` +
        (wardrobe ? 'Copy the costume from a sheet only for characters whose Wardrobe line says "default outfit". ' : 'Match the costume to the sheet. ') +
        'Do not copy the sheet layout, poses or plain background.'
    )
  parts.push(`Art style: ${style.prompt}`)
  if (avoid) parts.push(`Must not appear in the image: ${avoid}.`)
  parts.push(`Frame format ${project.aspectRatio}, full-bleed composition.`)
  const full = parts.join('\n\n')
  if (full.length <= limit) return full
  // Models with short prompt limits get the scene first, so trimming only loses style detail.
  return [scene, chars.map(characterLine).join('; '), avoid && `Must not appear: ${avoid}.`, style.prompt].filter(Boolean).join('\n\n')
}

function sheetPrompt(project: Project, c: Character): string {
  const style = getStyle(project.styleId)
  return [
    style.prompt,
    `Character reference sheet for "${c.name}": ${c.description}. The character is ${style.characterHint}.`,
    'Show the SAME character three times side by side: front view, three-quarter view and side view, full body, neutral standing pose, evenly spaced, on a plain light neutral background (this overrides any background instruction above). Consistent proportions, costume and colors in all three views.'
  ].join('\n\n')
}

/** True when an image attempt was abandoned because its internal timeout fired first. */
function isAttemptTimeout(e: unknown): boolean {
  return e instanceof Error && /tidak menjawab dalam 4 menit/.test(e.message)
}

/**
 * Generates one image with up to 3 attempts (1 + 2 recreates) on the project's
 * image endpoint. Only internal-timeout attempts are retried with a fresh attempt.
 */
async function imageWithRetries(
  ctx: TaskCtx,
  prompt: string,
  aspectRatio: '1:1' | '16:9' | '9:16',
  endpoint: EndpointWithKey
): Promise<{ image: Buffer; model: string }> {
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    ctx.progress(0.08 + 0.1 * (attempt - 1), `Membuat gambar di ${endpoint.name} (percobaan ${attempt}/${MAX_ATTEMPTS})`)
    try {
      return await customImage({ endpoint, prompt, aspectRatio, signal: ctx.signal })
    } catch (e) {
      if (ctx.signal.aborted) throw e // user abort is not retried
      if (isAttemptTimeout(e) && attempt < MAX_ATTEMPTS) continue // abandon this attempt, start fresh
      throw e
    }
  }
  throw new Error(`${endpoint.name} tidak menjawab dalam 4 menit (3x percobaan). Coba lagi nanti.`)
}

/** Which image endpoint a project uses: its own choice, else the app default. */
function imageEndpointFor(project: Project): EndpointWithKey {
  return activeEndpoint('image', project.imageEndpointId ?? getSettings().defaultImageEndpointId)
}

/** Downloads a result URL and registers it as an asset. */
async function downloadResult(
  ctx: TaskCtx,
  job: Job,
  url: string,
  folder: 'images' | 'videos',
  kind: 'image' | 'video',
  model: string,
  prompt: string,
  remoteId: string,
  clipId: string | null,
  characterId: string | null
): Promise<string> {
  ctx.progress(0.9, 'Mengunduh hasil')
  const { bytes, contentType } = await downloadTo(url, ctx.signal)
  return registerBytes(ctx, job, bytes, contentType, folder, kind, model, prompt, url, remoteId, clipId, characterId)
}

/** Registers already-held bytes (e.g. base64 from Mage) as an asset, skipping the download step. */
async function registerBytes(
  ctx: TaskCtx,
  job: Job,
  bytes: Buffer,
  contentType: string,
  folder: 'images' | 'videos',
  kind: 'image' | 'video',
  model: string,
  prompt: string,
  remoteUrl: string,
  provider: string,
  clipId: string | null,
  characterId: string | null
): Promise<string> {
  ctx.progress(0.9, 'Menyimpan hasil')
  const rel = saveFile(job.projectId, folder, extFromType(contentType, remoteUrl, folder === 'videos' ? '.mp4' : '.png'), bytes)
  const abs = assetAbsPath(job.projectId, rel)
  const size = await probeSize(abs).catch(() => null)
  const asset = insertAsset({
    projectId: job.projectId,
    clipId,
    characterId,
    kind,
    provider,
    model,
    prompt,
    remoteId: provider,
    remoteUrl,
    localPath: rel,
    width: size?.width ?? null,
    height: size?.height ?? null
  })
  emit.asset(asset)
  return asset.id
}

// ---------- public entry points ----------

function imageTask(clipId: string, job: Job): Task {
  return async (ctx) => {
    ctx.progress(0.04, 'Menyiapkan prompt')
    const fresh = getClip(clipId)
    const project = getProject(fresh.projectId)
    const chars = charactersOf(project.id).filter((c) => fresh.characterIds.includes(c.id))
    const prompt = clipPrompt(project, fresh, chars, [], 4000)
    const endpoint = imageEndpointFor(project)
    const { image, model } = await imageWithRetries(ctx, prompt, project.aspectRatio, endpoint)
    const assetId = await registerBytes(ctx, job, image, 'image/png', 'images', 'image', model, prompt, '', endpoint.id, clipId, null)
    await setActiveAsset(clipId, assetId)
    touchProject(job.projectId)
    return assetId
  }
}

export function generateClipImage(clipId: string, attempt = 1): Job {
  const existing = activeJobFor({ clipId }, 'image')
  if (existing) return existing
  const clip = getClip(clipId)
  const endpoint = imageEndpointFor(getProject(clip.projectId))
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'image', provider: endpoint.id })
  emit.job(job)
  const makeTask = (): Task => imageTask(clipId, job)
  return runJob(job, 'media', makeTask(), { retry: { makeTask, attempt } })
}

function sheetTask(characterId: string, job: Job): Task {
  return async (ctx) => {
    ctx.progress(0.04, 'Menyiapkan prompt')
    const project = getProject(job.projectId)
    const prompt = sheetPrompt(project, getCharacter(characterId))
    const endpoint = imageEndpointFor(project)
    const { image, model } = await imageWithRetries(ctx, prompt, '16:9', endpoint)
    const assetId = await registerBytes(ctx, job, image, 'image/png', 'images', 'image', model, prompt, '', endpoint.id, null, characterId)
    setCharacterSheet(characterId, assetId)
    emit.character({ characterId, patch: { sheetAssetId: assetId } })
    touchProject(job.projectId)
    return assetId
  }
}

export function generateCharacterSheet(characterId: string, attempt = 1): Job {
  const existing = activeJobFor({ characterId }, 'sheet')
  if (existing) return existing
  const c = getCharacter(characterId)
  const endpoint = imageEndpointFor(getProject(c.projectId))
  const job = insertJob({ projectId: c.projectId, characterId, kind: 'sheet', provider: endpoint.id })
  emit.job(job)
  const makeTask = (): Task => sheetTask(characterId, job)
  return runJob(job, 'media', makeTask(), { retry: { makeTask, attempt } })
}

const VIDEO_POLL_MS = 10 * 1000
const VIDEO_ATTEMPT_BUDGET_MS = 6 * 60 * 1000
const VIDEO_MAX_ATTEMPTS = 3 // 1 + 2 recreates
const MAX_BASE64_IMAGE_BYTES = 15 * 1024 * 1024

export function generateClipVideo(clipId: string, attempt = 1): Job {
  const existing = activeJobFor({ clipId }, 'video')
  if (existing) return existing
  const clip = getClip(clipId)
  const endpoint = videoEndpointFor(getProject(clip.projectId))
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'video', provider: endpoint.id })
  emit.job(job)
  const makeTask = (): Task => videoTask(clipId, job)
  return runJob(job, 'media', makeTask(), { retry: { makeTask, attempt } })
}

/** Which video endpoint a project uses: its own choice, else the app default. */
function videoEndpointFor(project: Project): EndpointWithKey {
  return activeEndpoint('video', project.videoEndpointId ?? getSettings().defaultVideoEndpointId)
}

function videoTask(clipId: string, job: Job): Task {
  return async (ctx) => {
    const fresh = getClip(clipId)
    const project = getProject(fresh.projectId)
    let prompt =
      fresh.videoPrompt.trim() ||
      `${splitAvoid(fresh.visualPrompt).scene.replace(/\.$/, '')}. Subtle natural motion of the characters and environment, the camera slowly pushes in. Keep the art style of the first frame.`
    const endpoint = videoEndpointFor(project)
    // Image-to-video when the clip has an image; text-to-video otherwise.
    let imageBase64: string | undefined
    const image = fresh.imageAssetId ? getAsset(fresh.imageAssetId) : null
    if (image) {
      ctx.progress(0.05, 'Menyiapkan gambar awal')
      const bytes = readFileSync(assetAbsPath(image.projectId, image.localPath))
      if (bytes.byteLength <= MAX_BASE64_IMAGE_BYTES) {
        imageBase64 = bytes.toString('base64')
        prompt = `Open on the exact scene of the reference image and keep its art style, characters and composition. ${prompt}`
      }
      // Bigger than ~15MB: fall back to text-to-video instead of risking a rejected payload.
    }
    let url: string | null = null
    let taskId = ''
    const model = endpoint.model.trim()
    for (let attempt = 1; attempt <= VIDEO_MAX_ATTEMPTS && !url; attempt++) {
      ctx.progress(0.1, `Membuat video di ${endpoint.name} (percobaan ${attempt}/${VIDEO_MAX_ATTEMPTS})`)
      const created = await customVideoCreate({ endpoint, prompt, ratio: project.aspectRatio, imageBase64, signal: ctx.signal })
      if (created.videoBytes) {
        const assetId = await registerBytes(ctx, job, created.videoBytes, 'video/mp4', 'videos', 'video', model, prompt, '', endpoint.id, clipId, null)
        await setActiveAsset(clipId, assetId)
        touchProject(job.projectId)
        return assetId
      }
      if (created.videoUrl) {
        url = created.videoUrl
        break
      }
      taskId = created.taskId as string
      ctx.setRemote(taskId)
      const deadline = Date.now() + VIDEO_ATTEMPT_BUDGET_MS
      const started = Date.now()
      while (Date.now() < deadline) {
        await sleep(VIDEO_POLL_MS, ctx.signal)
        const st = await customVideoCheck(endpoint, taskId, ctx.signal)
        if (st.status === 'failed') throw new Error(`${endpoint.name} gagal membuat video: ${st.error ?? 'tanpa keterangan'}.`)
        if (st.status === 'done' && st.videoUrl) {
          url = st.videoUrl
          break
        }
        const frac = Math.min(0.95, (Date.now() - started) / VIDEO_ATTEMPT_BUDGET_MS)
        ctx.progress(0.12 + 0.7 * frac, 'Menunggu video jadi')
      }
    }
    if (!url) throw new Error('Waktu tunggu video habis setelah 3 percobaan. Coba lagi nanti.')
    const assetId = await downloadResult(ctx, job, url, 'videos', 'video', model, prompt, taskId, clipId, null)
    await setActiveAsset(clipId, assetId)
    touchProject(job.projectId)
    return assetId
  }
}

export function generateClipTts(clipId: string): Job {
  // Provider-aware: honors the project's TTS setting (FlowSpeech/ElevenLabs/Piper).
  return generateClipNarration(clipId)
}

/** Every clip without an image. */
export function generateMissingImages(projectId: string): Job[] {
  return clipsOf(projectId)
    .filter((c) => !c.imageAssetId)
    .map((c) => generateClipImage(c.id))
}

/** Every clip that has an image but no video yet. */
export function generateMissingVideos(projectId: string): Job[] {
  return clipsOf(projectId)
    .filter((c) => c.imageAssetId && !c.videoAssetId)
    .map((c) => generateClipVideo(c.id))
}

/** Every clip without audio. */
export function generateMissingTts(projectId: string): Job[] {
  return clipsOf(projectId)
    .filter((c) => !c.audioAssetId)
    .map((c) => generateClipTts(c.id))
}

/**
 * Rebuilds the task for an interrupted image/sheet/video job so resumeJobs()
 * can run it again. Null when the kind is not owned here.
 */
export function generationRequeuer(job: Job): { queue: QueueName; makeTask: () => Task } | null {
  switch (job.kind) {
    case 'image':
      if (!job.clipId) return null
      return { queue: 'media', makeTask: () => imageTask(job.clipId as string, job) }
    case 'sheet':
      if (!job.characterId) return null
      return { queue: 'media', makeTask: () => sheetTask(job.characterId as string, job) }
    case 'video':
      if (!job.clipId) return null
      return { queue: 'media', makeTask: () => videoTask(job.clipId as string, job) }
    default:
      return null
  }
}

/**
 * Jobs left unfinished by a shutdown. With auto-retry on they are queued again on
 * the same row (fresh attempt) instead of being marked failed — this also covers
 * exports interrupted by a deploy. Note: image/video jobs cannot be resumed remotely, so
 * a requeue starts a brand-new endpoint job, the same cost a manual retry would have.
 */
export function resumeJobs(): void {
  const auto = getSettings().autoRetry
  for (const row of unfinishedJobs()) {
    const job = getJob(row.id)
    const rebuilt = job ? generationRequeuer(job) ?? narrationRequeuer(job) ?? exportRequeuer(job) : null
    if (auto && job && rebuilt) {
      emit.job(updateJob(job.id, { status: 'queued', progress: 0, error: null, message: 'Dijadwalkan ulang otomatis setelah server restart.' }))
      runJob(job, rebuilt.queue, rebuilt.makeTask(), { retry: { makeTask: rebuilt.makeTask, attempt: 1 } })
      continue
    }
    emit.job(updateJob(row.id, { status: 'failed', error: 'Terputus saat server mati. Silakan ulangi.', message: null }))
  }
}

export async function setActiveAsset(clipId: string, assetId: string): Promise<void> {
  const asset = getAsset(assetId)
  if (!asset || asset.clipId !== clipId) throw new Error('Aset tidak cocok dengan klip ini')
  const patch: Partial<Clip> =
    asset.kind === 'image'
      ? { imageAssetId: asset.id }
      : asset.kind === 'video'
        ? { videoAssetId: asset.id, mediaInMs: 0, motionType: 'video' }
        : asset.kind === 'audio'
          ? { audioAssetId: asset.id, durationMs: Math.max(1500, (asset.durationMs ?? 0) + 400), voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
          : {}
  patchClip(clipId, patch)
  emit.clip({ clipId, patch })
}

// Custom endpoints expose no cancel API; aborting the AbortSignal is the only cancellation.
setRemoteCanceller(async () => {})
