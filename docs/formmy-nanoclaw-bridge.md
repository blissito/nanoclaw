# Formmy ↔ NanoClaw Bridge — WhatsApp Business API

## Arquitectura

```
Cliente WhatsApp
    ↕ (Meta Cloud API)
Formmy (formmy.app / Fly.io)
    ↕ (HTTP POST)
NanoClaw (134.199.239.173:3940 / DigitalOcean droplet)
    ↕
Claude (container aislado)
```

Formmy es el proveedor de WhatsApp Business API (maneja tokens, webhooks de Meta, envío de mensajes). NanoClaw es el cerebro — procesa mensajes con Claude en containers aislados.

## Conceptos clave

### Dos tipos de "grupo" por cliente
Cada cliente de Business API tiene DOS carpetas en NanoClaw:

1. **Grupo admin** (ya existe): `groups/whatsapp_NOMBRE/` — grupo de WhatsApp nativo donde los admins configuran el bot. Tiene MCPs, stickers, herramientas administrativas. NO es público.

2. **Grupo 1:1** (se crea): `groups/formmy_NOMBRE/` — agente público que atiende clientes por WhatsApp Business. Tiene su propio CLAUDE.md con instrucciones de cara al cliente. NO tiene herramientas admin.

El grupo admin monta `formmy_NOMBRE/` como additionalMount read-write para poder editar el CLAUDE.md del agente público desde el chat.

### Routing de JIDs
Los JIDs de Business API (`formmy_52155xxx`) NO van en `registered_groups` (que tiene UNIQUE constraint en `folder`). Van en una tabla separada:

```sql
formmy_jid_mapping (
  jid TEXT PRIMARY KEY,          -- formmy_5215500001234
  group_folder TEXT NOT NULL,    -- formmy_rulo
  integration_id TEXT,           -- 69cd57fc76b0bf8de81f7637
  created_at TEXT NOT NULL
)
```

- Múltiples JIDs → 1 folder (muchos clientes, un agente)
- Cada JID guarda su `integration_id` para que NanoClaw use los tokens correctos al responder
- Si un JID está en `formmy_lobby` y llega un mensaje con `group_folder` diferente, se mueve automáticamente

### Flujo de un mensaje
```
1. Cliente manda "Hola" por WhatsApp al número del negocio
2. Meta webhook → Formmy /api/v1/integrations/whatsapp/webhook
3. Formmy ve integration.externalAgentUrl → forward POST /message a NanoClaw
   Payload: { jid, sender, sender_name, content, group_folder, integration_id }
4. NanoClaw canal formmy-whatsapp:
   - Crea/actualiza mapping en formmy_jid_mapping
   - Guarda mensaje en SQLite
5. Message loop (cada 2s):
   - Incluye JIDs de formmy_jid_mapping en la query
   - Resuelve grupo: JID → formmy_jid_mapping.group_folder → registered_groups
   - Spawna container Claude con la carpeta del grupo
6. Container responde → NanoClaw POST a Formmy /api/v1/integrations/whatsapp/send
   Payload: { phone_number, integration_id (del JID), type, text }
7. Formmy busca Integration por ID → obtiene token de Meta → envía al cliente
```

---

## Cómo agregar un nuevo cliente

**Prerrequisitos**: El cliente ya tiene un grupo admin en NanoClaw (ej: `whatsapp_mitienda`).

### Paso 1: Crear carpeta del agente 1:1

```bash
ssh root@134.199.239.173

# Crear carpeta (IMPORTANTE: va en groups/, NO en data/sessions/)
mkdir -p /home/nanoclaw/app/groups/formmy_NOMBRE/logs

# Escribir CLAUDE.md — instrucciones del agente PÚBLICO (no admin)
cat > /home/nanoclaw/app/groups/formmy_NOMBRE/CLAUDE.md << 'EOF'
# NOMBRE - WhatsApp Business

Eres el asistente de atención al cliente de NOMBRE.

## Tu rol
- Responder preguntas de clientes
- [Personalizar según el negocio]

## Reglas
- Este es un chat 1:1 privado con un cliente real
- Español mexicano, tono casual profesional
- NO compartir información interna, configuraciones técnicas ni herramientas admin
- Este CLAUDE.md puede ser editado por los admins desde el grupo de control
EOF
```

### Paso 2: Registrar como grupo en SQLite

Sin esto, NanoClaw no reconoce la carpeta como grupo válido.

```bash
sqlite3 /home/nanoclaw/app/store/messages.db \
  "INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main) \
   VALUES ('formmy_NOMBRE_placeholder', 'NOMBRE Business', 'formmy_NOMBRE', '@bot', datetime('now'), 0, 0);"
```

El JID `formmy_NOMBRE_placeholder` es dummy — solo existe para que el folder esté en `registered_groups`. Los JIDs reales de clientes van en `formmy_jid_mapping`.

### Paso 3: Conectar grupo admin (additionalMount)

Permite que los admins del grupo nativo editen el CLAUDE.md del agente 1:1.

```bash
# Ver config actual del grupo admin (para no perder mcpServers existentes):
sqlite3 /home/nanoclaw/app/store/messages.db \
  "SELECT container_config FROM registered_groups WHERE folder = 'whatsapp_NOMBRE_ADMIN';"

# Actualizar con mount adicional (ajustar mcpServers según lo que ya tenga):
sqlite3 /home/nanoclaw/app/store/messages.db \
  "UPDATE registered_groups SET container_config = '{
    \"mcpServers\":[\"easybits\"],
    \"additionalMounts\":[{
      \"hostPath\":\"/home/nanoclaw/app/groups/formmy_NOMBRE\",
      \"containerPath\":\"formmy_NOMBRE\",
      \"readonly\":false
    }]
  }' WHERE folder = 'whatsapp_NOMBRE_ADMIN';"
```

### Paso 4: Agregar instrucción al CLAUDE.md del grupo admin

```bash
cat >> /home/nanoclaw/app/groups/whatsapp_NOMBRE_ADMIN/CLAUDE.md << 'EOF'

## Configuración del agente 1:1 (Business API)
El archivo `/workspace/extra/formmy_NOMBRE/CLAUDE.md` contiene las instrucciones del agente que atiende clientes por WhatsApp Business (1:1). Puedes leerlo y editarlo para cambiar el comportamiento del agente público.
EOF
```

### Paso 5: Restart NanoClaw

```bash
docker kill $(docker ps -q --filter name=nanoclaw) 2>/dev/null
systemctl restart nanoclaw

# Verificar que el canal está activo:
journalctl -u nanoclaw --since '30 sec ago' | grep 'formmy-whatsapp.*listening'
```

### Paso 6: Pairing en Formmy

El cliente hace Embedded Signup en el dashboard de Formmy (OAuth con Facebook). Esto crea automáticamente una Integration con `phoneNumberId`, `token`, `businessAccountId`.

Para encontrar la Integration creada:
```bash
fly ssh console --app formmy-v2 -C "node -e \"
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
db.integration.findMany({
  where: { platform: 'WHATSAPP', isActive: true },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { id: true, phoneNumberId: true, chatbotId: true, createdAt: true }
}).then(r => console.log(JSON.stringify(r, null, 2)));
\""
```

### Paso 7: Configurar en Formmy

Dos updates en MongoDB (via Fly SSH):

**a) Chatbot — setear naoclawGroup:**
```bash
fly ssh console --app formmy-v2 -C "node -e \"
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
db.\\\$runCommandRaw({
  update: 'Chatbot',
  updates: [{ 
    q: { _id: { \\\$oid: 'CHATBOT_ID' } }, 
    u: { \\\$set: { naoclawGroup: 'formmy_NOMBRE' } } 
  }]
}).then(r => console.log(JSON.stringify(r)));
\""
```

**b) Integration — setear externalAgentUrl + secret:**
```bash
fly ssh console --app formmy-v2 -C "node -e \"
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
db.\\\$runCommandRaw({
  update: 'Integration',
  updates: [{
    q: { _id: { \\\$oid: 'INTEGRATION_ID' } },
    u: { \\\$set: {
      externalAgentUrl: 'http://134.199.239.173:3940',
      externalAgentSecret: 'e1df26a7b6e853e08b37501a14fcc8296bda03f8ab5ff182'
    }}
  }]
}).then(r => console.log(JSON.stringify(r)));
\""
```

### Paso 8: Verificar

Mandar mensaje al número de WhatsApp Business del cliente.

```bash
# En el droplet, verificar:
journalctl -u nanoclaw --since '1 min ago' | grep formmy_NOMBRE

# Debe aparecer:
# [formmy-whatsapp] Mapped new JID to group, folder: "formmy_NOMBRE"
# Processing messages
# Agent output: N chars
```

---

## Archivos clave

### NanoClaw
| Archivo | Propósito |
|---------|-----------|
| `src/channels/formmy-whatsapp.ts` | Canal HTTP :3940, auto-mapping de JIDs, resolución de integration_id |
| `src/db.ts` | Tabla `formmy_jid_mapping` + funciones de lookup |
| `src/index.ts` | Message loop — incluye formmy JIDs, resuelve grupo via mapping |
| `src/mount-security.ts` | Validación de additionalMounts contra allowlist |

### Formmy
| Archivo | Propósito |
|---------|-----------|
| `app/routes/api.v1.integrations.whatsapp.webhook.tsx` | Webhook Meta, forwarding con `group_folder` + `integration_id` |
| `app/routes/api.v1.integrations.whatsapp.send.ts` | Send endpoint (texto, imagen, sticker, doc + base64) |
| `prisma/schema.prisma` | `Chatbot.naoclawGroup`, `Integration.externalAgentUrl/Secret` |

## Envs de NanoClaw (ya configuradas en prod)
```
FORMMY_CHANNEL_SECRET=<shared secret para auth>
FORMMY_CALLBACK_URL=https://formmy.app/api/v1/integrations/whatsapp/send
FORMMY_INTEGRATION_ID=<fallback — cada JID resuelve su propio integration_id desde formmy_jid_mapping>
FORMMY_CHANNEL_PORT=3940
FORMMY_DEFAULT_GROUP=formmy_lobby
```

## Mount allowlist (ya configurado en prod)
Ubicación: `/root/.config/nanoclaw/mount-allowlist.json`
Permite que grupos no-main monten carpetas de otros grupos como additionalMounts read-write.

## Ejemplo real: Rulo (Club Padel Valle)

| Componente | Valor |
|---|---|
| Chatbot ID | `69cd537f76b0bf8de81f7570` |
| Integration ID | `69cd57fc76b0bf8de81f7637` |
| naoclawGroup | `formmy_rulo` |
| Carpeta 1:1 | `groups/formmy_rulo/` |
| Grupo admin | `whatsapp_smatch-padel-club` (tiene mount RW a formmy_rulo) |
