# Formmy Channel Integration (WhatsApp Business API)

## Objetivo

Usar Formmy como proveedor de WhatsApp Business API oficial para NanoClaw. Formmy ya tiene la integración con Meta Cloud API — NanoClaw se conecta como un canal más, sin tocar Baileys.

## Arquitectura

```
Cliente WhatsApp
    ↕ (WhatsApp Business API / Meta Cloud API)
Formmy (formmy.app)
    ↕ (HTTP webhooks)
NanoClaw (canal formmy-whatsapp)
    ↕
Container agent (Claude)
```

## Flujo de Mensajes

### Entrante (cliente → agente)

1. Cliente manda mensaje por WhatsApp
2. Meta envía webhook a Formmy: `POST /api/v1/integrations/whatsapp/webhook`
3. Formmy reenvía a NanoClaw: `POST http://nanoclaw:3940/message` (nuevo endpoint o reusar webhook channel)
4. NanoClaw procesa, spawna container, agente responde

### Saliente (agente → cliente)

1. Agente responde vía IPC
2. NanoClaw envía a Formmy: `POST /api/v1/integrations/whatsapp/send`
3. Formmy envía a Meta Cloud API: `POST https://graph.facebook.com/v21.0/{phoneNumberId}/messages`
4. Cliente recibe en WhatsApp

## Implementación (Canal NanoClaw)

### Opción recomendada: Canal `formmy-whatsapp`

Nuevo archivo `src/channels/formmy-whatsapp.ts` que:

1. **Recibe mensajes** — HTTP server (como webhook channel) escuchando en `FORMMY_CHANNEL_PORT`
2. **Envía texto** — POST a Formmy send endpoint
3. **Envía media** — POST con image/sticker/document/audio a Formmy (requiere endpoint de media en Formmy)
4. **Se autoregistra** si `FORMMY_WHATSAPP_SECRET` está en .env

### Env vars necesarias

```env
FORMMY_WHATSAPP_SECRET=shared-secret-for-auth
FORMMY_WHATSAPP_CALLBACK_URL=https://formmy.app/api/v1/integrations/whatsapp/send
FORMMY_WHATSAPP_PHONE_NUMBER_ID=from-meta-dashboard
FORMMY_CHANNEL_PORT=3940
```

### JID Convention

- JIDs: `formmy_{phoneNumber}` (ej: `formmy_5217712345678`)
- ownsJid: `jid.startsWith('formmy_')`

### Payload que Formmy debe enviar a NanoClaw

```json
{
  "jid": "formmy_5217712345678",
  "sender": "5217712345678",
  "sender_name": "Juan Pérez",
  "content": "Hola, busco sillas para mi escuela",
  "message_id": "wamid.xxxxx",
  "media": {
    "type": "image|sticker|document|audio",
    "url": "https://formmy.app/media/xxxxx",
    "mime_type": "image/jpeg",
    "filename": "foto.jpg"
  }
}
```

### Payload que NanoClaw envía a Formmy

```json
{
  "jid": "formmy_5217712345678",
  "phone_number": "5217712345678",
  "type": "text|image|sticker|document",
  "text": "mensaje de respuesta",
  "media_path": "/path/to/file",
  "media_base64": "base64-encoded-content",
  "integration_id": "formmy-integration-id"
}
```

## Qué necesita Formmy

1. **Webhook forwarding** — Cuando llega un mensaje de WhatsApp para un chatbot conectado a NanoClaw, reenviar a NanoClaw en vez de procesar internamente
2. **Send endpoint con media** — El endpoint `/api/v1/integrations/whatsapp/send` necesita soportar imágenes, stickers, documentos (actualmente es mock/solo texto)
3. **Configuración por chatbot** — Flag para indicar que un chatbot usa NanoClaw como backend en vez del pipeline interno de Formmy

## Diferencias con el webhook channel genérico

| Aspecto | Webhook genérico | Formmy WhatsApp |
|---------|-----------------|-----------------|
| Media | Solo texto | Texto + imagen + sticker + documento + audio |
| JID format | `webhook_*` | `formmy_*` |
| Auth | Bearer token | Bearer token + integration ID |
| Groups | No (1:1 only) | No (1:1 por número) |
| Typing | No | Posible (Meta soporta) |
| Read receipts | No | Posible (Meta soporta) |

## Orden de implementación

1. **Formmy**: Endpoint de forwarding de webhooks a URL externa (configurable por chatbot)
2. **Formmy**: Endpoint de send con soporte de media (imagen, sticker, documento)
3. **NanoClaw**: Canal `formmy-whatsapp` con send/receive + media
4. **Test**: Conectar chatbot de Mobilesco por WhatsApp Business API
5. **Migrar**: Mover clientes de Baileys a WhatsApp Business API gradualmente
