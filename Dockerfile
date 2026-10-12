# Bang Story web — single-user self-host image.
# Backend (Express) + built frontend (Vite) in one container; data lives in /data.

# ---------------------------------------------------------------------------
# whisper.cpp — the `whisper-cli` bundled in the repo is built against a newer
# glibc than this image has (Debian 12 is glibc 2.36, the binary needs 2.38), so
# inside the container it dies with "version `GLIBC_2.38' not found". The app
# swallows that error and falls back to estimated timings, which cuts the take
# in the wrong places. Build a binary that matches this image instead.
# ---------------------------------------------------------------------------
FROM node:20-bookworm AS whisper
ARG WHISPER_CPP_REF=v1.9.4
RUN apt-get update \
  && apt-get install -y --no-install-recommends git cmake make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_CPP_REF" https://github.com/ggml-org/whisper.cpp /whisper.cpp \
  && cmake -S /whisper.cpp -B /whisper.cpp/build \
       -DCMAKE_BUILD_TYPE=Release \
       -DBUILD_SHARED_LIBS=OFF \
       -DWHISPER_BUILD_TESTS=OFF \
       -DWHISPER_BUILD_SERVER=OFF \
  && cmake --build /whisper.cpp/build --target whisper-cli -j"$(nproc)"

FROM node:20-bookworm

# Build tools for better-sqlite3 (fallback if no prebuilt binary is available)
# plus ca-certificates for HTTPS downloads (ffmpeg-static, whisper model).
# libgomp1 is needed by the OpenMP-enabled whisper build (and Piper's onnxruntime).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Shared types/rules used by both backend and frontend
COPY shared/ ./shared/

# Install dependencies first (better layer caching)
COPY backend/package.json backend/package-lock.json ./backend/
COPY frontend/package.json frontend/package-lock.json ./frontend/
# --ignore-scripts: the sandbox build showed node-gyp can fail with EPERM here,
# so native bits are set up explicitly below.
RUN cd backend && npm ci --ignore-scripts \
  && cd ../frontend && npm ci

# Copy the rest of the sources
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Replace the repo's prebuilt whisper-cli with one built for this image's glibc.
COPY --from=whisper /whisper.cpp/build/bin/whisper-cli ./backend/resources/whisper/whisper-cli

# Native/runtime bits for the backend:
#  - better-sqlite3: fetch the prebuilt binary for this platform (no compile needed)
#  - ffmpeg-static: download the static ffmpeg binary
RUN cd backend \
  && npm rebuild better-sqlite3 \
  && node node_modules/ffmpeg-static/install.js \
  && chmod +x resources/whisper/whisper-cli \
  && if [ -f resources/piper/piper ]; then chmod +x resources/piper/piper; fi \
  && npm run build

# Build the web client
RUN cd frontend && npm run build

EXPOSE 3100
ENV BANG_STORY_DATA=/data \
    PORT=3100
VOLUME /data

WORKDIR /app/backend
CMD ["node", "dist/backend/src/server.js"]
