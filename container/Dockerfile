# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# LEAN=1 builds a slim agent (~400-700MB vs ~5.4GB) for purpose-built bots whose
# tools are text + MCP only (e.g. tania: cotización + envíos skydropx + Kommo +
# EasyBits + MercadoPago). It SKIPS the heavy media/doc/browser/OCR toolchain
# (chromium, libreoffice, ffmpeg, tesseract, imagemagick, poppler/mupdf/qpdf,
# deno, gh, python-data). Default LEAN=0 = full kitchen-sink image, unchanged.
# Build slim: docker build --build-arg LEAN=1 -t nanoclaw-agent:latest .
ARG LEAN=0

# Essentials — always present (npm/clone/MCP builds need these).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip \
    && rm -rf /var/lib/apt/lists/*

# Heavy media/doc/browser/OCR toolchain — full builds only (skipped when LEAN=1).
RUN if [ "$LEAN" != "1" ]; then set -eux; \
    apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    poppler-utils \
    ffmpeg \
    imagemagick \
    espeak-ng \
    python3-pip \
    libreoffice-calc \
    mupdf-tools \
    qpdf \
    tesseract-ocr \
    tesseract-ocr-spa \
    python3-pil \
    && pip3 install --break-system-packages yt-dlp openpyxl pandas pymupdf python-docx kokoro-onnx soundfile \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/* ; \
    fi

# Kokoro TTS model (local, free) — baked in so no container downloads it from
# HuggingFace at runtime. ~350MB. Full builds only (voice is a media feature).
# Used by container/skills/voice/text-to-speech (kokoro-onnx, espeak-ng phonemizer).
RUN if [ "$LEAN" != "1" ]; then set -eux; \
    mkdir -p /opt/kokoro \
    && curl -fsSL -o /opt/kokoro/kokoro-v1.0.onnx \
       https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx \
    && curl -fsSL -o /opt/kokoro/voices-v1.0.bin \
       https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin ; \
    fi
ENV KOKORO_MODEL=/opt/kokoro/kokoro-v1.0.onnx
ENV KOKORO_VOICES=/opt/kokoro/voices-v1.0.bin

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install global CLIs and MCP servers
# Pre-installing MCP servers here avoids `npx -y` downloading them on every container start.
# When adding a new MCP server to agent-runner/src/index.ts, also add the package here.
RUN npm install -g agent-browser @anthropic-ai/claude-code @easybits.cloud/mcp panel-mcp smatch-mcp smatch-mcp-public @brightdata/mcp coregrid-crm-mcp@0.6.0 pptxgenjs

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Build bundled Kommo MCP server
COPY mcp-servers/kommo/package*.json /app/mcp-servers/kommo/
RUN cd /app/mcp-servers/kommo && npm install
COPY mcp-servers/kommo/ /app/mcp-servers/kommo/
RUN cd /app/mcp-servers/kommo && npm run build

# Build bundled Canva MCP server (OAuth via ghosty.studio)
COPY mcp-servers/canva/package*.json /app/mcp-servers/canva/
RUN cd /app/mcp-servers/canva && npm install
COPY mcp-servers/canva/ /app/mcp-servers/canva/
RUN cd /app/mcp-servers/canva && npm run build

# Build bundled Skydropx MCP server (Mexican shipping API, OAuth2 client_credentials)
COPY mcp-servers/skydropx/package*.json /app/mcp-servers/skydropx/
RUN cd /app/mcp-servers/skydropx && npm install
COPY mcp-servers/skydropx/ /app/mcp-servers/skydropx/
RUN cd /app/mcp-servers/skydropx && npm run build

# Build bundled Spotify MCP server (Web API, OAuth via ghosty.studio)
COPY mcp-servers/spotify/package*.json /app/mcp-servers/spotify/
RUN cd /app/mcp-servers/spotify && npm install
COPY mcp-servers/spotify/ /app/mcp-servers/spotify/
RUN cd /app/mcp-servers/spotify && npm run build

# Build bundled Supabase MCP server (PostgREST, bounded-output query/rpc/CRUD)
COPY mcp-servers/supabase/package*.json /app/mcp-servers/supabase/
RUN cd /app/mcp-servers/supabase && npm install
COPY mcp-servers/supabase/ /app/mcp-servers/supabase/
RUN cd /app/mcp-servers/supabase && npm run build

# Install pdf-reader CLI
COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader
RUN chmod +x /usr/local/bin/pdf-reader

# Install office-reader CLI
COPY skills/office-reader/office-reader /usr/local/bin/office-reader
RUN chmod +x /usr/local/bin/office-reader

# Install mercadopago CLI
COPY skills/mercadopago/mercadopago /usr/local/bin/mercadopago
RUN chmod +x /usr/local/bin/mercadopago

# Install pptx-gen CLI
COPY skills/pptx-gen/pptx-gen /usr/local/bin/pptx-gen
COPY skills/pptx-gen/pptx-helper.mjs /usr/local/lib/pptx-helper.mjs
RUN chmod +x /usr/local/bin/pptx-gen

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# TypeScript is pre-compiled at build time (npm run build → /app/dist/)
# If host mounts newer source into /app/src, recompile before running (~2-3s)
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nif [ /app/src/index.ts -nt /app/dist/index.js ]; then\n  cd /app && npx tsc --outDir dist 2>/dev/null\nfi\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace /app/dist /app/mcp-servers/kommo/dist /app/mcp-servers/canva/dist /app/mcp-servers/skydropx/dist /app/mcp-servers/spotify/dist /app/mcp-servers/supabase/dist && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
