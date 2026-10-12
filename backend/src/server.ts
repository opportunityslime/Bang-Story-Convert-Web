import { randomUUID } from 'node:crypto'
import { dirname, extname, join, resolve, sep, basename } from 'node:path'
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import express from 'express'
import type { Request, Response } from 'express'
import multer from 'multer'
import { registerRoutes } from './routes'
import { sseHandler } from './sse'
import { warmUpEncryption } from './secrets'
import { resumeJobs } from './generation'
import { pumpAutopilots } from './autopilot'
import { dataDir, projectDir, assetAbsPath, repoRoot } from './paths'
import { getSettings } from './settings'
import { getProject, insertAsset } from './repo'
import { probeDurationMs, probeSize } from './services/audio'

const app = express()
app.use(express.json({ limit: '50mb' }))

registerRoutes(app)

/** Live event stream for job/clip/character/asset/whisper updates. */
app.get('/api/events', sseHandler)

/**
 * Serves a project asset. The URL is built by assetUrl() (encodeURIComponent per segment);
 * every segment is decoded and the resolved path must stay inside the project folder.
 */
app.get(/^\/api\/assets\/([^/]+)\/(.+)$/, (req: Request, res: Response) => {
  try {
    const projectId = decodeURIComponent(req.params[0])
    getProject(projectId) // 404 when the project does not exist
    const root = projectDir(projectId)
    const segments = String(req.params[1])
      .split('/')
      .map((s) => decodeURIComponent(s))
    const abs = resolve(root, ...segments)
    if (abs !== root && !abs.startsWith(root + sep)) {
      res.status(403).json({ ok: false, error: 'Akses file ditolak' })
      return
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      res.status(404).json({ ok: false, error: 'File tidak ditemukan' })
      return
    }
    // Express handles Range requests natively, so audio/video players can seek.
    res.sendFile(abs)
  } catch (e) {
    res.status(404).json({ ok: false, error: (e as Error)?.message ?? String(e) })
  }
})

const MUSIC_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/**
 * Replaces the Electron file pickers (assets:pickMusic / assets:pickImage): the browser uploads
 * the file and the server stores it under projects/<id>/music|overlays/.
 */
const upload = multer({ dest: tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } })
app.post('/api/upload', upload.single('file'), async (req: Request, res: Response) => {
  const tmp = req.file?.path
  const fail = (message: string): void => {
    if (tmp) {
      try {
        unlinkSync(tmp)
      } catch {
        // best effort
      }
    }
    res.json({ ok: false, error: message })
  }
  try {
    const projectId = String(req.body?.projectId ?? '')
    const kind = req.body?.kind === 'music' ? 'music' : req.body?.kind === 'overlay' ? 'overlay' : null
    if (!projectId || !kind || !req.file) {
      fail('Data unggahan tidak lengkap')
      return
    }
    getProject(projectId)
    const ext = extname(req.file.originalname).toLowerCase()
    const allowed = kind === 'music' ? MUSIC_EXTS : IMAGE_EXTS
    if (!allowed.has(ext)) {
      fail(kind === 'music' ? 'Format musik harus MP3, WAV, M4A, atau OGG.' : 'Format gambar harus PNG, JPG, atau WebP.')
      return
    }
    const rel = `${kind === 'music' ? 'music' : 'overlays'}/${randomUUID()}${ext}`
    const abs = assetAbsPath(projectId, rel)
    mkdirSync(dirname(abs), { recursive: true })
    renameSync(req.file.path, abs)
    const name = req.file.originalname.split(/[\\/]/).pop() ?? (kind === 'music' ? 'musik' : 'gambar')
    try {
      if (kind === 'music') {
        const durationMs = await probeDurationMs(abs).catch(() => null)
        const asset = insertAsset({ projectId, kind: 'music', provider: 'local', prompt: name, localPath: rel, durationMs })
        res.json({ ok: true, result: asset })
      } else {
        const size = await probeSize(abs).catch(() => null)
        if (!size) throw new Error('Gambar tidak bisa dibaca. Pakai file PNG, JPG, atau WebP.')
        const asset = insertAsset({ projectId, kind: 'overlay', provider: 'local', prompt: name, localPath: rel, width: size.width, height: size.height })
        res.json({ ok: true, result: asset })
      }
    } catch (e) {
      try {
        unlinkSync(abs)
      } catch {
        // best effort
      }
      throw e
    }
  } catch (e) {
    if (tmp && existsSync(tmp)) {
      try {
        unlinkSync(tmp)
      } catch {
        // best effort
      }
    }
    res.json({ ok: false, error: (e as Error)?.message ?? String(e) })
  }
})

/** Downloads a finished export; basename() keeps the name inside the export folder. */
app.get('/api/exports/:name', (req: Request, res: Response) => {
  const name = basename(String(req.params.name))
  const folder = getSettings().exportFolder ?? join(dataDir(), 'exports')
  const abs = join(folder, name)
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    res.status(404).json({ ok: false, error: 'File tidak ditemukan' })
    return
  }
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`)
  res.sendFile(abs)
})

/** Unknown /api routes answer JSON so the client can show the error. */
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: 'Endpoint tidak dikenal' })
})

/** Serves the built web client when the frontend worker has built it. */
const frontendDist = join(repoRoot(), 'frontend', 'dist')
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist))
  app.get(/^(?!\/api).*/, (_req: Request, res: Response) => {
    res.sendFile(join(frontendDist, 'index.html'))
  })
}

const port = Number(process.env.PORT ?? 3100)
dataDir()
warmUpEncryption()
void Promise.resolve(resumeJobs()).catch((e) => console.error('[resumeJobs]', e))
pumpAutopilots()
app.listen(port, () => {
  console.log(`bang-story-web backend listening on :${port}`)
})
