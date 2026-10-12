import type { Request, Response } from 'express'
import type { Asset, AutopilotStatus, CharacterPatchEvent, ClipPatchEvent, Job, WhisperStatus } from '@shared/types'

const clients = new Set<Response>()

function send(name: string, payload: unknown): void {
  const text = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const res of clients) {
    try {
      res.write(text)
    } catch {
      // A dead client is dropped on its close event; ignore write errors here.
    }
  }
}

export const emit = {
  job: (job: Job): void => send('job', job),
  clip: (e: ClipPatchEvent): void => send('clip', e),
  character: (e: CharacterPatchEvent): void => send('character', e),
  asset: (asset: Asset): void => send('asset', asset),
  whisper: (status: WhisperStatus): void => send('whisper', status),
  autopilot: (s: AutopilotStatus | null): void => send('autopilot', s)
}

/** GET /api/events — one long-lived stream for job/clip/character/asset/whisper updates. */
export function sseHandler(req: Request, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  res.write(': connected\n\n')
  clients.add(res)
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      // ignored; the close handler below removes the client
    }
  }, 25_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    clients.delete(res)
  })
}
