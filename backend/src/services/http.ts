/** Reads a FastAPI-style `{ detail }` error body (string, object or list) into one readable line. */
export async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const body = JSON.parse(text)
    const d = body?.detail ?? body?.error ?? body
    if (typeof d === 'string') return d
    if (Array.isArray(d)) return d.map((x) => x?.msg ?? JSON.stringify(x)).join('; ')
    if (d && typeof d === 'object') return d.message ?? d.msg ?? JSON.stringify(d)
  } catch {
    // not JSON
  }
  return text.slice(0, 300) || `HTTP ${res.status}`
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryable = false
  ) {
    super(message)
  }
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Dibatalkan'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('Dibatalkan'))
    })
  })

/** Browser-like UA: some AI providers sit behind Cloudflare bot detection and answer
 * 403 to default fetch user agents. */
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** A result download must never hang forever: bound each attempt so a stuck transfer fails cleanly. */
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000

export async function downloadTo(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType: string }> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await fetch(url, { signal: combined, headers: { 'User-Agent': BROWSER_UA } })
      if (!res.ok) throw new ApiError(`Gagal mengunduh hasil (HTTP ${res.status})`, res.status, res.status >= 500)
      return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' }
    } catch (e) {
      if (signal?.aborted) throw e
      lastErr = timeout.aborted ? new Error('Mengunduh hasil dari Ngik timeout (2 menit per percobaan).') : e
      await sleep(1500 * (attempt + 1), signal)
    }
  }
  throw lastErr
}
