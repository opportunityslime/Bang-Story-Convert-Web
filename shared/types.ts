export type ProjectStatus = 'draft' | 'script' | 'storyboard' | 'editing' | 'exported'
export type AspectRatio = '16:9' | '9:16'
export type TtsProvider = 'piper' | 'elevenlabs' | 'flowspeech'
export type ApiProvider = 'elevenlabs'
/** A user-managed AI endpoint: any OpenAI-compatible (LLM/image) or Bang Story video-contract service. */
export type EndpointKind = 'llm' | 'image' | 'video'
/**
 * How an endpoint speaks. 'auto' detects from the model list (cached); the rest pin a style.
 * Image: 'openai' (POST /images/generations), 'gemini' (Gemini-style :generateContent).
 * Video: 'bangstory' (POST /generate + GET /status), 'gemini' (streaming chat/completions).
 * LLM endpoints are always OpenAI-compatible; the field is ignored there.
 */
export type EndpointDialect = 'auto' | 'openai' | 'bangstory' | 'gemini'
export interface CustomEndpoint {
  id: string
  kind: EndpointKind
  name: string
  baseUrl: string
  model: string
  dialect: EndpointDialect
  /** The dialect 'auto' resolved to the last time it was checked; null when never checked. */
  detectedDialect: EndpointDialect | null
  hasKey: boolean
  createdAt: number
  updatedAt: number
}
export interface NewEndpointInput {
  kind: EndpointKind
  name: string
  baseUrl: string
  model: string
  dialect?: EndpointDialect
  apiKey?: string
}
/** Where a live model list comes from: an LLM provider, an image/video provider, or a TTS catalog. */
export type ModelSource = 'elevenlabs' | 'piper'
export type MotionType = 'camera' | 'video'
export type CameraPresetId = 'zoomin' | 'zoomout' | 'panleft' | 'panright' | 'kenburns' | 'shake' | 'static'
export type MotionStrength = 'halus' | 'sedang' | 'kuat'
export type TransitionId = 'cut' | 'fade' | 'slideleft' | 'zoomin'
export type CaptionStyleId = 'karaoke' | 'tebal' | 'minimal' | 'subtitle' | 'none'
export type CaptionPosition = 'atas' | 'tengah' | 'bawah'
export type CaptionSize = 'kecil' | 'sedang' | 'besar'
/** 1 idea, 2 script, 3 storyboard, 4 editor */
export type Step = 1 | 2 | 3 | 4

export interface EditorSettings {
  captionStyle: CaptionStyleId
  captionPosition: CaptionPosition
  captionSize: CaptionSize
  /** Caption size as a multiple of the style's size (0.5–1.8); overrides captionSize when set. */
  captionScale?: number
  /** Custom look on top of the chosen caption style; unset fields keep the style's own. */
  captionFont?: string
  captionColor?: string
  captionHighlight?: string
  /** Box behind the caption: a color and opacity, or null for no box. */
  captionBg?: { color: string; opacity: number } | null
  musicAssetId: string | null
  musicVolumeDb: number
  duckMusic: boolean
  /** Logos, watermarks and text placed over the video. */
  overlays: Overlay[]
  /** Volume change for all narration, in dB. */
  voiceVolumeDb?: number
  /** Background music on the timeline: from `musicStartMs` to `musicEndMs` (null: the end), `musicInMs` into the song. */
  musicStartMs?: number
  musicEndMs?: number | null
  musicInMs?: number
  /** Last prompt written for making background music in an outside AI (Suno, Udio, …). */
  musicPrompt?: MusicPrompt | null
}

export interface MusicPrompt {
  /** Suno "Style of Music": comma-separated English tags. */
  style: string
  /** Suno "Exclude styles". */
  exclude: string
  title: string
  /** One paragraph for other music AIs (Udio, ElevenLabs Music, Stable Audio, …). */
  description: string
  /** Why this music fits, in Indonesian, for the user. */
  reason: string
  /** Video length when it was written, in seconds. */
  durationSec: number
}

/**
 * Where an overlay sits: `anchor` is a numpad position on the overlay itself (7 top-left, 5 center,
 * 3 bottom-right, the same numbering as ASS n), and `x`/`y` place that point as a fraction of the frame.
 */
interface OverlayBase {
  id: string
  anchor: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  x: number
  y: number
  /** Seconds on the final timeline; `end` null means until the video ends. */
  start: number
  end: number | null
}

export interface ImageOverlay extends OverlayBase {
  kind: 'image'
  assetId: string
  /** Width as a fraction of the frame width. */
  width: number
  opacity: number
}

export type TextOverlayStyle = 'plain' | 'outline' | 'box'

export interface TextOverlay extends OverlayBase {
  kind: 'text'
  text: string
  /** Font size as a fraction of the frame height. */
  size: number
  color: string
  style: TextOverlayStyle
  bold: boolean
}

export type Overlay = ImageOverlay | TextOverlay

export interface Project {
  id: string
  title: string
  synopsis: string
  durationSec: number
  language: string
  aspectRatio: AspectRatio
  styleId: string
  ttsProvider: TtsProvider
  ttsVoice: string
  /** Custom endpoint ids; null falls back to the app default. */
  imageEndpointId: string | null
  videoEndpointId: string | null
  /** One of the video model's resolutions, e.g. "720p"; null or unsupported uses the default (1080p when offered). */
  videoResolution: string | null
  status: ProjectStatus
  step: Step
  coverAssetId: string | null
  editor: EditorSettings
  createdAt: number
  updatedAt: number
}

export interface Character {
  id: string
  projectId: string
  name: string
  description: string
  sheetAssetId: string | null
  sort: number
}

export interface Clip {
  id: string
  projectId: string
  sort: number
  title: string
  /** What happens in the scene, in the script's language (the Naskah step). */
  story: string
  visualPrompt: string
  /** The story text the current visual plan was written from; null before any plan. */
  visualSource: string | null
  narration: string
  durationMs: number
  characterIds: string[]
  motionType: MotionType
  cameraPreset: CameraPresetId
  motionStrength: MotionStrength
  videoPrompt: string
  transition: TransitionId
  /** Camera move drawn over the AI video ('static' keeps the video as it is). */
  videoCamera: CameraPresetId
  videoStrength: MotionStrength
  /** Length of the transition into the next clip; null uses the default (0.4 s). */
  transitionMs: number | null
  /** Volume change for this clip's narration, in dB. */
  voiceGainDb: number
  /** Where the clip's video starts, in ms into the video file (trimmed from the left on the timeline). */
  mediaInMs: number
  /** The clip's voice trimmed to `voiceInMs`–`voiceOutMs` of its audio (null: to the end), placed `voiceStartMs` into the clip. */
  voiceInMs: number
  voiceOutMs: number | null
  voiceStartMs: number
  imageAssetId: string | null
  videoAssetId: string | null
  audioAssetId: string | null
}

export type AssetKind = 'image' | 'video' | 'audio' | 'music' | 'overlay' | 'export'

export interface WordTiming {
  text: string
  start: number
  end: number
}

export interface AssetMeta {
  words?: WordTiming[]
  estimatedTimings?: boolean
  voice?: string
  [key: string]: unknown
}

export interface Asset {
  id: string
  projectId: string
  clipId: string | null
  characterId: string | null
  kind: AssetKind
  provider: string | null
  model: string | null
  prompt: string | null
  remoteId: string | null
  remoteUrl: string | null
  localPath: string
  url: string
  durationMs: number | null
  width: number | null
  height: number | null
  meta: AssetMeta
  createdAt: number
}

/** "narration" voices several scenes in one take and cuts it per scene. */
export type JobKind = 'story' | 'image' | 'sheet' | 'video' | 'tts' | 'narration' | 'align' | 'export'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export interface Job {
  id: string
  projectId: string
  clipId: string | null
  characterId: string | null
  kind: JobKind
  provider: string
  status: JobStatus
  progress: number
  message: string | null
  error: string | null
  resultAssetId: string | null
  createdAt: number
  updatedAt: number
}

export interface ProjectBundle {
  project: Project
  characters: Character[]
  clips: Clip[]
  assets: Asset[]
  jobs: Job[]
}

export interface ProjectSummary {
  id: string
  title: string
  styleId: string
  status: ProjectStatus
  step: Step
  clipCount: number
  totalMs: number
  coverUrl: string | null
  updatedAt: number
}

/** What the renderer sends on save. Asset links are owned by the main process and never overwritten by a save. */
export interface ProjectSnapshot {
  project: Omit<Project, 'createdAt' | 'updatedAt' | 'coverAssetId'>
  characters: Omit<Character, 'sheetAssetId'>[]
  clips: Omit<Clip, 'imageAssetId' | 'videoAssetId' | 'audioAssetId'>[]
}

export interface NewProjectInput {
  synopsis?: string
  durationSec?: number
  language?: string
  aspectRatio?: AspectRatio
  styleId?: string
  ttsProvider?: TtsProvider
  /** Apply a saved project's settings template on top of the other inputs. */
  templateId?: string
  /** Start the hands-off autopilot (script → export) right after creation. */
  autopilot?: boolean
}

export interface KeyStatus {
  provider: ApiProvider
  configured: boolean
  lastOk: boolean | null
  lastMessage: string | null
  checkedAt: number | null
  /** Masked key for display, e.g. "sk-or-v1…9f3c". Null when there is no readable key. */
  preview: string | null
  /** A key is stored but can no longer be decrypted and must be entered again. */
  unreadable: boolean
}

/** The project settings a template carries; everything the user can set per project. */
export interface TemplateSettings {
  durationSec: number
  language: string
  aspectRatio: AspectRatio
  styleId: string
  ttsProvider: TtsProvider
  ttsVoice: string
  imageEndpointId: string | null
  videoEndpointId: string | null
  videoResolution: string | null
}

/** Named, reusable snapshot of project settings. */
export interface ProjectTemplate {
  id: string
  name: string
  settings: TemplateSettings
  createdAt: number
  updatedAt: number
}

/** One stage of the hands-off pipeline (idea → finished video). */
export type AutopilotStage = 'script' | 'visuals' | 'narration' | 'images' | 'videos' | 'export'

/** Live state of a project's autopilot run; null when it never ran or already finished. */
export interface AutopilotStatus {
  projectId: string
  stage: AutopilotStage
  /** Job ids the current stage is waiting on (empty for script/visuals). */
  jobIds: string[]
  /** Set when the run stopped on an error; the user dismisses it. */
  error: string | null
  updatedAt: number
}

export interface KeyTestResult {
  ok: boolean
  message: string
}

export interface VoiceOption {
  id: string
  name: string
  description: string
  previewUrl?: string | null
}

export interface AppSettings {
  defaultTtsProvider: TtsProvider
  defaultLanguage: string
  exportFolder: string | null
  /** Custom LLM endpoint that writes stories and narration. */
  defaultLlmEndpointId: string | null
  elevenModel: string
  /** Endpoint gambar/video untuk proyek baru: pilihan terakhir di langkah Ide. */
  defaultImageEndpointId: string | null
  defaultVideoEndpointId: string | null
  /** Time captions against the real voice with Whisper after narration is made (when the model is present). */
  whisperAuto: boolean
  /** When on, jobs that fail with a transient error (narration, image, video, export) are retried automatically with backoff, up to 5 attempts. */
  autoRetry: boolean
}

/** The local Whisper model used to time caption words. */
export interface WhisperStatus {
  state: 'missing' | 'downloading' | 'verifying' | 'ready'
  received: number
  total: number
  error: string | null
}

export interface ModelOption {
  id: string
  name: string
  description?: string
  contextLength?: number | null
  /** USD per 1M input / output tokens, when the provider publishes it. */
  priceIn?: number | null
  priceOut?: number | null
  /** Short labels the picker can filter on, e.g. "JSON", "Gratis", "Gambar". */
  tags: string[]
  /** Model family, e.g. "Kling", for a brand mark next to the name. */
  family?: string
  /** Higgsfield credits (and dollars) for one request; undefined while unknown, null when it cannot be estimated. */
  credits?: number | null
  usd?: number | null
  /** What the credits pay for, e.g. "10 dtk". */
  creditUnit?: string
}

export interface ModelList {
  models: ModelOption[]
  fetchedAt: number
}

export interface ExportOptions {
  fileName: string
  resolution: 720 | 1080 | 2160
  fps: 30 | 60
  burnCaptions: boolean
  writeSrt: boolean
  normalizeAudio: boolean
  duckMusic: boolean
  folder: string
}

/** One file already written to the export folder, ready to download from the web. */
export interface ExportFile {
  name: string
  /** Relative URL the browser opens to download the file. */
  url: string
  sizeBytes: number
  updatedAt: number
}

/**
 * An export job known to the server: queued, running, done or failed. Backed by the jobs
 * table, so progress survives a page refresh — the Downloads list can show exports that
 * are still rendering even after the user navigates away or closes the tab.
 */
export interface ExportJobStatus {
  id: string
  projectId: string
  projectTitle: string
  /** Intended output file name (without extension), taken from the export options. */
  fileName: string
  status: JobStatus
  /** 0..1 */
  progress: number
  message: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface ClipPatchEvent {
  clipId: string
  patch: Partial<Clip>
}

export interface CharacterPatchEvent {
  characterId: string
  patch: Partial<Character>
}
