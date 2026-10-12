import { useEffect, useState, type ReactNode } from 'react'
import { Film, Image as ImageIcon, Move } from 'lucide-react'
import type { CustomEndpoint, Project } from '@shared/types'
import { Select } from '../../components/Select'

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line-2 bg-surface p-3">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
        {icon}
        {title}
      </span>
      {children}
    </div>
  )
}

function EndpointSelect({
  label,
  endpoints,
  value,
  onChange
}: {
  label: string
  endpoints: CustomEndpoint[]
  value: string | null
  onChange: (id: string) => void
}) {
  if (!endpoints.length) {
    return <p className="text-[12.5px] leading-snug text-muted">Belum ada endpoint — tambah dulu di Pengaturan.</p>
  }
  return (
    <Select
      label={label}
      value={value ?? endpoints[0].id}
      options={endpoints.map((e) => ({ value: e.id, label: e.name, note: e.model || e.baseUrl }))}
      onChange={onChange}
    />
  )
}

/** Which custom endpoints draw and animate this project's clips. */
export function ModelSection({
  project,
  clipCount,
  onChange
}: {
  project: Project
  clipCount: number
  perClip: number
  onChange: (patch: { imageEndpointId?: string; videoEndpointId?: string; videoResolution?: string | null }) => void
}) {
  const [images, setImages] = useState<CustomEndpoint[]>([])
  const [videos, setVideos] = useState<CustomEndpoint[]>([])
  useEffect(() => {
    void window.api.endpoints.list('image').then(setImages)
    void window.api.endpoints.list('video').then(setVideos)
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold">Model AI</span>
        <span className="text-[13px] text-muted">Endpoint AI yang dipakai proyek ini</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Card icon={<ImageIcon className="size-4" />} title="Gambar klip">
          <EndpointSelect
            label="Endpoint gambar"
            endpoints={images}
            value={project.imageEndpointId}
            onChange={(id) => onChange({ imageEndpointId: id })}
          />
          {!!images.length && <p className="text-[12.5px] leading-snug text-ink-2">{clipCount} gambar klip</p>}
        </Card>
        <Card icon={<Film className="size-4" />} title="Video AI">
          <EndpointSelect
            label="Endpoint video"
            endpoints={videos}
            value={project.videoEndpointId}
            onChange={(id) => onChange({ videoEndpointId: id })}
          />
          <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted">
            <Move className="mt-px size-3.5 shrink-0" />
            Hanya untuk klip yang kamu jadikan Video AI. Gerak kamera tetap gratis.
          </p>
        </Card>
      </div>
    </div>
  )
}
