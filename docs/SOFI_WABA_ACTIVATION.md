# Activación Formmy WABA en sofi-0

## Estado actual

✅ Código en sofi-0 (`17c04d5`): canal `formmy-whatsapp` listening en `3940`
✅ Shared secret generado y configurado en sofi-0 `.env`
✅ Local backup en `~/.env-backups/sofi-0.formmy-shared-secret.txt`
⏳ Pendiente: deploy de formmy.app con `e6de27c` (en rollout cuando se escribió este doc)
❌ Pendiente: Brenda crea Agent + Channel en formmy.app y completa Embedded Signup

## El shared secret

Vive en 3 lugares (deben coincidir):

1. **sofi-0 `.env`**: `FORMMY_CHANNEL_SECRET=<value>` (ya escrito)
2. **Local backup**: `~/.env-backups/sofi-0.formmy-shared-secret.txt` (ya escrito)
3. **formmy.app DB**: `Agent.dropletApiToken = <value>` (Brenda lo pega aquí)

Para verlo:

```bash
cat ~/.env-backups/sofi-0.formmy-shared-secret.txt
# o
ssh root@64.23.167.64 'grep FORMMY_CHANNEL_SECRET /home/nanoclaw/app/.env'
```

## Pasos que faltan para conectar (manual)

### 1. Brenda crea el Agent en formmy.app

Vía Prisma Studio, Mongo CLI, o UI de formmy.app (cuando exista):

```js
{
  slug: "sofi-totequim",
  name: "Sofi (totequim)",
  description: "Cotizador WhatsApp",
  isActive: true,
  instructions: "Eres Sofi, ...",
  userId: "<brenda-user-id>",
  dropletProvider: "digitalocean",
  dropletHost: "64.23.167.64",
  dropletPort: 3940,
  dropletApiToken: "<pegar shared secret de arriba>",
  dropletStatus: "healthy",
  containerConfig: null  // null = usa FORMMY_PUBLIC_TEMPLATE (default seguro)
}
```

### 2. Brenda crea el Channel

```js
{
  kind: "WABA",
  status: "DISCONNECTED",
  ownerType: "agent",
  ownerId: "<Agent.id de arriba>",
  displayName: "WhatsApp totequim"
}
```

### 3. Brenda hace Embedded Signup desde formmy.app

UI → conectar WhatsApp Business → flujo Meta. Al terminar:
- Se crea `Integration` con `channelId = <Channel.id>`, `token`, `phoneNumberId`, etc.
- `Channel.status` → `CONNECTED`
- Meta empieza a mandar webhooks

### 4. Primer mensaje del cliente final fluye automático

```
User en WhatsApp → Meta → POST formmy.app/api/v1/integrations/whatsapp/webhook
  → findIntegrationByPhoneNumber → channelId presente
  → handleChannelMessage → agent.dropletHost presente
  → POST http://64.23.167.64:3940/message con Bearer <shared-secret>
  → NanoClaw recibe, auto-provisiona groups/<jid>/ con containerConfig (o FORMMY_PUBLIC_TEMPLATE)
  → spawn container, Claude procesa con las tools del template
  → POST formmy.app/api/v1/integrations/whatsapp/send con integration_id + Bearer
  → Meta Graph API → WhatsApp del user
```

## Cambiar la configuración del agente (sin redeploy)

Brenda edita `Agent.containerConfig` en formmy.app DB con un JSON tipo:

```json
{
  "profile": "public",
  "mcpServers": ["nanoclaw", "kommo", "easybits"],
  "env": {
    "NANOCLAW_TOOLSETS": "messaging-public,scheduling-self,quote",
    "KOMMO_TOOLSETS": "read,create,scoped-mutate",
    "KOMMO_SCOPE_BY_JID": "1",
    "EASYBITS_TOOLSETS": "public-safe"
  },
  "allowedTools": [
    "Read", "Write", "Glob", "Grep",
    "mcp__easybits__upload_file",
    "mcp__easybits__create_share_link",
    "mcp__easybits__db_select",
    "mcp__nanoclaw__*",
    "mcp__kommo__*"
  ]
}
```

Esto es el contenido de `FORMMY_PUBLIC_TEMPLATE` — sirve como punto de partida si Brenda quiere overrides.

**Importante:** el config se aplica al **auto-provisionar el folder** del JID. Para grupos ya provisionados (mismo JID volviendo), el config NO se reaplica. Para "resetear" un end-user específico: borrar la fila de `registered_groups` donde `jid='formmy_<jid>'` en sofi-0 SQLite, el próximo mensaje re-provisiona con el config actual.

## Rotar el shared secret

```bash
# 1. Generar nuevo
NEW=$(openssl rand -hex 32)

# 2. Actualizar sofi-0
ssh root@64.23.167.64 "cd /home/nanoclaw/app && sed -i 's|^FORMMY_CHANNEL_SECRET=.*|FORMMY_CHANNEL_SECRET='$NEW'|' .env && systemctl restart nanoclaw"

# 3. Actualizar Agent.dropletApiToken en formmy.app DB al mismo valor

# 4. Refrescar backup local
echo "$NEW" > ~/.env-backups/sofi-0.formmy-shared-secret.txt
scp root@64.23.167.64:/home/nanoclaw/app/.env ~/.env-backups/sofi-0.env
```

## Verificar end-to-end después del primer mensaje

```bash
# Logs del canal en sofi-0
ssh root@64.23.167.64 'journalctl -u nanoclaw -f --no-pager | grep -i "formmy-whatsapp"'

# Mensaje persistido en SQLite
ssh root@64.23.167.64 'sqlite3 /home/nanoclaw/app/store/messages.db "SELECT timestamp, sender, substr(content,1,50) FROM messages WHERE chat_jid LIKE \"formmy_%\" ORDER BY timestamp DESC LIMIT 5;"'

# Grupo auto-provisionado
ssh root@64.23.167.64 'sqlite3 /home/nanoclaw/app/store/messages.db "SELECT folder, name, container_config FROM registered_groups WHERE jid LIKE \"formmy_%\";"'
```
