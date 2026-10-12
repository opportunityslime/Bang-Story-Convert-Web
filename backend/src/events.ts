import { emit } from './sse'

/**
 * Compatibility alias: several workers (narration, whisper, editing, exporter, generation, jobs)
 * were ported from the desktop app where the event bus lived in main/events.ts. The web backend
 * implements it in sse.ts; this module re-exports it under the original name.
 */
export { emit }
