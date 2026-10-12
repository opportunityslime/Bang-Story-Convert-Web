import { Mic, Server } from 'lucide-react'
import { cx } from './ui'

/**
 * Brand marks of the services the web app connects to. ElevenLabs comes from LobeHub Icons (MIT);
 * the rest use a generic mark. Marks belong to their owners.
 */
const FILES = import.meta.glob('../assets/providers/*.{svg,png}', { eager: true, import: 'default' }) as Record<string, string>
const file = (name: string): string => FILES[`../assets/providers/${name}`]

export type ProviderLogoId = 'elevenlabs' | 'piper' | 'flowspeech' | 'custom'

const LOOK: Record<ProviderLogoId, { bg: string; src?: string; inset: number; icon?: 'server' | 'mic' }> = {
  elevenlabs: { bg: '#000000', src: 'elevenlabs.svg', inset: 0.28 },
  piper: { bg: '#1F1D1A', inset: 0.24, icon: 'mic' },
  flowspeech: { bg: '#3B1D5E', inset: 0.24, icon: 'mic' },
  custom: { bg: '#134E4A', inset: 0.24, icon: 'server' }
}

export function ProviderLogo({ id, size = 40, className }: { id: ProviderLogoId; size?: number; className?: string }) {
  const look = LOOK[id]
  const inner = Math.round(size * (1 - look.inset * 2))
  const Icon = look.icon === 'mic' ? Mic : Server
  return (
    <span
      className={cx('flex shrink-0 items-center justify-center overflow-hidden border border-ink', className)}
      style={{ width: size, height: size, background: look.bg, borderRadius: Math.round(size * 0.26) }}
      aria-hidden="true"
    >
      {look.src ? (
        <img src={file(look.src)} alt="" draggable={false} style={{ width: inner, height: inner }} className="object-contain" />
      ) : (
        <Icon style={{ width: inner, height: inner }} strokeWidth={1.8} className={id === 'piper' || id === 'flowspeech' || id === 'custom' ? 'text-paper' : 'text-ink'} />
      )}
    </span>
  )
}
