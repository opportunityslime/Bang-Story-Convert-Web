import type {
  ApiProvider,
  AppSettings,
  Asset,
  AutopilotStatus,
  CharacterPatchEvent,
  ClipPatchEvent,
  CustomEndpoint,
  EndpointDialect,
  EndpointKind,
  NewEndpointInput,
  WhisperStatus,
  WordTiming,
  ExportOptions,
  ExportFile,
  ExportJobStatus,
  Job,
  KeyStatus,
  KeyTestResult,
  ModelList,
  ModelSource,
  MusicPrompt,
  NewProjectInput,
  ProjectBundle,
  ProjectSnapshot,
  ProjectSummary,
  ProjectTemplate,
  TtsProvider,
  VoiceOption
} from './types'

/** The typed surface the preload script exposes as `window.api`. */
export interface StudioApi {
  projects: {
    list(): Promise<ProjectSummary[]>
    create(input: NewProjectInput): Promise<ProjectBundle>
    get(id: string): Promise<ProjectBundle>
    save(snapshot: ProjectSnapshot): Promise<{ updatedAt: number }>
    remove(id: string): Promise<void>
    duplicate(id: string): Promise<ProjectSummary>
  }
  templates: {
    list(): Promise<ProjectTemplate[]>
    /** Snapshot a project's settings as a named template. */
    save(name: string, projectId: string): Promise<ProjectTemplate>
    delete(id: string): Promise<{ deleted: boolean }>
  }
  autopilot: {
    start(projectId: string): Promise<AutopilotStatus | null>
    stop(projectId: string): Promise<void>
    status(projectId: string): Promise<AutopilotStatus | null>
  }
  story: {
    /** Idea → scene-by-scene script (story and voice-over). */
    script(projectId: string): Promise<ProjectBundle>
    /** Script → one image plan per scene; "missing" skips scenes whose plan still matches their story. */
    visuals(projectId: string, mode: 'missing' | 'all'): Promise<ProjectBundle>
    /** A background-music prompt that fits the finished script, for use in Suno or another music AI. */
    musicPrompt(projectId: string): Promise<MusicPrompt>
  }
  generate: {
    clipImage(clipId: string): Promise<Job>
    clipVideo(clipId: string): Promise<Job>
    clipTts(clipId: string): Promise<Job>
    characterSheet(characterId: string): Promise<Job>
    missingImages(projectId: string): Promise<Job[]>
    /** An AI video for every clip that has an image but no video yet. */
    missingVideos(projectId: string): Promise<Job[]>
    missingTts(projectId: string): Promise<Job[]>
    /** Voices scenes in one continuous take and cuts it per scene: those without a voice, or all of them. */
    narration(projectId: string, mode: 'missing' | 'all'): Promise<Job>
    /** Re-times caption words of voiced scenes against the audio with the local Whisper model. */
    syncCaptions(projectId: string, mode?: 'stale' | 'all'): Promise<Job>
    cancel(jobId: string): Promise<void>
  }
  clips: {
    /** Splits a clip at `atMs` into two clips (picture, voice and narration divided at the nearest pause). */
    split(clipId: string, atMs: number): Promise<ProjectBundle>
    /** Takes the voice off a clip. */
    detachVoice(clipId: string): Promise<void>
  }
  assets: {
    setActive(clipId: string, assetId: string): Promise<void>
    /** Caption words of a voice clip, after the text was fixed by hand. */
    setWords(assetId: string, words: WordTiming[]): Promise<Asset>
    pickMusic(projectId: string): Promise<Asset | null>
    /** A logo or watermark image for an overlay. */
    pickImage(projectId: string): Promise<Asset | null>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
    keys(): Promise<KeyStatus[]>
    setKey(provider: ApiProvider, key: string): Promise<KeyTestResult>
    clearKey(provider: ApiProvider): Promise<void>
    /** The full stored key, only for the "show key" button. */
    revealKey(provider: ApiProvider): Promise<string | null>
    testKey(provider: ApiProvider): Promise<KeyTestResult>
    voices(provider: TtsProvider): Promise<VoiceOption[]>
    /** Quota/connection check for the keyless guest FlowSpeech provider. */
    flowspeechStatus(): Promise<KeyTestResult>
  }
  models: {
    /** Live model list from the provider. Served from cache unless `refresh` is set or the cache is stale. */
    list(source: ModelSource, refresh?: boolean): Promise<ModelList>
  }
  endpoints: {
    list(kind?: EndpointKind): Promise<CustomEndpoint[]>
    create(input: NewEndpointInput): Promise<CustomEndpoint>
    update(
      id: string,
      patch: { name?: string; baseUrl?: string; model?: string; dialect?: EndpointDialect; apiKey?: string | null }
    ): Promise<CustomEndpoint>
    delete(id: string): Promise<{ deleted: boolean }>
    /** The full stored key, only for the "show key" button. */
    revealKey(id: string): Promise<string | null>
    /** Live model list of one LLM endpoint. */
    models(id: string, refresh?: boolean): Promise<ModelList>
    /** Model list of an unsaved endpoint (base URL + key), for the form's "load models" button. */
    probeModels(input: { baseUrl: string; apiKey?: string }): Promise<ModelList>
    /** Connection check; for image endpoints it renders one tiny test image. */
    test(id: string): Promise<KeyTestResult>
  }
  exporter: {
    start(projectId: string, options: ExportOptions): Promise<Job>
    defaultFolder(): Promise<string>
    /** Every file already written to the export folder, newest first. */
    list(): Promise<ExportFile[]>
    /** Export jobs, newest first — including still-running ones, so progress survives a page refresh. */
    jobs(): Promise<ExportJobStatus[]>
    /** Delete a finished export file from the server. Returns whether a file was removed. */
    deleteExport(name: string): Promise<{ deleted: boolean }>
    pickFolder(): Promise<string | null>
    reveal(path: string): Promise<void>
  }
  app: {
    openExternal(url: string): Promise<void>
    copyText(text: string): Promise<void>
    version(): Promise<string>
  }
  whisper: {
    status(): Promise<WhisperStatus>
    download(): Promise<void>
    cancel(): Promise<void>
    remove(): Promise<void>
    openFolder(): Promise<void>
  }
  on: {
    whisper(cb: (status: WhisperStatus) => void): () => void
    job(cb: (job: Job) => void): () => void
    clip(cb: (e: ClipPatchEvent) => void): () => void
    character(cb: (e: CharacterPatchEvent) => void): () => void
    asset(cb: (asset: Asset) => void): () => void
    autopilot(cb: (s: AutopilotStatus | null) => void): () => void
  }
}

export const EVENTS = {
  job: 'event:job',
  clip: 'event:clip',
  character: 'event:character',
  asset: 'event:asset',
  whisper: 'event:whisper'
} as const
