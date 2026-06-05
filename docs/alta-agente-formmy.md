# Alta de un agente Formmy (canal público WABA)

Runbook completo y verificable para dar de alta un agente público nuevo (WhatsApp
Business vía Formmy → droplet NanoClaw). Nace del dolor real de levantar el 2º agente
(Totequim, 2026-06-05): el 1º (Siiqtec/sofi) nunca se documentó y cada pieza se
descubrió a la mala. Esto es para que el 3º y 4º tomen **minutos, no días**.

> **Regla de oro:** el droplet casi nunca es el problema. Cuando "no responde", la falla
> está del lado Formmy (config del agente en Mongo). El cliente ve
> *"Tuve un problema procesando tu mensaje. Intenta más tarde."* cuando Formmy NO logra
> reenviar al droplet y cae a su fallback OpenRouter (`server/channels/handler.ts`).

---

## Arquitectura (modelo nuevo, 2026)

```
Cliente WhatsApp
   ↕ Meta Cloud API
Formmy (Fly app `formmy-v2`)            ← persiste la conversación, decide el pipeline
   ↕ HTTP POST /message  (Bearer dropletChannelSecret)
Droplet NanoClaw (DigitalOcean, :3940)  ← corre el agente real (Claude Agent SDK)
   ↕ POST FORMMY_CALLBACK_URL (/send)    ← respuesta de vuelta al cliente
```

**Ruteo del inbound** (`/app/server/channels/handler.ts`):
- Meta msg → `phoneNumberId` → **Channel** (`kind:WHATSAPP_WABA`, tiene `phoneNumber`,
  `displayName`, `verifiedName`) → `Channel.ownerId` → **Agent**.
- **Branch A** (producción): `if (agent.dropletHost && agent.dropletChannelSecret)` →
  `POST http://{dropletHost}:{dropletChannelPort}/message` con
  `Authorization: Bearer {dropletChannelSecret}` y `return`. La respuesta llega async
  por `/send`.
- **Branch B** (fallback): si falta `dropletHost` **o** `dropletChannelSecret` → pipeline
  interno OpenRouter; si truena → *"Tuve un problema procesando tu mensaje"*.

> El bridge **NO** vive en `Integration.externalAgentUrl/externalAgentSecret` (ese es el
> modelo viejo, abril 2026; las integraciones nuevas lo tienen `null`). Vive en el doc
> **`Agent`**. El reenvío **NO** depende del admin-api 8787 ni de `dropletStatus`.

### Colecciones de Formmy (Mongo) que importan

| Colección | Campos clave | Para qué |
|---|---|---|
| `Agent` | `dropletHost`, `dropletChannelPort` (3940), `dropletChannelSecret`, `dropletPort` (8787), `dropletApiToken` | Bridge + admin-api |
| `AgentSecret` | `agentId`, `key` (UPPER_SNAKE), `value` (en claro) | API keys de tools (EASYBITS_API_KEY…). Lo que se ve en el tab **Secretos** |
| `Channel` | `kind`, `ownerType:agent`, `ownerId`, `phoneNumber`, `config.phoneNumberId` | Lo crea el pairing WABA |
| `Integration` | `phoneNumberId`, `channelId` | Lo crea el pairing; enlaza Meta↔Channel |

---

## Acceso al Mongo de Formmy

`fly auth whoami` debe estar logueado. Para evitar el infierno de comillas, mandar el JS
en **base64**:

```bash
cat > /tmp/q.js <<'JS'
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  // ... usar db.$runCommandRaw({find/update:'Agent'|'AgentSecret'|'Channel', ...}) o db.agent.* ...
  process.exit(0);
})();
JS
B64=$(base64 < /tmp/q.js | tr -d '\n')
fly ssh console --app formmy-v2 -C "node -e \"eval(Buffer.from('$B64','base64').toString())\""
```

> Al dumpear, **redactar siempre** `token|secret`. La fuente TS vive en la VM:
> `/app/server/channels/handler.ts` y `/app/server/integrations/whatsapp/forward.server.ts`.

---

## Checklist de alta

Prerrequisito: el droplet ya corre NanoClaw con el canal `formmy-whatsapp` (puerto 3940),
y en Formmy ya se hizo el pairing WABA del número (existe el `Channel` + `Integration`).

### A. Lado droplet

1. **Secret propio** en `.env` (identidad por agente — lo ÚNICO que no se comparte):
   ```bash
   SECRET=$(openssl rand -hex 32)
   ssh root@<IP> "cd /home/nanoclaw/app && cp .env .env.bak.$(date +%F-%H%M%S) \
     && sed -i 's|^FORMMY_CHANNEL_SECRET=.*|FORMMY_CHANNEL_SECRET='$SECRET'|' .env \
     && systemctl restart nanoclaw"
   scp root@<IP>:/home/nanoclaw/app/.env ~/.env-backups/<droplet>.env   # refrescar backup
   ```
   > `ANTHROPIC_API_KEY` y `CLAUDE_CODE_OAUTH_TOKEN` se comparten a propósito (cómputo, no
   > identidad). El único per-agente es `FORMMY_CHANNEL_SECRET`.

2. **Overlay del prompt entrenado:** `FORMMY_TRAINING_GROUP_FOLDER=<folder>` apuntando a un
   folder existente con el `CLAUDE.md` entrenado (ej. `main`). El container WABA monta
   `groups/<folder>/CLAUDE.md → /workspace/group/CLAUDE.md`.

3. **(Opcional, paridad de panel)** servicio admin-api 8787 — ver sección "admin-api" abajo.

### B. Lado Formmy (Mongo)

4. **Bridge en el Agent.** Set `dropletHost`, `dropletChannelPort=3940`, `dropletChannelSecret`
   = el `FORMMY_CHANNEL_SECRET` del `.env`. **⚠️ Un droplet = UN secret:** si varios agentes
   apuntan al mismo droplet:3940, TODOS deben tener el MISMO `dropletChannelSecret`.
   ```js
   const IDS = ['<agentId1>', '<agentId2-mismo-droplet>'];
   await db.$runCommandRaw({ update:'Agent', updates: IDS.map(id => ({
     q:{_id:{$oid:id}}, u:{$set:{ dropletHost:'<IP>', dropletChannelPort:3940,
       dropletChannelSecret:'<SECRET>' }} })) });
   ```

5. **Secrets de tools (`AgentSecret`)** — clonar los que tenga sofi (mínimo `EASYBITS_API_KEY`).
   Es lo que se ve en el tab **Secretos**; sin la fila NO aparece en el UI aunque el container
   ya tenga la key por el `.env`.
   ```js
   await db.agentSecret.upsert({
     where:{ agentId_key:{ agentId:'<agentId>', key:'EASYBITS_API_KEY' } },
     update:{ value:'<eb_sk_live_...>' },
     create:{ agentId:'<agentId>', key:'EASYBITS_API_KEY', value:'<eb_sk_live_...>' } });
   ```
   Descubrir qué secrets tiene sofi:
   ```js
   const r = await db.$runCommandRaw({find:'AgentSecret',filter:{agentId:{$oid:'<sofiAgentId>'}}});
   console.log((r.cursor.firstBatch).map(x=>x.key));
   ```

---

## Verificación (sin esperar al cliente)

Hacer en orden; cada paso aísla la falla:

1. **3940 alcanzable desde internet** (proxy del camino Fly→droplet):
   ```bash
   curl -m 10 -o /dev/null -w "%{http_code}\n" http://<IP>:3940/   # 404 = alcanzable
   ```
2. **Self-test del secret** (sin efectos: secret bueno+`{}` → 400; malo → 401):
   ```bash
   ssh root@<IP> "curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3940/message \
     -H 'Authorization: Bearer <SECRET>' -H 'Content-Type: application/json' -d '{}'"   # 400
   ```
3. **Cadena Formmy correcta** (`Branch A: true`): Conversation/Integration → `channelId` →
   `Channel.ownerId` → `Agent` con `dropletHost && dropletChannelSecret`.
4. **POST directo imitando a Formmy** (número FALSO, no escribe a nadie real):
   ```bash
   ssh root@<IP> "curl -s -X POST http://127.0.0.1:3940/message -H 'Authorization: Bearer <SECRET>' \
     -H 'Content-Type: application/json' -d '{\"jid\":\"formmy_5210000000001@s.whatsapp.net\",
     \"sender\":\"5210000000001\",\"sender_name\":\"PRUEBA\",\"content\":\"ping\",
     \"integration_id\":\"<INTEG_ID>\",\"is_from_me\":false}'"
   # logs: journalctl -u nanoclaw -n20 → 'Auto-provisioned' + 'Spawning container agent'
   ```
   Limpiar el rastro: `docker kill` del container + `DELETE FROM formmy_jid_mapping/registered_groups/messages`
   de ese folder + `rm -rf groups/<folder> data/sessions/<folder>`.
5. **Mensaje real** → el bot responde con el prompt entrenado.
6. **DB del catálogo** → pedir un producto/cotización; debe leer la DB EasyBits (`siiqtec-catalogo`).

---

## admin-api (puerto 8787) — opcional, para el panel "Droplet"

El tab Droplet muestra "Grupos Baileys: fetch failed" / "● No configurado <IP>:8787" cuando
el droplet **no corre** el admin-api. Es **cosmético** — no afecta el ruteo de mensajes. Para
igualarlo a sofi (panel sano, lista de grupos Baileys, "Probar"):

1. En el droplet, crear `/etc/systemd/system/nanoclaw-admin-api.service` (igual que sofi):
   ```ini
   [Service]
   Type=simple
   User=nanoclaw
   WorkingDirectory=/home/nanoclaw/app
   EnvironmentFile=/home/nanoclaw/app/.env
   Environment=NANOCLAW_ADMIN_HOST=0.0.0.0
   Environment=NANOCLAW_ADMIN_PORT=8787
   Environment=NANOCLAW_GROUPS_DIR=/home/nanoclaw/app/groups
   ExecStart=/usr/bin/npx tsx /home/nanoclaw/app/src/admin-api.ts
   Restart=on-failure
   [Install]
   WantedBy=multi-user.target
   ```
   (`NANOCLAW_ADMIN_TOKEN` ya viene en el `.env`.) Luego `systemctl enable --now nanoclaw-admin-api`.
2. En Mongo, set `Agent.dropletApiToken` = el `NANOCLAW_ADMIN_TOKEN` del `.env`, para que
   Formmy se autentique contra el 8787.

---

## Troubleshooting (síntomas reales del incidente Totequim)

| Síntoma | Causa | Fix |
|---|---|---|
| Cliente ve *"Tuve un problema procesando tu mensaje"* | `Agent.dropletChannelSecret` vacío → Branch B (OpenRouter) | Set `dropletChannelSecret` (B-4) |
| Cliente no recibe nada (silencio) | Branch A pero droplet inalcanzable / secret no coincide | Verif. 1-2; secret `.env` = Mongo |
| `EASYBITS_API_KEY` no aparece en tab Secretos | No existe la fila `AgentSecret` | upsert `AgentSecret` (B-5) |
| Panel: "Grupos Baileys: fetch failed" / "No configurado :8787" | admin-api no corre en el droplet | Cosmético; opcional sección 8787 |
| Roté el `.env` y se cayó OTRO agente del mismo droplet | Un droplet = un secret; los demás agentes quedaron desfasados | Actualizar `dropletChannelSecret` en TODOS |
| Edité el `.env`/training folder y no toma efecto | systemd lee `EnvironmentFile` al arrancar | `systemctl restart nanoclaw` |

Ver también: `docs/formmy-nanoclaw-bridge.md` (modelo viejo / detalles de JIDs, coexistencia,
rescate de mensajes) y el script `scripts/alta-agente-formmy.sh` (lado droplet automatizado).
