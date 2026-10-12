/** Higgsfield image and video models live in ./higgsfield.ts, generated from the API docs. */

/**
 * Gemini 3.8 TTS Voice Library voices that ship with a sample in the app (assets/voices/<id>.mp3). Used
 * when the live voice list cannot be fetched; the tone comes from each sample's persona.
 */
export const GEMINI_LIBRARY_VOICES: { id: string; name: string; tone: string }[] = [
  { id: 'en-us-arlo', name: 'Arlo', tone: 'asisten pribadi' },
  { id: 'en-us-bodi', name: 'Bodi', tone: 'pengajar sastra' },
  { id: 'en-us-brio', name: 'Brio', tone: 'pembaca berita bisnis' },
  { id: 'en-us-cruz', name: 'Cruz', tone: 'penasihat keuangan' },
  { id: 'en-us-daro', name: 'Daro', tone: 'layanan pelanggan, empatik' },
  { id: 'en-us-elio', name: 'Elio', tone: 'formal, resmi' },
  { id: 'en-us-enya', name: 'Enya', tone: 'pemandu teknis' },
  { id: 'en-us-enzo', name: 'Enzo', tone: 'pencerita petualangan' },
  { id: 'en-us-finn', name: 'Finn', tone: 'asisten pribadi' },
  { id: 'en-us-fola', name: 'Fola', tone: 'layanan pelanggan' },
  { id: 'en-us-gero', name: 'Gero', tone: 'hangat, menenangkan' },
  { id: 'en-us-hali', name: 'Hali', tone: 'layanan pelanggan' },
  { id: 'en-us-jett', name: 'Jett', tone: 'pemandu teknis' },
  { id: 'en-us-lora', name: 'Lora', tone: 'concierge elegan' },
  { id: 'en-us-ludo', name: 'Ludo', tone: 'pengajar teknologi' },
  { id: 'en-us-lumi', name: 'Lumi', tone: 'pengajar sastra' },
  { id: 'en-us-mako', name: 'Mako', tone: 'presentasi produk' },
  { id: 'en-us-neno', name: 'Neno', tone: 'lembut, pendengar' },
  { id: 'en-us-nika', name: 'Nika', tone: 'lembut, pendengar' },
  { id: 'en-us-nyla', name: 'Nyla', tone: 'pemandu teknis' },
  { id: 'en-us-rami', name: 'Rami', tone: 'pembaca berita' },
  { id: 'en-us-riko', name: 'Riko', tone: 'pencerita fantasi' },
  { id: 'en-us-rina', name: 'Rina', tone: 'hangat, menenangkan' },
  { id: 'en-us-tari', name: 'Tari', tone: 'tenang, menenangkan' },
  { id: 'en-us-tavi', name: 'Tavi', tone: 'concierge elegan' },
  { id: 'en-us-tova', name: 'Tova', tone: 'formal, resmi' },
  { id: 'en-us-varo', name: 'Varo', tone: 'pengajar matematika' },
  { id: 'en-us-veda', name: 'Veda', tone: 'pembaca berita' },
  { id: 'en-us-zali', name: 'Zali', tone: 'dramatis, fantasi gelap' },
  { id: 'en-us-zeno', name: 'Zeno', tone: 'pembawa acara' }
]

/** Tone of any Gemini voice we know, by id. */
export function geminiVoiceTone(id: string): string | undefined {
  return GEMINI_LIBRARY_VOICES.find((v) => v.id === id)?.tone ?? GEMINI_VOICES.find((v) => v.id === id)?.tone
}

export function geminiVoiceName(id: string): string {
  return GEMINI_LIBRARY_VOICES.find((v) => v.id === id)?.name ?? id
}

/** The 30 classic prebuilt voices. */
export const GEMINI_VOICES: { id: string; tone: string }[] = [
  { id: 'Charon', tone: 'informatif' },
  { id: 'Kore', tone: 'tegas' },
  { id: 'Puck', tone: 'ceria' },
  { id: 'Zephyr', tone: 'cerah' },
  { id: 'Fenrir', tone: 'bersemangat' },
  { id: 'Leda', tone: 'muda' },
  { id: 'Orus', tone: 'tegas' },
  { id: 'Aoede', tone: 'santai' },
  { id: 'Callirrhoe', tone: 'santai' },
  { id: 'Autonoe', tone: 'cerah' },
  { id: 'Enceladus', tone: 'berbisik' },
  { id: 'Iapetus', tone: 'jernih' },
  { id: 'Umbriel', tone: 'santai' },
  { id: 'Algieba', tone: 'halus' },
  { id: 'Despina', tone: 'halus' },
  { id: 'Erinome', tone: 'jernih' },
  { id: 'Algenib', tone: 'serak' },
  { id: 'Rasalgethi', tone: 'informatif' },
  { id: 'Laomedeia', tone: 'ceria' },
  { id: 'Achernar', tone: 'lembut' },
  { id: 'Alnilam', tone: 'tegas' },
  { id: 'Schedar', tone: 'stabil' },
  { id: 'Gacrux', tone: 'dewasa' },
  { id: 'Pulcherrima', tone: 'lugas' },
  { id: 'Achird', tone: 'ramah' },
  { id: 'Zubenelgenubi', tone: 'kasual' },
  { id: 'Vindemiatrix', tone: 'lembut' },
  { id: 'Sadachbia', tone: 'hidup' },
  { id: 'Sadaltager', tone: 'berwawasan' },
  { id: 'Sulafat', tone: 'hangat' }
]

export const LANGUAGES: { code: string; label: string; english: string }[] = [
  { code: 'id', label: 'Indonesia', english: 'Indonesian' },
  { code: 'en', label: 'English', english: 'English' },
  { code: 'ms', label: 'Melayu', english: 'Malay' },
  { code: 'jv', label: 'Jawa', english: 'Javanese' },
  { code: 'su', label: 'Sunda', english: 'Sundanese' },
  { code: 'es', label: 'Español', english: 'Spanish' },
  { code: 'ar', label: 'العربية', english: 'Arabic' }
]

export const DURATIONS: { sec: number; label: string }[] = [
  { sec: 30, label: '30 detik' },
  { sec: 60, label: '1 menit' },
  { sec: 180, label: '3 menit' },
  { sec: 300, label: '5 menit' },
  { sec: 600, label: '10 menit' }
]

/** Roughly one clip every ~5.5 seconds of narration. */
export function clipCountFor(durationSec: number): number {
  return Math.max(3, Math.min(120, Math.round(durationSec / 5.5)))
}
