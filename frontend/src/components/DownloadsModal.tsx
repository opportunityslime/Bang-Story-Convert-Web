import { useEffect, useState, type ReactElement } from 'react'
import { AlertTriangle, Download, FileText, Film, RefreshCw, Trash2 } from 'lucide-react'
import type { ExportFile, ExportJobStatus } from '@shared/types'
import { Button, IconButton, Modal, Progress, Segmented, Spinner, confirmDialog, cx } from './ui'
import { errorText, fileSize, relativeTime } from '../lib/format'

/**
 * Downloads a finished export. The server answers /api/exports/<name> as an attachment, so opening
 * it in a new tab saves the file without navigating the app away.
 */
function download(file: ExportFile): void {
  window.open(file.url, '_blank', 'noopener')
}

function FileIcon({ name }: { name: string }): ReactElement {
  return name.toLowerCase().endsWith('.srt') ? (
    <FileText className="size-[18px] shrink-0 text-ink-2" />
  ) : (
    <Film className="size-[18px] shrink-0 text-accent-dark" />
  )
}

const isActive = (j: ExportJobStatus): boolean => j.status === 'queued' || j.status === 'running'

function ActiveJobRow({ job }: { job: ExportJobStatus }): ReactElement {
  const pct = Math.round(Math.min(1, Math.max(0, job.progress)) * 100)
  const label = job.status === 'queued' ? 'Menunggu giliran\u2026' : job.message || 'Merender video\u2026'
  return (
    <li className="rounded-xl border border-line bg-paper px-3.5 py-3">
      <div className="flex items-center gap-3">
        <Film className="size-[18px] shrink-0 text-accent-dark" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold">{job.projectTitle || job.fileName || 'Video'}</p>
          <p className="truncate text-xs text-ink-2">{label}</p>
        </div>
        <span className="shrink-0 font-mono text-[13px] font-semibold text-accent-dark">{pct}%</span>
      </div>
      <Progress value={job.progress} className="mt-2.5" />
    </li>
  )
}

function FailedJobRow({ job }: { job: ExportJobStatus }): ReactElement {
  return (
    <div className="rounded-xl border border-bad-ink/40 bg-bad-soft px-3.5 py-2.5">
      <p className="flex items-center gap-2 text-[13px] font-semibold">
        <AlertTriangle className="size-[15px] shrink-0 text-bad-ink" />
        {job.projectTitle || job.fileName || 'Video'}
      </p>
      <p className="mt-1 break-words font-mono text-xs text-bad-ink">{job.error || 'Terjadi kesalahan.'}</p>
      <p className="mt-0.5 text-xs text-ink-2">{relativeTime(job.updatedAt)}</p>
    </div>
  )
}

type Tab = 'hasil' | 'error'

/**
 * Export results and the export error log. Export job state lives in the server database, so an
 * accidental refresh or closed tab never loses the progress: reopening this list picks every
 * running export right back up (it re-polls every 2.5s while open). Failed exports live on the
 * "Log error" tab so they never clutter the finished files.
 */
export function DownloadsModal({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement {
  const [tab, setTab] = useState<Tab>('hasil')
  const [files, setFiles] = useState<ExportFile[] | null>(null)
  const [jobs, setJobs] = useState<ExportJobStatus[] | null>(null)
  const [folder, setFolder] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  /** Silent refresh for the poll loop — never flashes the spinner. */
  const refreshQuiet = (): void => {
    window.api.exporter.jobs().then(setJobs).catch(() => {})
    window.api.exporter.list().then(setFiles).catch(() => {})
  }

  const load = (): void => {
    setBusy(true)
    setError(null)
    Promise.all([window.api.exporter.list(), window.api.exporter.defaultFolder(), window.api.exporter.jobs()])
      .then(([list, dir, js]) => {
        setFiles(list)
        setFolder(dir)
        setJobs(js)
      })
      .catch((e) => {
        setFiles([])
        setJobs([])
        setError(errorText(e))
      })
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    if (!open) return
    setTab('hasil')
    load()
    const t = setInterval(refreshQuiet, 2500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const remove = async (f: ExportFile): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Hapus hasil ekspor?',
      body: `"${f.name}" akan dihapus permanen dari server dan tidak bisa dikembalikan.`,
      confirm: 'Hapus',
      danger: true,
    })
    if (!ok) return
    setDeleting(f.name)
    try {
      await window.api.exporter.deleteExport(f.name)
      setFiles((prev) => (prev ?? []).filter((x) => x.name !== f.name))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setDeleting(null)
    }
  }

  const active = (jobs ?? []).filter(isActive)
  const failed = (jobs ?? []).filter((j) => j.status === 'failed')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Hasil ekspor"
      subtitle={folder ? `Tersimpan di ${folder}` : 'Semua video yang sudah kamu ekspor'}
      width={620}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { id: 'hasil', label: 'Hasil' },
            { id: 'error', label: `Log error${failed.length > 0 ? ` (${failed.length})` : ''}` },
          ]}
        />
        <Button
          size="sm"
          icon={<RefreshCw className={cx('size-[15px]', busy && 'animate-[spin_0.8s_linear_infinite]')} />}
          onClick={load}
        >
          Muat ulang
        </Button>
      </div>

      {error && (
        <p className="rounded-xl border border-bad-ink/40 bg-bad-soft px-3.5 py-2.5 text-sm text-bad-ink">{error}</p>
      )}

      {files === null || jobs === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : tab === 'error' ? (
        failed.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line-2 px-5 py-8 text-center">
            <p className="font-semibold">Tidak ada error</p>
            <p className="mt-1 text-sm text-ink-2">Semua ekspor berjalan atau selesai dengan baik.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {failed.map((j) => (
              <FailedJobRow key={j.id} job={j} />
            ))}
          </div>
        )
      ) : active.length === 0 && files.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-2 px-5 py-8 text-center">
          <p className="font-semibold">Belum ada hasil ekspor</p>
          <p className="mt-1 text-sm text-ink-2">Buka sebuah proyek, lalu klik Ekspor untuk membuat video pertamamu.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {active.length > 0 && (
            <section>
              <p className="mb-2 text-sm font-semibold">Sedang diekspor \u2014 tetap jalan walau halaman di-refresh</p>
              <ul className="flex flex-col gap-2">
                {active.map((j) => (
                  <ActiveJobRow key={j.id} job={j} />
                ))}
              </ul>
            </section>
          )}

          {files.length > 0 && (
            <section>
              {active.length > 0 && <p className="mb-2 text-sm font-semibold">Sudah selesai</p>}
              <ul className="scroll-thin -mx-1 flex max-h-[38vh] flex-col gap-2 overflow-y-auto px-1">
                {files.map((f) => (
                  <li
                    key={f.name}
                    className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3.5 py-2.5"
                  >
                    <FileIcon name={f.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[13px] font-medium" title={f.name}>
                        {f.name}
                      </p>
                      <p className="text-xs text-ink-2">
                        {fileSize(f.sizeBytes)} \u00b7 {relativeTime(f.updatedAt)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Download className="size-[15px]" />}
                      onClick={() => download(f)}
                    >
                      Unduh
                    </Button>
                    <IconButton
                      label={`Hapus ${f.name} dari server`}
                      size={34}
                      className="hover:border-bad-ink/60 hover:text-bad-ink"
                      disabled={deleting === f.name}
                      onClick={() => remove(f)}
                    >
                      <Trash2 className="size-[15px]" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  )
}
