import type { StudioApi } from '@shared/api'
import type { Asset, AutopilotStatus, CharacterPatchEvent, ClipPatchEvent, Job, WhisperStatus } from '@shared/types'

declare global {
  interface Window {
    api: StudioApi
  }
}

/** POST /api/<group>/<method> with body {args:[...]}; unwraps {ok, result} or throws the server's Indonesian message. */
async function call<T>(path: string, args: unknown[]): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    })
  } catch {
    throw new Error('Tidak bisa menghubungi server. Pastikan backend berjalan.')
  }
  let data: { ok: boolean; result?: T; error?: string }
  try {
    data = (await res.json()) as typeof data
  } catch {
    throw new Error('Respons server tidak valid.')
  }
  if (!data.ok) throw new Error(data.error || 'Terjadi kesalahan di server.')
  return data.result as T
}

/**
 * Builds one API group: every method becomes POST /api/<group>/<method> with body {args:[...]}.
 * Properties set directly on the result (local overrides) win over the remote call.
 */
function group<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (target, prop, receiver) => {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
      return (...args: unknown[]) => call(`${name}/${String(prop)}`, args)
    }
  })
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    const done = (file: File | null): void => {
      input.remove()
      resolve(file)
    }
    input.onchange = () => done(input.files?.[0] ?? null)
    document.body.appendChild(input)
    input.click()
  })
}

/** Uploads one file via POST /api/upload (multipart: projectId, kind, file). Null when the dialog is cancelled. */
async function uploadFile(projectId: string, kind: 'music' | 'overlay'): Promise<Asset | null> {
  const file = await pickFile(kind === 'music' ? 'audio/*' : 'image/*')
  if (!file) return null
  const form = new FormData()
  form.append('projectId', projectId)
  form.append('kind', kind)
  form.append('file', file)
  let res: Response
  try {
    res = await fetch('/api/upload', { method: 'POST', body: form })
  } catch {
    throw new Error('Tidak bisa menghubungi server. Pastikan backend berjalan.')
  }
  const data = (await res.json()) as { ok: boolean; result?: Asset | null; error?: string }
  if (!data.ok) throw new Error(data.error || 'Gagal mengunggah file.')
  return data.result ?? null
}

let source: EventSource | null = null
function events(): EventSource {
  if (!source) source = new EventSource('/api/events')
  return source
}

function subscribe<T>(event: 'job' | 'clip' | 'character' | 'asset' | 'whisper' | 'autopilot', cb: (v: T) => void): () => void {
  const es = events()
  const handler = (e: Event): void => cb(JSON.parse((e as MessageEvent).data) as T)
  es.addEventListener(event, handler)
  return () => es.removeEventListener(event, handler)
}

export const webapi: StudioApi = {
  projects: group('projects'),
  templates: group('templates'),
  autopilot: group('autopilot'),
  story: group('story'),
  generate: group('generate'),
  clips: group('clips'),
  assets: Object.assign(group<StudioApi['assets']>('assets'), {
    pickMusic: (projectId: string) => uploadFile(projectId, 'music'),
    pickImage: (projectId: string) => uploadFile(projectId, 'overlay')
  }),
  settings: group('settings'),
  models: group('models'),
  endpoints: group('endpoints'),
  exporter: Object.assign(group<StudioApi['exporter']>('exporter'), {
    // The web has no folder dialog; the server always answers with its default folder.
    pickFolder: () => call<string | null>('exporter/pickFolder', []),
    reveal: async (path: string) => {
      const url = await call<string>('exporter/reveal', [path])
      window.open(typeof url === 'string' && url ? url : `/api/exports/${encodeURIComponent(path.split(/[\\/]/).pop() ?? path)}`, '_blank', 'noopener')
    }
  }),
  app: Object.assign(group<StudioApi['app']>('app'), {
    copyText: async (text: string) => {
      await navigator.clipboard.writeText(text)
    },
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener')
    }
  }),
  whisper: Object.assign(group<StudioApi['whisper']>('whisper'), {
    // The server returns its model folder path; copying it is the web equivalent of opening it.
    openFolder: async () => {
      const path = await call<string>('whisper/openFolder', [])
      if (path) await navigator.clipboard.writeText(path)
    }
  }),
  on: {
    whisper: (cb: (status: WhisperStatus) => void) => subscribe('whisper', cb),
    job: (cb: (job: Job) => void) => subscribe('job', cb),
    clip: (cb: (e: ClipPatchEvent) => void) => subscribe('clip', cb),
    character: (cb: (e: CharacterPatchEvent) => void) => subscribe('character', cb),
    asset: (cb: (asset: Asset) => void) => subscribe('asset', cb),
    autopilot: (cb: (s: AutopilotStatus | null) => void) => subscribe('autopilot', cb)
  }
}
