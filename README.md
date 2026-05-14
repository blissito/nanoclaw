<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="GhostyClaw" width="400">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/WhatsApp-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="WhatsApp">
  &nbsp;
  <img src="https://img.shields.io/badge/Claude-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="Claude Agent SDK">
  &nbsp;
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 20+">
  &nbsp;
  <img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker">
</p>

<p align="center">
  <strong>GhostyClaw</strong> — un fork de <a href="https://github.com/qwibitai/nanoclaw">NanoClaw</a> orientado a WhatsApp para despliegues reales en México.
</p>

<p align="center">
  <img src="https://cdn.simpleicons.org/whatsapp/25D366" alt="WhatsApp" width="20" valign="middle">
  &nbsp;Voz, imágenes, PDFs, reacciones, menciones — todo conectado a Claude.
</p>

---

## Qué es GhostyClaw

GhostyClaw es un fork productivo de [NanoClaw](https://github.com/qwibitai/nanoclaw). Conserva la filosofía del upstream (un solo proceso, agentes en contenedores aislados, skills en vez de features) pero está endurecido para uso real sobre WhatsApp en español de México, con clientes en producción.

Si buscas la base genérica, ve al upstream. Este fork existe porque WhatsApp como canal principal —con voz, imágenes, documentos y multi-tenant— requiere piezas que el upstream no trae.

## Divergencias con upstream

Solo se documenta lo que **cambia o se añade** respecto a `qwibitai/nanoclaw`. Todo lo demás (arquitectura, skills, filosofía, setup) sigue idéntico al upstream — léelo allá.

### Canal WhatsApp de primera clase

<img src="https://cdn.simpleicons.org/whatsapp/25D366" alt="WhatsApp" width="16" valign="middle"> &nbsp;**WhatsApp es el canal principal**, no un add-on:

- **Voz** — transcripción automática de notas de voz. OpenAI Whisper API por defecto; opción `/use-local-whisper` para correr `whisper.cpp` local en Apple Silicon (gratis, offline).
- **Imágenes** — vision multimodal nativa de Claude sobre adjuntos de WhatsApp (`/add-image-vision`).
- **PDFs** — extracción de texto vía `pdftotext` para adjuntos, URLs y archivos locales (`/add-pdf-reader`).
- **Reacciones** — recibir, enviar, almacenar y buscar reacciones emoji (`/add-reactions`).
- **Menciones reales** — `@<numero>` con JID en el array de mentions para que WhatsApp dispare notificación (no solo texto cosmético).
- **Documentos salientes** — envío de PDFs y archivos con preview correcto en mobile (Baileys 7.x con `{ url }`, no Buffer).
- **Conversaciones 1-a-1** — soporte para chats privados como "grupos individuales" (cada cliente tiene su `CLAUDE.md` y memoria propia).
- **Modo shared-number** — el bot puede compartir cuenta WhatsApp con humanos sin spawning espurio (gate `ASSISTANT_HAS_OWN_NUMBER`).

### Canales adicionales

Mismo patrón que upstream pero ampliado:

- `/add-whatsapp` — canal principal (Baileys, QR o pairing code)
- `/add-telegram` — Telegram Bot API
- `/add-telegram-swarm` — Agent Swarm con un bot por subagente
- `/add-slack` — Slack via Socket Mode
- `/add-discord` — Discord bot
- `/add-gmail` — Gmail como tool o canal completo (OAuth GCP)
- **Meta WABA directo** (roadmap) — webhook nativo a Meta Cloud API, sin proxy intermedio

### MCP servers pre-instalados

El upstream trae el MCP `nanoclaw` core. GhostyClaw añade un catálogo listo para activar por grupo via `container_config.mcpServers`:

| Server | Propósito |
|--------|-----------|
| `easybits` | Almacenamiento de archivos, imágenes, documentos, websites, sandbox Firecracker |
| `kommo` | CRM Kommo (leads, contactos, pipelines) |
| `smatch` / `smatch-public` | Admin de clubes deportivos (MongoDB) |
| `brightdata` | Web scraping y search |
| `skydropx` | Envíos México (FedEx, DHL, Estafeta, J&T, Sendex) via OAuth2 |
| `formmy` | Plataforma Formmy (agentes, documentos, integraciones) |
| `ollama` | Modelos locales para tareas baratas |

Skills correspondientes: `/add-easybits`, `/add-skydropx`, `/add-ollama-tool`, `/add-parallel`, etc.

### Credential proxy con fallback

`src/credential-proxy.ts` no existe en upstream. Permite:

- **OAuth Max + API key fallback** — si el plan Max recibe 429, reintenta automáticamente con API key y modelo Sonnet compatible.
- **Switch sin rebuild** — comentar/descomentar `CLAUDE_CODE_OAUTH_TOKEN` en `.env` y reiniciar.
- **Agent Vault (WIP)** — políticas por grupo (rate limit, modelos permitidos, max input tokens), usage logging en ring buffer, endpoints `GET /nanoclaw/vault/usage` y `POST /nanoclaw/vault/policy`.

### Deploy a producción

Upstream asume instalación local. GhostyClaw incluye flujo completo para DigitalOcean:

- **`scripts/prepare-snapshot.sh`** — crea snapshot sanitizado (sin creds, sin DB, sin sesiones) listo para clonar a nuevos clientes via `doctl`.
- **`scripts/wa-reconnect.sh`** — re-pairing automatizado de WhatsApp con pairing code (default número MX, con manejo de rate limits de Meta).
- **Multi-droplet** — soporte para varias instancias paralelas (`ghosty-0`, droplets de cliente).
- **systemd service** — `com.nanoclaw.plist` (macOS launchd) y `nanoclaw.service` (Linux systemd).
- **Auto-detección de auth mode** — el proxy detecta OAuth vs API key sin intervención manual.

### Skills exclusivos del fork

Adicionales a los del upstream:

- `/add-image-vision` — multimodal sobre imágenes de WhatsApp
- `/add-voice-transcription` — Whisper API para notas de voz
- `/use-local-whisper` — switch a `whisper.cpp` local (Apple Silicon)
- `/add-pdf-reader` — extracción de texto de PDFs
- `/add-reactions` — reacciones emoji de WhatsApp
- `/add-skydropx` — envíos México
- `/add-easybits` — storage cloud
- `/add-ollama-tool` — modelos locales
- `/add-parallel` — Parallel AI integration
- `/add-telegram-swarm` — multi-bot por subagente
- `/add-compact` — comando manual `/compact` para sesiones largas
- `/migrate-nanoclaw` — migración intent-based desde fork customizado a upstream limpio
- `/update-nanoclaw` — bring updates upstream a instalación customizada sin perder cambios
- `/x-integration` — X (Twitter): post, like, reply, retweet, quote

### Sub-agentes deshabilitados por default

El upstream permite el tool `Agent` para spawn de sub-agentes. En GhostyClaw está **removido** de `buildAllowedTools()` (en `container/agent-runner/src/index.ts`):

- En droplets pequeños (2GB) saturan RAM (~100-150MB por sub-agente)
- Los sub-agentes **no heredan MCP servers** del padre, así que pierden contexto crítico de DB/tools
- Se puede reactivar por grupo via `container_config.allowedTools`

Workaround: tareas programadas (`task-scheduler`) funcionan como sub-agentes asíncronos entre contenedores.

### Español de México por default

Prompts, mensajes de sistema y agentes asumen es-MX (tuteo, sin voseo). No hay configuración multi-locale como en upstream.

## Setup

Idéntico al upstream:

```bash
gh repo fork blissito/nanoclaw --clone
cd nanoclaw
claude
```

Dentro de `claude`, ejecuta `/setup`. Luego `/add-whatsapp` para conectar el canal principal.

> El upstream apunta a `qwibitai/nanoclaw`. Este fork apunta a [`blissito/nanoclaw`](https://github.com/blissito/nanoclaw).

## Requisitos

Mismos que upstream:

- macOS o Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Docker](https://docker.com/products/docker-desktop) o [Apple Container](https://github.com/apple/container)

## Deploy manual a producción

```bash
# 1. Obtener IP del droplet
doctl compute droplet list --format Name,PublicIPv4 --no-header | grep nanoclaw-prod

# 2. SSH, pull, build, restart
ssh root@<IP> "cd /home/nanoclaw/app && git pull && npm run build && systemctl restart nanoclaw"

# 3. Verificar
ssh root@<IP> "systemctl status nanoclaw --no-pager | head -8"
```

Rebuild del container (solo para cambios en `Dockerfile`, `apt` o `npm install -g` globales):

```bash
ssh root@<IP> "cd /home/nanoclaw/app && ./container/build.sh"
```

> Cambios en `container/agent-runner/src/*.ts` **requieren rebuild** aunque el código esté montado — la prueba de mtime del entrypoint falla en producción.

Variables de entorno nuevas (`.env` está gitignored):

```bash
ssh root@<IP> "echo 'NEW_VAR=value' >> /home/nanoclaw/app/.env && systemctl restart nanoclaw"
```

Tras deploys que añadan o modifiquen skills:

```bash
ssh root@<IP> "chown -R nanoclaw:nanoclaw /home/nanoclaw/app/data/sessions/"
```

## Documentación adicional

- [docs/SPEC.md](docs/SPEC.md) — arquitectura completa
- [docs/SECURITY.md](docs/SECURITY.md) — modelo de seguridad
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — decisiones de diseño
- [docs/PUBLIC_AGENT_SURFACE.md](docs/PUBLIC_AGENT_SURFACE.md) — superficie pública del agente WABA
- [CLAUDE.md](CLAUDE.md) — guía operativa para el repo
- [CHANGELOG.md](CHANGELOG.md) — cambios y migraciones

Para todo lo no documentado aquí, aplica la documentación del upstream: [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Licencia

MIT (heredada del upstream).
