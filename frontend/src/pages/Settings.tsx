import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  KeyRound,
  Mic,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import { LANGUAGES } from '@shared/models'
import type { ApiProvider, AppSettings, CustomEndpoint, EndpointDialect, EndpointKind, KeyStatus, KeyTestResult, TtsProvider } from '@shared/types'
import { Logo } from '../components/Logo'
import { ModelPicker } from '../components/ModelPicker'
import { ProviderLogo, type ProviderLogoId } from '../components/ProviderLogo'
import { Select } from '../components/Select'
import { AboutSection } from './AboutSection'
import { WhisperSection } from './WhisperSection'
import { Badge, Button, Field, IconButton, Switch, confirmDialog, cx, inputCls } from '../components/ui'
import { errorText, relativeTime } from '../lib/format'
import { TTS_NAMES } from '../lib/keys'
import { useModels } from '../lib/useModels'
import { useApp } from '../store/app'

type Tab = 'services' | 'general' | 'about'

interface ProviderOption<T extends string> {
  id: T
  name: string
  note: string
  logo: ProviderLogoId
  status?: KeyStatus
}

function StatusBadge({ status }: { status?: KeyStatus }) {
  if (!status?.configured) return <Badge tone="draft">Belum diatur</Badge>
  if (status.lastOk === false) return <Badge tone="bad">Gagal terhubung</Badge>
  if (status.lastOk)
    return (
      <Badge tone="ok">
        <Check className="size-3" strokeWidth={3} />
        Terhubung
      </Badge>
    )
  return <Badge tone="info">Tersimpan</Badge>
}

/** One dropdown to choose which provider a section uses; only that provider's settings are shown below it. */
function ProviderSelect<T extends string>({ value, options, onChange }: { value: T; options: ProviderOption<T>[]; onChange: (id: T) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const cur = options.find((o) => o.id === value) ?? options[0]
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx(
          'flex w-full items-center gap-3 rounded-2xl border-[1.5px] border-ink bg-surface px-4 py-3 text-left transition-shadow',
          open ? 'shadow-none' : 'shadow-ink hover:shadow-ink-md'
        )}
      >
        <ProviderLogo id={cur.logo} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-bold">{cur.name}</span>
          <span className="truncate text-[13px] text-ink-2">{cur.note}</span>
        </span>
        <StatusBadge status={cur.status} />
        <ChevronDown className={cx('size-5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div role="listbox" className="absolute inset-x-0 top-full z-40 mt-1.5 flex flex-col gap-0.5 rounded-2xl border-[1.5px] border-ink bg-surface p-1.5 shadow-ink-lg">
          {options.map((o) => {
            const on = o.id === value
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => {
                  setOpen(false)
                  if (!on) onChange(o.id)
                }}
                className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left', on ? 'bg-accent-soft' : 'hover:bg-sand')}
              >
                <ProviderLogo id={o.logo} size={36} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[15px] font-semibold">{o.name}</span>
                  <span className="truncate text-[13px] text-ink-2">{o.note}</span>
                </span>
                <StatusBadge status={o.status} />
                <span className="flex size-5 shrink-0 items-center justify-center">{on && <Check className="size-4 text-accent" strokeWidth={2.6} />}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** API key field with save, test and delete. Keys are stored encrypted on the server and never logged. */
function KeyForm({
  provider,
  name,
  status,
  label = 'API key',
  placeholder = 'Tempel API key',
  hint,
  help,
  link,
  linkLabel,
  onChanged,
  onSaved
}: {
  provider: ApiProvider
  name: string
  status?: KeyStatus
  label?: string
  placeholder?: string
  hint?: ReactNode
  help: string
  link: string | null
  linkLabel: string
  onChanged: () => void
  onSaved?: (r: KeyTestResult) => void
}) {
  const { toast } = useApp()
  const configured = !!status?.configured
  const preview = status?.preview ?? null
  const [editing, setEditing] = useState(!preview)
  const [key, setKey] = useState('')
  const [revealed, setRevealed] = useState<string | null>(null)
  const [showTyped, setShowTyped] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)

  // A newly saved or removed key puts the field back in its resting state.
  useEffect(() => {
    setEditing(!preview)
    setKey('')
    setRevealed(null)
  }, [preview])

  // The stored key is shown masked.
  const showStored = !editing && !!preview
  const canSave = !showStored && !!key.trim()
  // A pasted key only counts once it is saved; Enter saves it too.
  const unsaved = !showStored && !!key.trim() && busy !== 'save'
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || !canSave || busy) return
    e.preventDefault()
    void save()
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    try {
      const r = await window.api.settings.setKey(provider, key)
      toast(r.ok ? 'success' : 'error', `${name}: ${r.message}`)
      setKey('')
      setEditing(false)
      onChanged()
      onSaved?.(r)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const toggleEye = async (): Promise<void> => {
    if (!showStored) {
      setShowTyped(!showTyped)
      return
    }
    setRevealed(revealed ? null : await window.api.settings.revealKey(provider))
  }
  const visible = showStored ? !!revealed : showTyped

  const test = async (): Promise<void> => {
    setBusy('test')
    try {
      const r = await window.api.settings.testKey(provider)
      toast(r.ok ? 'success' : 'error', `${name}: ${r.message}`)
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const clear = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `Hapus kunci ${name}?`,
      body: 'Data ini akan dihapus dari server. Kamu bisa menambahkannya lagi kapan saja.',
      confirm: 'Hapus',
      danger: true
    })
    if (!ok) return
    await window.api.settings.clearKey(provider)
    onChanged()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <Field label={label} className="flex-1">
          <div className="relative">
            {showStored ? (
              <input
                readOnly
                value={revealed ?? preview ?? ''}
                aria-label={`${label} tersimpan`}
                className={cx(inputCls, 'h-11 cursor-default bg-paper pr-11 font-mono text-sm')}
              />
            ) : (
              <input
                type={showTyped ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                autoFocus={!!preview}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={onEnter}
                placeholder={placeholder}
                className={cx(inputCls, 'h-11 pr-11')}
              />
            )}
            {(showStored || key.length > 0) && (
              <button
                type="button"
                aria-label={visible ? 'Sembunyikan kunci' : 'Tampilkan kunci'}
                title={visible ? 'Sembunyikan kunci' : 'Tampilkan kunci'}
                onClick={() => void toggleEye()}
                className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-sand hover:text-ink"
              >
                {visible ? <EyeOff className="size-[17px]" /> : <Eye className="size-[17px]" />}
              </button>
            )}
          </div>
        </Field>
        {showStored ? (
          <Button
            className="h-11"
            onClick={() => {
              setEditing(true)
              setRevealed(null)
            }}
          >
            Ganti
          </Button>
        ) : (
          <Button variant="accent" className="h-11" disabled={!canSave} loading={busy === 'save'} onClick={() => void save()}>
            Simpan dan tes
          </Button>
        )}
        {editing && !!preview && (
          <Button
            variant="ghost"
            className="h-11"
            onClick={() => {
              setEditing(false)
              setKey('')
            }}
          >
            Batal
          </Button>
        )}
        {configured && (
          <>
            <Button className="h-11" loading={busy === 'test'} onClick={() => void test()}>
              Tes
            </Button>
            <IconButton label={`Hapus ${name}`} size={44} className="text-bad-ink" onClick={() => void clear()}>
              <Trash2 className="size-[18px]" />
            </IconButton>
          </>
        )}
      </div>
      {unsaved && <p className="-mt-1 text-[13px] font-semibold text-accent-dark">Kunci belum tersimpan. Tekan Enter atau klik Simpan dan tes.</p>}
      {hint && <p className="-mt-1 text-[13px] text-ink-2">{hint}</p>}
      <div className="flex items-center gap-2 text-[13px] text-ink-2">
        <span className={cx('flex-1', configured && status?.lastOk === false && 'text-bad-ink')}>
          {configured && status?.lastMessage
            ? `${status.lastMessage}${status.checkedAt && !status.unreadable ? ` · dicek ${relativeTime(status.checkedAt)}` : ''}`
            : help}
        </span>
        {link && (
          <button
            type="button"
            onClick={() => void window.api.app.openExternal(link)}
            className="inline-flex shrink-0 items-center gap-1 font-semibold text-accent-dark hover:underline"
          >
            {linkLabel}
            <ExternalLink className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function Card({ children }: { children: ReactNode }) {
  return <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface px-5 py-[18px]">{children}</section>
}

function SectionTitle({ icon, title, sub }: { icon: ReactNode; title: string; sub: ReactNode }) {
  return (
    <div className="mt-5 flex items-start gap-3">
      <span className="mt-1 text-ink">{icon}</span>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[22px] font-bold leading-tight">{title}</h2>
        <p className="text-sm text-ink-2">{sub}</p>
      </div>
    </div>
  )
}

const ENDPOINT_META: Record<EndpointKind, { title: string; sub: string; contract: string }> = {
  llm: {
    title: 'Penyusun cerita (LLM)',
    sub: 'Menyusun klip, naskah, dan pemeran untuk setiap proyek.',
    contract: 'OpenAI-compatible — POST {base URL}/chat/completions dengan {model, messages, response_format: {type: "json_object"}}.'
  },
  image: {
    title: 'Gambar',
    sub: 'Membuat gambar klip dan lembar karakter.',
    contract:
      'Dialek terdeteksi otomatis — OpenAI (POST {base URL}/images/generations → b64_json/url) atau Gemini-style (model …-image-portrait/landscape/square; suffix rasio otomatis ikut rasio proyek).'
  },
  video: {
    title: 'Video',
    sub: 'Menganimasikan gambar klip menjadi video AI.',
    contract:
      'Dialek terdeteksi otomatis — Kontrak Bang Story (POST {base URL}/generate → {videoUrl}/{taskId}, GET /status) atau Gemini-style (streaming, model abra_*/veo_3_1_*).'
  }
}

const DIALECT_LABEL: Record<EndpointDialect, string> = {
  auto: 'Otomatis',
  openai: 'OpenAI',
  bangstory: 'Bang Story',
  gemini: 'Gemini-style'
}
const DIALECT_OPTIONS: Record<'image' | 'video', { value: string; label: string }[]> = {
  image: [
    { value: 'auto', label: 'Otomatis (disarankan)' },
    { value: 'openai', label: 'OpenAI — /images/generations' },
    { value: 'gemini', label: 'Gemini-style — <server-gemini-anda>' }
  ],
  video: [
    { value: 'auto', label: 'Otomatis (disarankan)' },
    { value: 'bangstory', label: 'Bang Story — /generate + /status' },
    { value: 'gemini', label: 'Gemini-style — <server-gemini-anda>' }
  ]
}
const DIALECT_HINT: Record<EndpointDialect, string> = {
  auto: 'Aplikasi mengenali sendiri gaya API tiap web dari daftar modelnya.',
  openai: 'Gaya OpenAI standar.',
  bangstory: 'Kontrak Bang Story (POST /generate, GET /status).',
  gemini: 'Gaya Gemini: gambar via :generateContent, video via streaming. Suffix rasio di nama model (-portrait/-landscape/-square) otomatis disesuaikan dengan rasio proyek.'
}

/** Add/edit form for one endpoint. Empty key on edit keeps the stored key. */
function EndpointForm({
  kind,
  initial,
  onDone,
  onCancel
}: {
  kind: EndpointKind
  initial?: CustomEndpoint
  onDone: () => void
  onCancel: () => void
}) {
  const { toast } = useApp()
  const [name, setName] = useState(initial?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [dialect, setDialect] = useState<EndpointDialect>(initial?.dialect ?? 'auto')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<string[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)

  const save = async (): Promise<void> => {
    if (!name.trim() || !baseUrl.trim()) {
      toast('error', 'Nama dan base URL wajib diisi.')
      return
    }
    setBusy(true)
    try {
      if (initial) {
        const patch: { name?: string; baseUrl?: string; model?: string; dialect?: EndpointDialect; apiKey?: string | null } = {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          dialect
        }
        if (apiKey.trim()) patch.apiKey = apiKey.trim()
        await window.api.endpoints.update(initial.id, patch)
        toast('success', `Endpoint ${name.trim()} disimpan`)
      } else {
        await window.api.endpoints.create({
          kind,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          dialect,
          apiKey: apiKey.trim() || undefined
        })
        toast('success', `Endpoint ${name.trim()} ditambahkan`)
      }
      onDone()
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const loadModels = async (): Promise<void> => {
    if (!baseUrl.trim()) {
      toast('error', 'Isi base URL dulu.')
      return
    }
    setLoadingModels(true)
    try {
      const list = await window.api.endpoints.probeModels({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined })
      setModels(list.models.map((m) => m.id))
      if (list.models.length) {
        if (!model.trim() || !list.models.some((m) => m.id === model.trim())) setModel(list.models[0].id)
        toast('success', `${list.models.length} model ditemukan`)
      } else {
        toast('info', 'Endpoint terhubung, tapi tidak mengembalikan daftar model.')
      }
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setLoadingModels(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-line-2 bg-paper p-5">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Nama">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="cth: API LLM" className={cx(inputCls, 'h-11')} />
        </Field>
        <Field label="Base URL">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.contoh.com/v1"
            spellCheck={false}
            className={cx(inputCls, 'h-11 font-mono text-sm')}
          />
        </Field>
      </div>
      {kind !== 'llm' && (
        <Field label="Dialek API">
          <Select
            label="Dialek API"
            value={dialect}
            options={DIALECT_OPTIONS[kind]}
            onChange={(v) => setDialect(v as EndpointDialect)}
          />
          <p className="mt-1 text-xs text-ink-3">
            {DIALECT_HINT[dialect]}
            {initial?.detectedDialect && initial.dialect === 'auto'
              ? ` Terdeteksi saat ini: ${DIALECT_LABEL[initial.detectedDialect]}.`
              : ''}
          </p>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={kind === 'llm' ? 'Model' : 'Model (bebas)'}>
          {models && models.length > 0 ? (
            <Select
              label="Model"
              value={models.includes(model) ? model : models[0]}
              options={models.map((m) => ({ value: m, label: m }))}
              onChange={setModel}
            />
          ) : (
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={kind === 'llm' ? 'cth: gemini/gemini-3.8-flash' : 'cth: nano-banana-2'}
              spellCheck={false}
              className={cx(inputCls, 'h-11 font-mono text-sm')}
            />
          )}
        </Field>
        <Field label="API key (opsional untuk server lokal)">
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={initial ? (initial.hasKey ? 'Kosongkan untuk tidak mengubah' : 'Tempel API key') : 'Tempel API key'}
              autoComplete="off"
              spellCheck={false}
              className={cx(inputCls, 'h-11 pr-11')}
            />
            <button
              type="button"
              aria-label={showKey ? 'Sembunyikan kunci' : 'Tampilkan kunci'}
              onClick={() => setShowKey(!showKey)}
              className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-sand hover:text-ink"
            >
              {showKey ? <EyeOff className="size-[17px]" /> : <Eye className="size-[17px]" />}
            </button>
          </div>
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={() => void save()} loading={busy} variant="primary">
          {initial ? 'Simpan' : 'Tambah endpoint'}
        </Button>
        <Button onClick={onCancel}>Batal</Button>
        <div className="flex-1" />
        {kind === 'llm' && (
          <Button onClick={() => void loadModels()} loading={loadingModels}>
            Muat daftar model
          </Button>
        )}
      </div>
    </div>
  )
}

function EndpointCard({
  endpoint,
  onEdit,
  onDeleted
}: {
  endpoint: CustomEndpoint
  onEdit: () => void
  onDeleted: () => void
}) {
  const { toast } = useApp()
  const [testing, setTesting] = useState(false)

  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      const r = await window.api.endpoints.test(endpoint.id)
      toast(r.ok ? 'success' : 'error', r.message)
    } catch (e) {
      toast('error', errorText(e))
    } finally {
      setTesting(false)
    }
  }

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: `Hapus endpoint ${endpoint.name}?`,
      body: 'Endpoint ini tidak bisa dipakai lagi oleh proyek. Kamu bisa menambahkannya lagi kapan saja.',
      confirm: 'Hapus',
      danger: true
    })
    if (!ok) return
    await window.api.endpoints.delete(endpoint.id)
    toast('success', `Endpoint ${endpoint.name} dihapus`)
    onDeleted()
  }

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate text-[15px] font-bold">{endpoint.name}</span>
          {endpoint.hasKey ? <Badge tone="ok">Ada kunci</Badge> : <Badge tone="draft">Tanpa kunci</Badge>}
        </span>
        <span className="truncate font-mono text-[12.5px] text-muted">{endpoint.baseUrl}</span>
        {!!endpoint.model && <span className="truncate font-mono text-[12.5px] text-ink-2">{endpoint.model}</span>}
      </div>
      <Button size="sm" onClick={() => void test()} loading={testing}>
        Tes
      </Button>
      <IconButton label={`Ubah ${endpoint.name}`} onClick={onEdit}>
        <Pencil className="size-[16px]" />
      </IconButton>
      <IconButton label={`Hapus ${endpoint.name}`} onClick={() => void remove()} className="text-bad-ink hover:border-bad-ink">
        <Trash2 className="size-[16px]" />
      </IconButton>
    </div>
  )
}

/** User-managed AI endpoints: LLM, image and video. Replaces all hardcoded providers. */
function EndpointSection({
  settings,
  onSettings,
  onChanged
}: {
  settings: AppSettings
  onSettings: (s: AppSettings) => void
  onChanged: () => void
}) {
  const [endpoints, setEndpoints] = useState<CustomEndpoint[]>([])
  const [adding, setAdding] = useState<EndpointKind | null>(null)
  const [editing, setEditing] = useState<CustomEndpoint | null>(null)

  const reload = (): void => {
    void window.api.endpoints.list().then(setEndpoints)
  }
  useEffect(reload, [])

  const ofKind = (kind: EndpointKind): CustomEndpoint[] => endpoints.filter((e) => e.kind === kind)

  const onDeleted = async (endpoint: CustomEndpoint): Promise<void> => {
    // A deleted default LLM endpoint falls back to the first one; clear the dangling id.
    if (endpoint.kind === 'llm' && settings.defaultLlmEndpointId === endpoint.id) {
      onSettings(await window.api.settings.set({ defaultLlmEndpointId: null }))
    }
    reload()
    onChanged()
  }

  return (
    <>
      <SectionTitle
        icon={<Cpu className="size-5" />}
        title="Endpoint AI"
        sub="Layanan AI milikmu sendiri: tambah, ubah, dan hapus endpoint sesukamu. Kunci disimpan terenkripsi di server."
      />
      {(['llm', 'image', 'video'] as EndpointKind[]).map((kind) => {
        const meta = ENDPOINT_META[kind]
        const list = ofKind(kind)
        return (
          <div key={kind} className="flex flex-col gap-2.5">
            <div>
              <h3 className="text-[16px] font-bold">{meta.title}</h3>
              <p className="text-[13px] text-ink-2">{meta.sub}</p>
              <p className="mt-1 font-mono text-[11.5px] leading-relaxed text-muted">{meta.contract}</p>
            </div>
            {kind === 'llm' && list.length > 0 && (
              <Field label="Endpoint default untuk menyusun cerita">
                <Select
                  label="Endpoint LLM default"
                  value={list.some((e) => e.id === settings.defaultLlmEndpointId) ? (settings.defaultLlmEndpointId as string) : list[0].id}
                  options={list.map((e) => ({ value: e.id, label: e.name, note: e.model || e.baseUrl }))}
                  onChange={async (id) => onSettings(await window.api.settings.set({ defaultLlmEndpointId: id }))}
                />
              </Field>
            )}
            <div className="flex flex-col gap-2">
              {list.map((e) =>
                editing?.id === e.id ? (
                  <EndpointForm
                    key={e.id}
                    kind={kind}
                    initial={e}
                    onDone={() => {
                      setEditing(null)
                      reload()
                      onChanged()
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <EndpointCard key={e.id} endpoint={e} onEdit={() => setEditing(e)} onDeleted={() => void onDeleted(e)} />
                )
              )}
            </div>
            {adding === kind ? (
              <EndpointForm
                kind={kind}
                onDone={() => {
                  setAdding(null)
                  reload()
                  onChanged()
                }}
                onCancel={() => setAdding(null)}
              />
            ) : (
              !editing && (
                <Button icon={<Plus className="size-[16px]" />} onClick={() => setAdding(kind)} className="self-start">
                  Tambah endpoint {meta.title.toLowerCase()}
                </Button>
              )
            )}
          </div>
        )
      })}
    </>
  )
}

/** Keyless guest FlowSpeech: shows a live quota check instead of a key form. */
function FlowspeechCard() {
  const { toast } = useApp()
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<KeyTestResult | null>(null)
  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setResult(await window.api.settings.flowspeechStatus())
    } catch (e) {
      const message = errorText(e)
      setResult({ ok: false, message })
      toast('error', message)
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="flex items-center gap-3">
      <ProviderLogo id="flowspeech" />
      <div className="flex flex-1 flex-col">
        <span className="text-base font-bold">FlowSpeech (gratis)</span>
        <span className="text-[13px] text-ink-2">Jalur tamu langsung ke flowspeech.io. Tidak perlu kunci, kuota 2000 per bulan.</span>
        {result && <span className="mt-1 text-[13px] text-ink-2">{result.message}</span>}
      </div>
      {result?.ok ? (
        <Badge tone="ok">
          <Check className="size-3" strokeWidth={3} />
          Siap dipakai
        </Badge>
      ) : (
        <Button onClick={() => void check()} loading={checking}>
          {result ? 'Cek ulang' : 'Cek kuota'}
        </Button>
      )}
    </div>
  )
}

function TtsSection({ settings, statusOf, onChanged, onSettings }: { settings: AppSettings; statusOf: (p: ApiProvider) => KeyStatus | undefined; onChanged: () => void; onSettings: (s: AppSettings) => void }) {
  const provider = settings.defaultTtsProvider
  const status = provider === 'piper' || provider === 'flowspeech' ? undefined : statusOf(provider as ApiProvider)
  const ready = provider === 'piper' || provider === 'flowspeech' || (!!status?.configured && status.lastOk !== false)
  const models = useModels('elevenlabs', provider === 'elevenlabs' && ready)
  const options: ProviderOption<TtsProvider>[] = [
    {
      id: 'piper',
      name: TTS_NAMES.piper,
      note: 'Berjalan di server, gratis, tanpa kunci API.',
      logo: 'piper'
    },
    {
      id: 'flowspeech',
      name: TTS_NAMES.flowspeech,
      note: 'FlowSpeech jalur tamu — suara natural, gratis tanpa kunci, kuota bulanan terbatas.',
      logo: 'flowspeech'
    },
    {
      id: 'elevenlabs',
      name: TTS_NAMES.elevenlabs,
      note: 'Suara sangat natural dengan waktu kata yang presisi untuk caption karaoke.',
      logo: 'elevenlabs',
      status: statusOf('elevenlabs')
    }
  ]
  const keyMeta: Record<Exclude<TtsProvider, 'piper' | 'flowspeech'>, { help: string; link: string | null; linkLabel: string }> = {
    elevenlabs: {
      help: 'Kunci API dari akun ElevenLabs.',
      link: 'https://elevenlabs.io/app/settings/api-keys',
      linkLabel: 'Buat kunci di ElevenLabs'
    }
  }
  return (
    <>
      <SectionTitle
        icon={<Mic className="size-5" />}
        title="Suara narator (TTS)"
        sub="Penyedia suara bawaan untuk proyek baru. Setiap proyek tetap bisa memilih sendiri di langkah Ide cerita."
      />
      <ProviderSelect value={provider} options={options} onChange={async (id) => onSettings(await window.api.settings.set({ defaultTtsProvider: id }))} />
      <Card key={provider}>
        {provider === 'piper' ? (
          <div className="flex items-center gap-3">
            <ProviderLogo id="piper" />
            <div className="flex flex-1 flex-col">
              <span className="text-base font-bold">Piper</span>
              <span className="text-[13px] text-ink-2">Text-to-speech lokal di server. Tidak perlu kunci, tidak ada biaya.</span>
            </div>
            <Badge tone="ok">
              <Check className="size-3" strokeWidth={3} />
              Siap dipakai
            </Badge>
          </div>
        ) : provider === 'flowspeech' ? (
          <FlowspeechCard />
        ) : (
          <>
            <KeyForm
              provider={provider}
              name={TTS_NAMES[provider]}
              status={statusOf(provider)}
              help={keyMeta[provider].help}
              link={keyMeta[provider].link}
              linkLabel={keyMeta[provider].linkLabel}
              onChanged={onChanged}
              onSaved={(r) => r.ok && void models.refresh()}
            />
            {provider === 'elevenlabs' && ready && (
              <div className="flex flex-col gap-1.5 border-t border-dashed border-line pt-4">
                <span className="text-sm font-semibold">Model suara</span>
                <ModelPicker
                  value={settings.elevenModel}
                  models={models.models}
                  loading={models.loading}
                  error={models.error}
                  fetchedAt={models.fetchedAt}
                  onChange={async (id) => onSettings(await window.api.settings.set({ elevenModel: id }))}
                  onRefresh={() => void models.refresh()}
                />
              </div>
            )}
          </>
        )}
      </Card>
    </>
  )
}


export function Settings() {
  const { go, route } = useApp()
  const back = route.name === 'settings' && route.back ? route.back : ({ name: 'home' } as const)
  const [tab, setTab] = useState<Tab>('services')
  const [keys, setKeys] = useState<KeyStatus[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [folder, setFolder] = useState('')

  const reload = (): void => {
    void window.api.settings.keys().then(setKeys)
    void window.api.settings.get().then(setSettings)
  }
  useEffect(() => {
    reload()
    void window.api.exporter.defaultFolder().then(setFolder)
  }, [])

  const statusOf = (p: ApiProvider): KeyStatus | undefined => keys.find((k) => k.provider === p)

  const NAV: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: 'services', label: 'Layanan AI dan kunci', icon: <KeyRound className="size-[18px]" /> },
    { id: 'general', label: 'Umum', icon: <SlidersHorizontal className="size-[18px]" /> },
    { id: 'about', label: 'Tentang aplikasi', icon: <Info className="size-[18px]" /> }
  ]

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[68px] shrink-0 items-center gap-3.5 border-b border-line bg-surface px-8">
        <button type="button" onClick={() => go({ name: 'home' })}>
          <Logo />
        </button>
        <span className="text-xl text-line-3">/</span>
        <span className="font-semibold">Pengaturan</span>
        <div className="flex-1" />
        <Button icon={<ArrowLeft className="size-[18px]" />} onClick={() => go(back)}>
          {back.name === 'project' ? 'Kembali ke proyek' : 'Kembali ke beranda'}
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
        <nav aria-label="Bagian pengaturan" className="flex flex-col gap-1 border-r border-line pl-6 pr-4 pt-7">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              aria-current={tab === n.id ? 'page' : undefined}
              onClick={() => setTab(n.id)}
              className={cx(
                'flex h-11 items-center gap-3 rounded-xl px-3.5 text-left text-[15px]',
                tab === n.id ? 'bg-ink font-semibold text-paper' : 'font-medium text-ink hover:bg-sand'
              )}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
        </nav>
        <main className="scroll-thin overflow-y-auto">
          <div className="flex max-w-[900px] flex-col gap-3.5 px-14 pb-24 pt-8">
            {tab === 'services' && settings && (
              <>
                <div>
                  <h1 className="font-display text-[34px] font-bold tracking-[-0.015em]">Layanan AI dan kunci</h1>
                  <p className="mt-2 max-w-[700px] text-[15px] text-ink-2">
                    Bang Story memakai akun layanan milikmu sendiri. Kunci disimpan terenkripsi di server dan hanya dikirim langsung ke
                    layanan yang bersangkutan.
                  </p>
                </div>
                <EndpointSection settings={settings} onSettings={setSettings} onChanged={reload} />
                <TtsSection settings={settings} statusOf={statusOf} onChanged={reload} onSettings={setSettings} />
                <WhisperSection settings={settings} onSettings={setSettings} />
              </>
            )}

            {tab === 'general' && settings && (
              <>
                <div>
                  <h1 className="font-display text-[34px] font-bold tracking-[-0.015em]">Umum</h1>
                  <p className="mt-2 text-[15px] text-ink-2">Pilihan bawaan untuk proyek baru.</p>
                </div>
                <section className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-6">
                  <Field label="Bahasa default naskah dan suara">
                    <Select
                      label="Bahasa default naskah dan suara"
                      value={settings.defaultLanguage}
                      onChange={async (v) => setSettings(await window.api.settings.set({ defaultLanguage: v }))}
                      options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
                      className="max-w-[320px]"
                    />
                  </Field>
                  <Field label="Folder ekspor">
                    <div className="flex gap-2">
                      <div className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl border border-line bg-sand px-3.5 font-mono text-[13px]">
                        <FolderOpen className="size-[17px] shrink-0 text-ink-2" />
                        <span className="truncate">{folder}</span>
                      </div>
                      <Button
                        className="h-11"
                        onClick={async () => {
                          const f = await window.api.exporter.pickFolder()
                          if (f) setFolder(f)
                        }}
                      >
                        Lihat folder
                      </Button>
                    </div>
                  </Field>
                </section>
                <section className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-6">
                  <div className="flex items-start gap-4">
                    <Switch
                      on={settings.autoRetry}
                      onChange={async (v) => setSettings(await window.api.settings.set({ autoRetry: v }))}
                      label="Generate ulang otomatis"
                    />
                    <div>
                      <div className="text-[15px] font-semibold text-ink">Generate ulang otomatis</div>
                      <p className="mt-1 text-[13px] leading-relaxed text-muted">
                        Kalau narasi, gambar, video, atau export gagal karena error sementara, dicoba lagi
                        otomatis (maksimal 5x, ada jeda antar percobaan). Error permanen — kunci salah,
                        kuota habis, konten ditolak — tidak ikut dicoba ulang.
                      </p>
                    </div>
                  </div>
                </section>
              </>
            )}

            {tab === 'about' && <AboutSection />}
          </div>
        </main>
      </div>
    </div>
  )
}
