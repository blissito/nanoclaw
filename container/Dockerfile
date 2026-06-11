# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium and PDF tools
RUN apt-get update && apt-get install -y \
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
    curl \
    git \
    poppler-utils \
    ffmpeg \
    imagemagick \
    python3-pip \
    libreoffice-calc \
    unzip \
    mupdf-tools \
    qpdf \
    tesseract-ocr \
    tesseract-ocr-spa \
    python3-pil \
    && pip3 install --break-system-packages yt-dlp openpyxl pandas pymupdf python-docx \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install global CLIs and MCP servers
# Pre-installing MCP servers here avoids `npx -y` downloading them on every container start.
# When adding a new MCP server to agent-runner/src/index.ts, also add the package here.
RUN npm install -g agent-browser @anthropic-ai/claude-code @easybits.cloud/mcp panel-mcp smatch-mcp smatch-mcp-public @brightdata/mcp pptxgenjs

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
RUN chown -R node:node /workspace /app/dist /app/mcp-servers/kommo/dist /app/mcp-servers/canva/dist /app/mcp-servers/skydropx/dist /app/mcp-servers/spotify/dist && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
