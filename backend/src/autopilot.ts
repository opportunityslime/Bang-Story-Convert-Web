import type { AutopilotStage, AutopilotStatus, ExportOptions, Job } from '@shared/types'
import { getDb } from './db'
import { emit } from './events'
import { onJobSettled } from './jobs'
import { clipsOf, getJob, getProject } from './repo'
import { generateScript, generateVisuals } from './story'
import { generateMissingImages, generateMissingVideos } from './generation'
import { generateNarration } from './narration'
import { startExport } from './exporter'

type Row = Record<string, any>

const STAGE_ORDER: AutopilotStage[] = ['script', 'visuals', 'narration', 'images', 'videos', 'export']

export const AUTOPILOT_STAGE_LABEL: Record<AutopilotStage, string> = {
  script: 'Menulis naskah',
  visuals: 'Menyusun storyboard',
  narration: 'Membuat suara narasi',
  images: 'Membuat gambar',
  videos: 'Membuat video',
  export: 'Mengekspor video'
}

/** Guards advance() against re-entrant pumps for the same project. */
const pumping = new Set<string>()

function toStatus(r: Row): AutopilotStatus {
  let jobIds: string[] = []
  try {
    const parsed: unknown = JSON.parse(r.job_ids as string)
    if (Array.isArray(parsed)) jobIds = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    jobIds = []
  }
  return {
    projectId: r.project_id,
    stage: r.stage as AutopilotStage,
    jobIds,
    error: (r.error as string | null) ?? null,
    updatedAt: r.updated_at
  }
}

function writeStatus(projectId: string, stage: AutopilotStage, jobIds: string[], error: string | null): AutopilotStatus {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO autopilot (project_id, stage, job_ids, error, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET stage = excluded.stage, job_ids = excluded.job_ids,
       error = excluded.error, updated_at = excluded.updated_at`
    )
    .run(projectId, stage, JSON.stringify(jobIds), error, now)
  const s: AutopilotStatus = { projectId, stage, jobIds, error, updatedAt: now }
  emit.autopilot(s)
  return s
}

/** Hands-off pipeline: idea → script → visuals → narration → images → videos → export. */
export function startAutopilot(projectId: string): AutopilotStatus {
  // Throws for an unknown project, so a bad id never leaves a stray row.
  getProject(projectId)
  const s = writeStatus(projectId, 'script', [], null)
  void advance(projectId)
  return s
}

/** Stops the run; jobs already started keep going (they stay visible and cancelable). */
export function stopAutopilot(projectId: string): void {
  getDb().prepare('DELETE FROM autopilot WHERE project_id = ?').run(projectId)
  emit.autopilot(null)
}

export function getAutopilotStatus(projectId: string): AutopilotStatus | null {
  const r = getDb().prepare('SELECT * FROM autopilot WHERE project_id = ?').get(projectId) as Row | undefined
  return r ? toStatus(r) : null
}

function fail(projectId: string, error: string): void {
  const r = getDb().prepare('SELECT * FROM autopilot WHERE project_id = ?').get(projectId) as Row | undefined
  if (!r) return
  const st = toStatus(r)
  writeStatus(projectId, st.stage, st.jobIds, error)
}

function finish(projectId: string): void {
  getDb().prepare('DELETE FROM autopilot WHERE project_id = ?').run(projectId)
  emit.autopilot(null)
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'video'
  )
}

function defaultExportOptions(projectId: string): ExportOptions {
  const p = getProject(projectId)
  return {
    fileName: slug(p.title && p.title !== 'Proyek tanpa judul' ? p.title : 'video'),
    resolution: 1080,
    fps: 30,
    burnCaptions: p.editor.captionStyle !== 'none',
    writeSrt: false,
    normalizeAudio: true,
    duckMusic: p.editor.duckMusic,
    folder: ''
  }
}

/** Runs one stage, then either waits for its jobs or moves to the next stage. */
async function advance(projectId: string): Promise<void> {
  if (pumping.has(projectId)) return
  pumping.add(projectId)
  try {
    await advanceInner(projectId)
  } finally {
    pumping.delete(projectId)
  }
}

async function advanceInner(projectId: string): Promise<void> {
  const row = getDb().prepare('SELECT * FROM autopilot WHERE project_id = ?').get(projectId) as Row | undefined
  if (!row || row.error) return
  try {
    const stage = row.stage as AutopilotStage
    switch (stage) {
      case 'script': {
        // Skip when a script already exists (e.g. resumed after a restart mid-stage).
        if (!clipsOf(projectId).some((c) => c.narration.trim() || c.story.trim())) {
          await generateScript(projectId)
        }
        if (!getAutopilotStatus(projectId)) return // stopped while the LLM was working
        writeStatus(projectId, 'visuals', [], null)
        return advanceInner(projectId)
      }
      case 'visuals': {
        // 'missing' only fills gaps, so re-running after a restart is safe.
        await generateVisuals(projectId, 'missing')
        if (!getAutopilotStatus(projectId)) return // stopped while the LLM was working
        writeStatus(projectId, 'narration', [], null)
        return advanceInner(projectId)
      }
      case 'narration': {
        const need = clipsOf(projectId).filter((c) => c.narration.trim() && !c.audioAssetId)
        if (!need.length) {
          writeStatus(projectId, 'images', [], null)
          return advanceInner(projectId)
        }
        const job = generateNarration(projectId, 'missing')
        writeStatus(projectId, 'narration', [job.id], null)
        return
      }
      case 'images': {
        const jobs = generateMissingImages(projectId)
        if (!jobs.length) {
          writeStatus(projectId, 'videos', [], null)
          return advanceInner(projectId)
        }
        writeStatus(projectId, 'images', jobs.map((j) => j.id), null)
        return
      }
      case 'videos': {
        const jobs = generateMissingVideos(projectId)
        if (!jobs.length) {
          writeStatus(projectId, 'export', [], null)
          return advanceInner(projectId)
        }
        writeStatus(projectId, 'videos', jobs.map((j) => j.id), null)
        return
      }
      case 'export': {
        const job = startExport(projectId, defaultExportOptions(projectId))
        writeStatus(projectId, 'export', [job.id], null)
        return
      }
    }
  } catch (e) {
    fail(projectId, (e as Error)?.message ?? String(e))
  }
}

/** Re-checks the current stage after a tracked job settles; advances when everything is done. */
function evaluate(projectId: string): void {
  const row = getDb().prepare('SELECT * FROM autopilot WHERE project_id = ?').get(projectId) as Row | undefined
  if (!row || row.error) return
  const st = toStatus(row)
  if (!STAGE_ORDER.includes(st.stage)) return
  if (st.stage === 'script' || st.stage === 'visuals') {
    void advance(projectId)
    return
  }
  const jobs = st.jobIds.map((id) => getJob(id))
  const failed = jobs.find((j) => j?.status === 'failed')
  const canceled = !failed && jobs.find((j) => !j || j?.status === 'canceled')
  if (failed || canceled) {
    fail(
      projectId,
      failed?.error
        ? `Autopilot berhenti: ${failed.error}`
        : canceled
          ? 'Autopilot berhenti: sebuah job dibatalkan.'
          : 'Autopilot berhenti: sebuah job gagal.'
    )
    return
  }
  if (jobs.length && jobs.every((j) => j?.status === 'done')) {
    const next = STAGE_ORDER[STAGE_ORDER.indexOf(st.stage) + 1]
    if (!next) {
      finish(projectId)
      return
    }
    writeStatus(projectId, next, [], null)
    void advance(projectId)
  }
  // Otherwise still waiting (queued/running, including an auto-retry backoff).
}

function onSettled(job: Job): void {
  const row = getDb().prepare('SELECT * FROM autopilot WHERE project_id = ?').get(job.projectId) as Row | undefined
  if (!row || row.error) return
  const st = toStatus(row)
  if (!st.jobIds.includes(job.id)) return
  evaluate(job.projectId)
}

onJobSettled(onSettled)

/**
 * Called once at server startup (after resumeJobs): picks up runs that were
 * active when the server went down. Script/visuals stages re-run; job stages
 * are re-evaluated against the jobs resumeJobs requeued or failed.
 */
export function pumpAutopilots(): void {
  const rows = getDb().prepare('SELECT * FROM autopilot').all() as Row[]
  for (const r of rows) {
    const st = toStatus(r)
    if (st.error) continue
    if (st.stage === 'script' || st.stage === 'visuals') void advance(st.projectId)
    else evaluate(st.projectId)
  }
}
