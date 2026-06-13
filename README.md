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

<img src="https://cdn.simpleicons.org/whatsapp/25D366" alt="WhatsApp" width="16" valign="middle"> &nbsp;**WhatsApp es el canal principal**, no un add-on. Todo lo siguiente ya viene encendido en producción.

**Entrada — lo que el agente entiende:**

- **Voz** — transcripción automática de notas de voz. OpenAI Whisper API por defecto; opción `/use-local-whisper` para correr `whisper.cpp` local en Apple Silicon (gratis, offline).
- **Imágenes** — vision multimodal nativa de Claude sobre adjuntos de WhatsApp (`/add-image-vision`).
- **PDFs** — extracción de texto vía `pdftotext` para adjuntos, URLs y archivos locales (`/add-pdf-reader`).
- **Reacciones** — emoji reactions parseadas como señales (`/add-reactions`).
- **Conversaciones 1-a-1** — chats privados tratados como "grupos individuales", cada cliente con su `CLAUDE.md` y memoria aislada.
- **Modo shared-number** — el bot puede compartir cuenta WhatsApp con humanos sin spawning espurio (gate `ASSISTANT_HAS_OWN_NUMBER`).

**Salida — lo que el agente entrega:**

- **Texto con menciones reales** — `@<numero>` con JID en el array `mentions` para que WhatsApp dispare la notificación (no texto cosmético).
- **Notas de voz (TTS)** — el agente responde con audio real, voces es-MX vía ElevenLabs (Sofi usa la voz `regina` por default).
- **Documentos** — PDFs y archivos con preview correcto en mobile (Baileys 7.x con `{ url }`, no Buffer).
- **Imágenes y archivos generados al vuelo** — sube a EasyBits y entrega URLs firmadas o públicas directo al chat.
- **Reacciones de salida** — el agente puede reaccionar a mensajes como confirmación rápida.

**Capacidades encendidas que aparecen en el chat:**

- **Búsqueda web y scraping** — BrightData MCP para investigar URLs, buscar y extraer contenido sin salir de WhatsApp.
- **Sandbox de código** — ejecución aislada en microVMs Firecracker via EasyBits (`sandbox_create`, `sandbox_exec`, `sandbox_run_code`).
- **Tareas programadas** — el agente agenda recordatorios, reportes recurrentes y briefings que llegan al chat por cron.
- **Coexistencia bot-humano** — pausa automática cuando un operador humano responde en el mismo chat WABA (no se monta encima del humano).
- **Fecha viva** — `currentDate` se refresca por turno via `UserPromptSubmit` hook; contenedores long-lived no "congelan" la fecha.
- **Fallback de rate-limit transparente** — si el plan Max recibe 429, reintenta con API key + Sonnet sin que el usuario lo note.
- **`/compact` desde chat de control** — compactación manual del contexto para sesiones largas sin perder el hilo.
- **Filtro anti-meta-respuestas** — silencia leaks tipo "(Sin acción…)" para que el agente no rompa la inmersión.

### WhatsApp Business API vía Formmy (canal productivo)

Para despliegues de cliente sobre **WhatsApp Business API oficial** (no Baileys), GhostyClaw incluye el canal `formmy-whatsapp` (`src/channels/formmy-whatsapp.ts`). Diferencia clave con upstream: existe una ruta productiva sancionada por Meta, no solo Baileys (que es linked-device).

```
Cliente WhatsApp ↔ Meta Cloud API ↔ Formmy (formmy.app) ↔ NanoClaw ↔ Container Claude
```

- **Formmy actúa como solution provider** (gestiona tokens, número, plantillas en Meta Business Manager).
- **NanoClaw recibe webhooks** de Formmy y responde por el mismo bridge — los mensajes fluyen vía HTTP, no via socket WhatsApp.
- **Conversaciones 1:1** se llaman *WABA chats*, no "grupos". Cada chat tiene su propio `CLAUDE.md` y memoria aislada.
- **Superficie pública del agente** está restringida vía `FORMMY_PUBLIC_TEMPLATE` y `skills-public/` para evitar fuga de tools internos a usuarios finales — ver [`docs/PUBLIC_AGENT_SURFACE.md`](docs/PUBLIC_AGENT_SURFACE.md).
- **Sofi WABA** — agente público de demo activado siguiendo [`docs/SOFI_WABA_ACTIVATION.md`](docs/SOFI_WABA_ACTIVATION.md).

Concerns conocidos: Formmy es SPOF para mensajería (si Formmy se cae, los chats WABA se interrumpen) y agrega ~200-400ms de latencia. El roadmap incluye un canal `meta-waba` directo que elimina al intermediario (NanoClaw ↔ Meta Cloud API), manteniendo a Formmy solo como gestor de credenciales.

Documentación detallada:

- [`docs/formmy-channel-integration.md`](docs/formmy-channel-integration.md) — arquitectura del canal
- [`docs/formmy-nanoclaw-bridge.md`](docs/formmy-nanoclaw-bridge.md) — protocolo del bridge

### Canales adicionales

Mismo patrón que upstream pero ampliado:

- `/add-whatsapp` — Baileys (linked-device, QR o pairing code) — para uso personal o cuentas no-WABA
- **`formmy-whatsapp`** — WABA oficial via Formmy bridge (productivo, ver arriba)
- `/add-telegram` — Telegram Bot API
- `/add-telegram-swarm` — Agent Swarm con un bot por subagente
- `/add-slack` — Slack via Socket Mode
- `/add-discord` — Discord bot
- `/add-gmail` — Gmail como tool o canal completo (OAuth GCP)
- **Meta WABA directo** (roadmap) — webhook nativo a Meta Cloud API, sin Formmy en el path de mensajes

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

El upstream permite el tool `Agent` para spawn de sub-agentes. En GhostyClaw la familia de tools de sub-agente/equipos (`Agent`, `Task`, `TaskCreate`, `TeamCreate`, …) está **bloqueada** vía `buildDisallowedTools()` (lista `SUBAGENT_TOOLS` en `container/agent-runner/src/index.ts`) — no basta con quitarlos del allowlist, hay que desautorizarlos para que el SDK no los exponga:

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
