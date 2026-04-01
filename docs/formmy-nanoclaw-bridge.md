# Formmy ↔ NanoClaw Bridge

Formmy actúa como proveedor de WhatsApp Business API oficial. NanoClaw procesa mensajes con Claude en containers. Se conectan por HTTP.

```
Cliente WhatsApp ↔ Meta Cloud API ↔ Formmy ↔ HTTP ↔ NanoClaw ↔ Claude (container)
```

## Cómo agregar un nuevo cliente de Business API

### 1. Crear carpeta del agente en NanoClaw
```bash
# En el droplet
mkdir -p groups/formmy_NOMBRE/logs
cat > groups/formmy_NOMBRE/CLAUDE.md << 'EOF'
# NOMBRE - Agente WhatsApp Business
Instrucciones del agente público aquí...
EOF

# Registrar en SQLite
sqlite3 store/messages.db \
  "INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main) \
   VALUES ('formmy_NOMBRE_placeholder', 'NOMBRE Business', 'formmy_NOMBRE', '@bot', datetime('now'), 0, 0);"
```

### 2. En Formmy (lo hace el otro equipo)
- El cliente hace pairing (Embedded Signup) → se crea Integration
- Configurar `chatbot.naoclawGroup = "formmy_NOMBRE"` en Mongo
- Configurar `integration.externalAgentUrl = "http://134.199.239.173:3940"` + `externalAgentSecret`

### 3. Conectar grupo admin (para que admins editen el CLAUDE.md del 1:1)
```sql
-- Agregar mount al containerConfig del grupo admin
UPDATE registered_groups SET container_config = json('{
  "mcpServers":["easybits"],
  "additionalMounts":[{
    "hostPath":"/home/nanoclaw/app/groups/formmy_NOMBRE",
    "containerPath":"formmy_NOMBRE",
    "readonly":false
  }]
}') WHERE folder = 'GRUPO_ADMIN_FOLDER';
```

Agregar al CLAUDE.md del grupo admin:
```markdown
## Configuración del agente 1:1
El archivo `/workspace/extra/formmy_NOMBRE/CLAUDE.md` contiene las instrucciones del agente 1:1.
```

Restart: `systemctl restart nanoclaw`

## Cómo funciona el routing

### Tabla formmy_jid_mapping
Los JIDs de Business API (`formmy_*`) NO van en `registered_groups` (tiene UNIQUE en folder). Van en tabla separada:

```sql
CREATE TABLE formmy_jid_mapping (
  jid TEXT PRIMARY KEY,       -- formmy_5215500001234
  group_folder TEXT NOT NULL, -- formmy_rulo
  created_at TEXT NOT NULL
);
```

### Flujo del canal formmy-whatsapp
1. Formmy envía `POST /message` con `{ jid, sender, content, group_folder }`
2. Si el JID no tiene mapping → INSERT en `formmy_jid_mapping`
3. Si el JID ya tiene mapping pero `group_folder` cambió → UPDATE (auto-move de lobby)
4. Resuelve el grupo buscando en `registered_groups` por folder

### Message loop (index.ts)
1. Incluye JIDs de `formmy_jid_mapping` en la query de mensajes nuevos
2. Resuelve grupo: primero busca en `registeredGroups`, si no, busca folder en `formmy_jid_mapping` → lookup en `registeredGroups`

## Envs necesarias
```
FORMMY_CHANNEL_SECRET=<shared secret>
FORMMY_CALLBACK_URL=https://formmy.app/api/v1/integrations/whatsapp/send
FORMMY_INTEGRATION_ID=<integration id>
FORMMY_CHANNEL_PORT=3940
FORMMY_DEFAULT_GROUP=formmy_lobby
```

## Mount Allowlist
Ubicación: `/root/.config/nanoclaw/mount-allowlist.json`
Necesario para que grupos admin puedan montar carpetas de otros grupos como additionalMounts.

## Archivos clave
| Archivo | Propósito |
|---------|-----------|
| `src/channels/formmy-whatsapp.ts` | Canal HTTP, auto-mapping |
| `src/db.ts` | formmy_jid_mapping tabla |
| `src/index.ts` | Message loop con resolución de formmy JIDs |
| `src/mount-security.ts` | Validación de additionalMounts |

## Ejemplo real: Rulo (Padel Club)
- Carpeta 1:1: `formmy_rulo/`
- Grupo admin: `whatsapp_smatch-padel-club/`
- El admin tiene mount de `formmy_rulo/` → puede editar CLAUDE.md desde el grupo
- `chatbot.naoclawGroup = "formmy_rulo"` en Formmy
