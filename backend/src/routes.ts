import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Express, Request, Response } from 'express'
import type {
  ApiProvider,
  AppSettings,
  EndpointDialect,
  EndpointKind,
  ExportOptions,
  KeyTestResult,
  ModelSource,
  NewProjectInput,
  ProjectSnapshot,
  TtsProvider,
  WordTiming
} from '@shared/types'
import { generateScript, generateVisuals, generateMusicPrompt } from './story'
import {
  generateCharacterSheet,
  generateClipImage,
  generateClipTts,
  generateClipVideo,
  generateMissingImages,
  generateMissingTts,
  generateMissingVideos,
  setActiveAsset
} from './generation'
import { cancelJob } from './jobs'
import { generateNarration, syncCaptions } from './narration'
import { cancelDownload, downloadModel, modelDir, removeModel, whisperStatus } from './whisper'
import { backendRoot } from './paths'
import { detachVoice, splitClip } from './editing'
import { emit } from './sse'
import {
  createProject,
  deleteTemplate,
  duplicateProject,
  getAsset,
  getBundle,
  listProjects,
  listTemplates,
  removeProject,
  saveSnapshot,
  saveTemplateFromProject,
  updateAssetMeta
} from './repo'
import { clearSecret, keyStatuses, recordCheck, revealSecret, setSecret } from './secrets'
import { dropCache, getSettings, setSettings } from './settings'
import { listPiperVoices } from './services/piper'
import * as eleven from './services/elevenlabs'
import * as flowspeech from './services/flowspeech'
import { listEndpointModels, listModels, probeEndpointModels, testLlmEndpoint } from './services/llm'
import { createEndpoint, deleteEndpoint, listEndpoints, revealEndpointKey, setEndpointKey, updateEndpoint } from './endpoints'
import { testVideoEndpoint } from './services/customVideo'
import { deleteExportFile, exportFolder, listExportJobs, listExports, startExport } from './exporter'
import { getAutopilotStatus, startAutopilot, stopAutopilot } from './autopilot'

type Handler = (args: unknown[]) => unknown

let cachedVersion: string | null = null
function appVersion(): string {
  if (cachedVersion == null) {
    try {
      cachedVersion = (JSON.parse(readFileSync(join(backendRoot(), 'package.json'), 'utf8')) as { version?: string }).version ?? 'dev'
    } catch {
      cachedVersion = 'dev'
    }
  }
  return cachedVersion
}

/** Every IPC channel from the Electron app, now a POST /api/<group>/<method> route. */
const routes: Record<string, Handler> = {
  'projects/list': () => listProjects(),
  'projects/create': (args) => {
    const input = args[0] as NewProjectInput
    const p = createProject(input)
    if (input.autopilot) startAutopilot(p.id)
    return getBundle(p.id)
  },
  'projects/get': (args) => getBundle(args[0] as string),
  'projects/save': (args) => ({ updatedAt: saveSnapshot(args[0] as ProjectSnapshot) }),
  'projects/remove': (args) => {
    removeProject(args[0] as string)
    return null
  },
  'projects/duplicate': (args) => duplicateProject(args[0] as string),

  'templates/list': () => listTemplates(),
  'templates/save': (args) => saveTemplateFromProject(String(args[0] ?? ''), String(args[1] ?? '')),
  'templates/delete': (args) => ({ deleted: deleteTemplate(String(args[0] ?? '')) }),

  'autopilot/start': (args) => startAutopilot(args[0] as string),
  'autopilot/stop': (args) => {
    stopAutopilot(args[0] as string)
    return null
  },
  'autopilot/status': (args) => getAutopilotStatus(args[0] as string),

  'story/script': (args) => generateScript(args[0] as string),
  'story/musicPrompt': (args) => generateMusicPrompt(args[0] as string),
  'story/visuals': (args) => generateVisuals(args[0] as string, args[1] === 'all' ? 'all' : 'missing'),

  'generate/clipImage': (args) => generateClipImage(args[0] as string),
  'generate/clipVideo': (args) => generateClipVideo(args[0] as string),
  'generate/clipTts': (args) => generateClipTts(args[0] as string),
  'generate/characterSheet': (args) => generateCharacterSheet(args[0] as string),
  'generate/missingImages': (args) => generateMissingImages(args[0] as string),
  'generate/missingVideos': (args) => generateMissingVideos(args[0] as string),
  'generate/missingTts': (args) => generateMissingTts(args[0] as string),
  'generate/narration': (args) => generateNarration(args[0] as string, args[1] === 'all' ? 'all' : 'missing'),
  'generate/syncCaptions': (args) => syncCaptions(args[0] as string, args[1] === 'all' ? 'all' : 'stale'),
  'generate/cancel': (args) => cancelJob(args[0] as string),

  'clips/split': (args) => splitClip(args[0] as string, Number(args[1])),
  'clips/detachVoice': (args) => detachVoice(args[0] as string),

  'assets/setActive': (args) => setActiveAsset(args[0] as string, args[1] as string),
  // Caption text fixed by hand in the editor; the words keep their times.
  'assets/setWords': (args) => {
    const a = getAsset(args[0] as string)
    if (!a || a.kind !== 'audio') throw new Error('Suara klip tidak ditemukan')
    const words = args[1] as WordTiming[]
    const clean = (Array.isArray(words) ? words : [])
      .filter((w) => w && typeof w.text === 'string' && w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
      .map((w) => ({ text: w.text.trim(), start: Math.max(0, w.start), end: Math.max(w.start, w.end) }))
    updateAssetMeta(a.id, { ...a.meta, words: clean, editedWords: true })
    const fresh = getAsset(a.id)!
    emit.asset(fresh)
    return fresh
  },

  'settings/get': () => getSettings(),
  'settings/set': (args) => setSettings(args[0] as Partial<AppSettings>),
  'settings/keys': () => keyStatuses(),
  'settings/setKey': async (args) => {
    const provider = args[0] as ApiProvider
    const clean = String(args[1] ?? '').trim()
    if (!clean) throw new Error('Kunci masih kosong')
    setSecret(provider, clean)
    dropCache(`models:${provider}`)
    const result = await eleven.testKey(clean)
    recordCheck(provider, result.ok, result.message)
    return result
  },
  'settings/clearKey': (args) => {
    const provider = args[0] as ApiProvider
    clearSecret(provider)
    dropCache(`models:${provider}`)
    return null
  },
  'settings/testKey': async (args) => {
    const provider = args[0] as ApiProvider
    const result = await eleven.testKey().catch((e): KeyTestResult => ({ ok: false, message: (e as Error).message }))
    recordCheck(provider, result.ok, result.message)
    return result
  },
  'settings/revealKey': (args) => revealSecret(args[0] as ApiProvider),
  'settings/voices': (args) => {
    const provider = args[0] as TtsProvider
    if (provider === 'piper') return listPiperVoices()
    if (provider === 'flowspeech') return flowspeech.listVoices()
    return eleven.listVoices()
  },
  'settings/flowspeechStatus': () => flowspeech.testConnection(),

  'models/list': (args) => listModels(args[0] as ModelSource),

  'endpoints/list': (args) => listEndpoints(args[0] as EndpointKind | undefined),
  'endpoints/create': (args) => {
    const input = args[0] as { kind: EndpointKind; name: string; baseUrl: string; model: string; dialect?: EndpointDialect; apiKey?: string }
    const created = createEndpoint(input)
    if (input.apiKey?.trim()) setEndpointKey(created.id, input.apiKey)
    return created
  },
  'endpoints/update': (args) => {
    const id = String(args[0])
    const patch = args[1] as { name?: string; baseUrl?: string; model?: string; dialect?: EndpointDialect; apiKey?: string | null }
    const updated = updateEndpoint(id, patch)
    dropCache(`models:endpoint:${id}`)
    return updated
  },
  'endpoints/delete': (args) => ({ deleted: deleteEndpoint(String(args[0])) }),
  'endpoints/revealKey': (args) => revealEndpointKey(String(args[0])),
  'endpoints/models': (args) => listEndpointModels(String(args[0]), !!args[1]),
  'endpoints/probeModels': (args) => {
    const input = args[0] as { baseUrl: string; apiKey?: string }
    return probeEndpointModels(input.baseUrl, input.apiKey ?? null)
  },
  'endpoints/test': async (args): Promise<KeyTestResult> => {
    const { getEndpoint } = await import('./endpoints')
    const { resolveDialect } = await import('./services/dialects')
    const dialectName = (d: EndpointDialect) =>
      d === 'gemini' ? 'Gemini-style' : d === 'openai' ? 'OpenAI' : d === 'bangstory' ? 'Bang Story' : d
    const ep = getEndpoint(String(args[0]))
    if (ep.kind === 'llm') return testLlmEndpoint(ep.id)
    if (ep.kind === 'video') {
      const r = await testVideoEndpoint(ep)
      const d = await resolveDialect(ep).catch(() => null)
      if (d && r.ok) r.message += ` · dialek: ${dialectName(d)}`
      return r
    }
    const { customImage } = await import('./services/customImage')
    try {
      await customImage({ endpoint: ep, prompt: 'Tes koneksi: gambar uji kecil.', aspectRatio: '1:1' })
      return { ok: true, message: `${ep.name} terhubung · gambar uji berhasil dibuat` }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  },

  // Group name must match the StudioApi contract in shared/api.ts: `exporter`, not `export`.
  'exporter/start': (args) => startExport(args[0] as string, args[1] as ExportOptions),
  'exporter/defaultFolder': () => exportFolder(),
  'exporter/list': () => listExports(),
  'exporter/jobs': () => listExportJobs(),
  'exporter/delete': (args) => ({ deleted: deleteExportFile(String(args[0] ?? '')) }),
  // No native folder picker on the web; the default folder is used (changeable via settings).
  'exporter/pickFolder': () => exportFolder(),
  'exporter/reveal': (args) => ({ url: '/api/exports/' + basename(String(args[0] ?? '')) }),

  'app/version': () => appVersion(),

  'whisper/status': () => whisperStatus(),
  // The download runs in the background and reports through whisper events.
  'whisper/download': () => {
    void downloadModel().catch(() => {})
    return null
  },
  'whisper/cancel': () => {
    cancelDownload()
    return null
  },
  'whisper/remove': () => {
    removeModel()
    return null
  },
  'whisper/openFolder': () => ({ path: modelDir() })
}

export function registerRoutes(app: Express): void {
  for (const [name, fn] of Object.entries(routes)) {
    app.post(`/api/${name}`, async (req: Request, res: Response) => {
      try {
        const raw = (req.body as { args?: unknown } | undefined)?.args
        const args = Array.isArray(raw) ? raw : []
        const result = await fn(args)
        res.json({ ok: true, result: result ?? null })
      } catch (e) {
        // Only the message crosses the API boundary; keep it readable for the user.
        res.json({ ok: false, error: (e as Error)?.message ?? String(e) })
      }
    })
  }
}
