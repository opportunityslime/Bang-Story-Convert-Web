import type { Job } from '@shared/types'
import { emit } from './events'
import { getJob, getJobRaw, updateJob } from './repo'
import { getSettings } from './settings'

export type QueueName = 'media' | 'tts' | 'whisper' | 'export'

export interface TaskCtx {
  jobId: string
  signal: AbortSignal
  progress(p: number, message?: string): void
  setRemote(id: string): void
}

/** A task returns the id of the asset it produced, or a message to keep on the finished job (e.g. an output path). */
export type Task = (ctx: TaskCtx) => Promise<string | void | { message: string }>

/** How a failed job can be attempted again on the same job row. */
export interface RetryPolicy {
  /** Rebuilds the task for another attempt (tasks are one-shot closures). */
  makeTask: () => Task
  /** 1-based count of the attempt that just ran. */
  attempt: number
}

/** Total tries per job when auto-retry is on (1 initial + 4 retries). */
export const MAX_RETRY_ATTEMPTS = 5
/** Wait before retry N (index N-1): 1m, 3m, 10m, 20m. */
const RETRY_BACKOFF_MS = [60_000, 180_000, 600_000, 1_200_000]

/**
 * Errors that can never succeed on retry: bad credentials, empty quota, rejected
 * content, missing input, or broken project data (the user must fix these first).
 * Consecutive provider 524s are also excluded: the server keeps billing while the
 * app never receives the result, so blind retries only burn credits.
 */
const PERMANENT_ERROR_PATTERNS = [
  /kunci|api[_-]?key|unauthorized|unauthorised|\b401\b|\b403\b|forbidden/i,
  /kuota|quota|insufficient/i,
  /ditolak|content filter|moderat/i,
  /tidak ditemukan|not found/i,
  /pilih .* dulu|masih kosong/i,
  /melewati durasi|matches no streams|tanpa .* stream/i,
  /beruntun \(524\)|percobaan buta/i,
  /tidak dicoba ulang/i
]

export function isRetryableError(message: string): boolean {
  // Clip titles and sample narration travel inside quotes in the message; a clip
  // titled "Kunci Pembuka Rahasia" must not look like an API-key problem.
  const signal = message.replace(/"[^"]*"/g, '')
  return !PERMANENT_ERROR_PATTERNS.some((re) => re.test(signal))
}

function retryDelayLabel(ms: number): string {
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.round(m / 60)} jam` : `${m} menit`
}

// Whisper uses most CPU cores by itself, so it runs one file at a time.
const LIMITS: Record<QueueName, number> = { media: 3, tts: 2, whisper: 1, export: 1 }
const running: Record<QueueName, number> = { media: 0, tts: 0, whisper: 0, export: 0 }
const waiting: Record<QueueName, (() => void)[]> = { media: [], tts: [], whisper: [], export: [] }
const controllers = new Map<string, AbortController>()

/**
 * Listeners run when a job reaches a terminal state (done, failed, or canceled).
 * A failure with a retry scheduled re-queues instead of settling. Used by the
 * autopilot driver.
 */
export type JobSettledListener = (job: Job) => void
const jobSettledListeners: JobSettledListener[] = []
export function onJobSettled(fn: JobSettledListener): void {
  jobSettledListeners.push(fn)
}

function notifySettled(job: Job): void {
  for (const fn of jobSettledListeners) {
    try {
      fn(job)
    } catch (e) {
      console.error('[jobSettled listener]', e)
    }
  }
}

/**
 * Pluggable remote cancel: the generation worker registers its remote canceller here so jobs.ts
 * never imports the provider client directly.
 */
let remoteCanceller: ((remoteId: string) => Promise<void>) | null = null
export function setRemoteCanceller(fn: ((remoteId: string) => Promise<void>) | null): void {
  remoteCanceller = fn
}

function acquire(q: QueueName): Promise<void> {
  if (running[q] < LIMITS[q]) {
    running[q]++
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    waiting[q].push(() => {
      running[q]++
      resolve()
    })
  )
}

function release(q: QueueName): void {
  running[q]--
  waiting[q].shift()?.()
}

export function runJob(job: Job, queue: QueueName, task: Task, opts?: { retry?: RetryPolicy }): Job {
  const ctrl = new AbortController()
  controllers.set(job.id, ctrl)
  let lastEmit = 0
  const ctx: TaskCtx = {
    jobId: job.id,
    signal: ctrl.signal,
    progress: (p, message) => {
      const now = Date.now()
      const j = updateJob(job.id, { progress: Math.min(0.99, Math.max(0, p)), ...(message !== undefined ? { message } : {}) })
      if (now - lastEmit > 250 || p >= 0.99) {
        lastEmit = now
        emit.job(j)
      }
    },
    setRemote: (id) => {
      updateJob(job.id, { remoteId: id })
    }
  }
  void (async () => {
    await acquire(queue)
    if (ctrl.signal.aborted) {
      release(queue)
      controllers.delete(job.id)
      const canceledJob = updateJob(job.id, { status: 'canceled', message: null })
      emit.job(canceledJob)
      notifySettled(canceledJob)
      return
    }
    try {
      emit.job(updateJob(job.id, { status: 'running', progress: 0.02 }))
      const result = await task(ctx)
      const extra =
        typeof result === 'string' ? { resultAssetId: result, message: null } : { message: result?.message ?? null }
      const doneJob = updateJob(job.id, { status: 'done', progress: 1, ...extra })
      emit.job(doneJob)
      notifySettled(doneJob)
    } catch (e) {
      const canceled = ctrl.signal.aborted
      const message = (e as Error)?.message ?? String(e)
      const policy = opts?.retry
      if (
        !canceled &&
        policy &&
        policy.attempt < MAX_RETRY_ATTEMPTS &&
        getSettings().autoRetry &&
        isRetryableError(message)
      ) {
        // Transient failure with auto-retry on: park the job as queued and try again
        // on the same row after a backoff. The switch is re-checked when the timer
        // fires, and a user cancel in between stops the retry.
        const next = policy.attempt + 1
        const waitMs = RETRY_BACKOFF_MS[Math.min(policy.attempt - 1, RETRY_BACKOFF_MS.length - 1)]
        emit.job(
          updateJob(job.id, {
            status: 'queued',
            progress: 0,
            error: null,
            message: `Gagal: ${message}. Mencoba lagi otomatis dalam ${retryDelayLabel(waitMs)} (percobaan ${next}/${MAX_RETRY_ATTEMPTS}).`
          })
        )
        setTimeout(() => {
          const current = getJob(job.id)
          if (!current || current.status !== 'queued' || !getSettings().autoRetry) return
          runJob(current, queue, policy.makeTask(), { retry: { makeTask: policy.makeTask, attempt: next } })
        }, waitMs)
      } else {
        const finalMessage =
          !canceled && policy && policy.attempt >= MAX_RETRY_ATTEMPTS && getSettings().autoRetry
            ? `Berhenti otomatis setelah ${MAX_RETRY_ATTEMPTS}x gagal: ${message}`
            : message
        const finalJob = updateJob(job.id, {
          status: canceled ? 'canceled' : 'failed',
          error: canceled ? null : finalMessage,
          message: null
        })
        emit.job(finalJob)
        // A terminal state settles the job; a scheduled retry re-queues it instead.
        notifySettled(finalJob)
      }
      if (!canceled) console.error(`[job ${job.kind}]`, e)
    } finally {
      release(queue)
      controllers.delete(job.id)
    }
  })()
  return job
}

export async function cancelJob(id: string): Promise<void> {
  const raw = getJobRaw(id)
  if (!raw) return
  if (raw.remote_id && remoteCanceller) await remoteCanceller(raw.remote_id)
  const ctrl = controllers.get(id)
  if (ctrl) ctrl.abort()
  else if (raw.status === 'queued' || raw.status === 'running') {
    const canceledJob = updateJob(id, { status: 'canceled', message: null })
    emit.job(canceledJob)
    notifySettled(canceledJob)
  }
}

export function isActive(id: string): boolean {
  return controllers.has(id)
}
