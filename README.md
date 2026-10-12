# Bang Story (Web)

**Ubah ide cerita jadi video YouTube, dari browser — self-host, single-user.**

Tulis satu ide, misalnya *"Bagaimana rasanya hidup di Batavia tahun 1700-an?"*, lalu aplikasi akan:
menyusun naskah per adegan (LLM), membuat gambar & video AI,
mengisi suara narator (Piper lokal atau ElevenLabs), menyamakan caption dengan suara (Whisper lokal),
lalu kamu merapikannya di editor timeline dan mengekspor MP4.

Port web dari aplikasi desktop Bang Story (Electron). Semua proyek, gambar, video, dan suara
tersimpan di server-mu sendiri. Kamu memakai kunci API sendiri (*bring your own key*) —
biaya AI dibayar langsung ke penyedianya, tanpa server perantara.

## Cara menjalankan

### Opsi 1 — Docker (disarankan)

```bash
docker build -t bang-story-web .
docker run -d --name bang-story -p 3100:3100 -v bang-story-data:/data bang-story-web
# atau: docker compose up -d --build
```

Lalu buka **http://localhost:3100**.

### Opsi 2 — Manual (Node 20+)

```bash
# backend
cd backend
npm install            # bila node-gyp gagal di sandbox: npm install --ignore-scripts,
                       # lalu: npm rebuild better-sqlite3 ; node node_modules/ffmpeg-static/install.js
npm run build          # tsc + kompilasi shared + tsc-alias

# frontend
cd ../frontend
npm install
npm run build

# jalankan
cd ../backend
BANG_STORY_DATA=/data PORT=3100 node dist/backend/src/server.js
```

Buka **http://localhost:3100**. Data (database, proyek, model) tersimpan di folder
`BANG_STORY_DATA` (bawaan: `~/.bang-story-web`).

## Isi kunci API (wajib sebelum generate)

Buka halaman **Pengaturan** di aplikasi, lalu tambah endpoint AI sendiri:

| Endpoint | Untuk | Kontrak |
|---|---|---|
| **LLM** | Naskah / penyusun cerita | OpenAI-compatible (`/chat/completions`) |
| **Gambar** | Gambar klip & lembar karakter | OpenAI-compatible (`/images/generations`) |
| **Video** | Video AI per klip | Kontrak Bang Story: `POST /generate` → `GET /status?taskId=` |

Kunci disimpan terenkripsi di database lokal dan hanya dikirim ke layanannya masing-masing.
Aplikasi tidak menyertakan kunci maupun endpoint apa pun — murni BYOK.

## Model Whisper (sinkron caption)

Sinkronisasi caption kata-per-kata memakai `whisper.cpp` lokal. Binary `whisper-cli`
sudah termasuk di `backend/resources/whisper/`. Model bahasa (`ggml-small.bin`, ~460 MB)
**belum termasuk** — unduh sekali dari halaman **Pengaturan → Whisper** di aplikasi
(tombol unduh; progres tampil di sana). Model tersimpan di dalam folder data
(`models/whisper/`), bukan di repo.

## Suara Piper (TTS lokal, opsional)

Binary + model suara Piper **tidak termasuk** di repo (total ~116 MB). Untuk memakai
TTS lokal "Piper", unduh sekali lalu taruh di `backend/resources/piper/`:

1. **Binary Piper** (Linux x86_64): https://github.com/rhasspy/piper/releases
   → unduh `piper_linux_x86_64.tar.gz`, ekstrak file `piper` + folder `espeak-ng-data`
2. **Voice Indonesia**: https://huggingface.co/rhasspy/piper-voices
   → `id/id_ID/news_tts/medium/` → unduh `id_ID-news_tts-medium.onnx` dan `.onnx.json`
3. Restart backend. Pilihan "Piper (lokal)" di Pengaturan akan berfungsi offline penuh.

## Catatan

- **Single-user, self-host.** Tidak ada login, tidak ada multi-tenant — aplikasi ini
  untuk dipakai sendiri di server/VPS-mu. Jangan ekspos langsung ke internet publik
  tanpa reverse proxy + autentikasi di depannya.
- TTS bawaan **FlowSpeech** (jalur tamu, gratis tanpa kunci). **Piper** lokal opsional — lihat bawah.
- Ekspor MP4 memakai FFmpeg statis yang diunduh otomatis saat instalasi backend.
- Struktur repo: `backend/` (Express + SQLite + job queue + SSE), `frontend/`
  (Vite + React + Tailwind), `shared/` (tipe & aturan yang dipakai kedua sisi —
  pratinjau dan ekspor memakai aturan yang sama).

## Pengembangan

```bash
cd backend  && npm run typecheck   # tsc --noEmit, harus bersih
cd frontend && npm run typecheck   # tsc --noEmit, harus bersih
```

API backend: `POST /api/<nama>` dengan body `{ "args": [...] }` → `{ "ok": true, "result": ... }`.
Event live (job, klip, aset, whisper): `GET /api/events` (Server-Sent Events).
