import { useEffect, useState } from 'react'
import { Bot, X } from 'lucide-react'
import type { AutopilotStage, AutopilotStatus } from '@shared/types'
import { cx } from '../../components/ui'
import { errorText } from '../../lib/format'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'

const STAGE_LABEL: Record<AutopilotStage, string> = {
  script: 'Menulis naskah',
  visuals: 'Menyusun storyboard',
  narration: 'Membuat suara narasi',
  images: 'Membuat gambar',
  videos: 'Membuat video',
  export: 'Mengekspor video'
}

/** Live autopilot state for this project, with a stop button. Null when idle. */
export function AutopilotChip() {
  const { project } = useProject()
  const { toast } = useApp()
  const [status, setStatus] = useState<AutopilotStatus | null>(null)
  const projectId = project?.id

  useEffect(() => {
    if (!projectId) return
    let alive = true
    window.api.autopilot
      .status(projectId)
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch(() => {})
    const off = window.api.on.autopilot((s) => {
      if (alive && (!s || s.projectId === projectId)) setStatus(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [projectId])

  if (!status) return null

  const stop = async (): Promise<void> => {
    if (!projectId) return
    try {
      await window.api.autopilot.stop(projectId)
      setStatus(null)
      toast('info', 'Autopilot dihentikan. Job yang sedang berjalan tetap lanjut.')
    } catch (e) {
      toast('error', errorText(e))
    }
  }

  if (status.error) {
    return (
      <div
        className="flex min-w-0 items-center gap-2 rounded-full border-[1.5px] border-ink bg-bad-soft py-1.5 pl-3.5 pr-2"
        title={status.error}
      >
        <span className="max-w-[300px] truncate text-[13px] font-semibold text-bad-ink">{status.error}</span>
        <button
          type="button"
          onClick={() => void stop()}
          className="shrink-0 rounded-full px-2 py-0.5 text-[13px] font-semibold text-bad-ink underline"
        >
          Tutup
        </button>
      </div>
    )
  }

  return (
    <div className={cx('flex items-center gap-2 rounded-full border-[1.5px] border-ink bg-accent py-1.5 pl-3.5 pr-2 text-white')}>
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
        <span className="relative inline-flex size-2.5 rounded-full bg-white" />
      </span>
      <Bot className="size-4" />
      <span className="whitespace-nowrap text-[13px] font-semibold">Otomatis: {STAGE_LABEL[status.stage]}</span>
      <button
        type="button"
        title="Hentikan autopilot"
        aria-label="Hentikan autopilot"
        onClick={() => void stop()}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/20 hover:text-white"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
