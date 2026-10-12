import { cx } from './cx'

/** A small badge for a model family: its first letter on a tinted tile. */
export function ModelLogo({ family, size = 30, className }: { family?: string; size?: number; className?: string }) {
  return (
    <span
      className={cx('flex shrink-0 items-center justify-center overflow-hidden border border-line-2 bg-sand font-bold text-ink-2', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.26), fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {(family ?? '?').slice(0, 1)}
    </span>
  )
}
