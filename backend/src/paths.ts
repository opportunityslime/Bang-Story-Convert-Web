import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Backend package root at runtime.
 * tsc compiles backend/src/** together with ../shared/**, so the inferred common root is the
 * repo root and the emit lands in dist/backend/src — from there ../../.. is backend/. */
export function backendRoot(): string {
  return join(__dirname, '..', '..', '..')
}

/** Repository root at runtime (one level above backendRoot). */
export function repoRoot(): string {
  return join(__dirname, '..', '..', '..', '..')
}

/** Server-side data folder. Overridable with BANG_STORY_DATA (used by tests/dev). */
export function dataDir(): string {
  const dir = process.env.BANG_STORY_DATA || join(homedir(), '.bang-story-web')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function dbPath(): string {
  return join(dataDir(), 'studio.db')
}

export function projectsRoot(): string {
  const dir = join(dataDir(), 'projects')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function projectDir(projectId: string): string {
  const dir = join(projectsRoot(), projectId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Absolute path of an asset stored relative to its project folder. */
export function assetAbsPath(projectId: string, localPath: string): string {
  return join(projectsRoot(), projectId, localPath)
}

/** Caption fonts shipped with the backend (populated by the media worker's resources). */
export function fontsDir(): string {
  return join(backendRoot(), 'resources', 'fonts')
}

/** URL the web client uses for a stored asset (served by GET /api/assets/:projectId/*). */
export function assetUrl(projectId: string, localPath: string): string {
  const rel = `${projectId}/${localPath}`.split(/[\\/]/).map(encodeURIComponent).join('/')
  return `/api/assets/${rel}`
}

/** ffmpeg binary path; identity on the web backend (no asar unpacking like in Electron). */
export function binPath(p: string): string {
  return p
}
