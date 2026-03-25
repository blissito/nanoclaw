# Formmy ↔ NanoClaw Bridge

Formmy actúa como proveedor de WhatsApp Business API oficial. NanoClaw procesa mensajes con Claude en containers. Se conectan por HTTP — sin tocar Baileys, sin cambiar pipelines existentes.

```
Cliente WhatsApp ↔ Meta Cloud API ↔ Formmy ↔ HTTP ↔ NanoClaw ↔ Claude (container)
```

## Flujo

1. Cliente manda mensaje por WhatsApp
2. Meta webhook llega a Formmy
3. Formmy ve que el chatbot tiene `externalAgentUrl` → forward a NanoClaw en vez de procesar
4. NanoClaw spawna container, Claude responde
5. NanoClaw POST respuesta (texto/imagen/sticker) a Formmy
6. Formmy envía a Meta Cloud API → cliente recibe

## Qué hacer en Formmy

### 1. Modelo de datos

Agregar a Integration o Chatbot:
```
externalAgentUrl    String?   // http://nanoclaw-host:3940
externalAgentSecret String?   // shared secret
```

### 2. Webhook forwarding

En `app/routes/api.v1.integrations.whatsapp.webhook.tsx`, antes del pipeline de IA:

```typescript
if (integration.externalAgentUrl) {
  await fetch(integration.externalAgentUrl + '/message', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${integration.externalAgentSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jid: `formmy_${senderPhone}`,
      sender: senderPhone,
      sender_name: contactName,
      content: messageText,
      message_id: waMessageId,
      media: mediaPayload || null,
    }),
  });
  return json({ status: 'forwarded' });
}
```

Si hay media (imagen/sticker/doc), descargar URL de Meta con `getMediaUrl(mediaId)` e incluirla en `media.url`.

### 3. Send endpoint

Implementar `app/routes/api.v1.integrations.whatsapp.send.ts` (actualmente mock):

```typescript
// Request de NanoClaw:
POST /api/v1/integrations/whatsapp/send
Authorization: Bearer {secret}
{
  phone_number: "5217712345678",
  integration_id: "id",
  type: "text" | "image" | "sticker" | "document",
  text: "...",
  media_url: "https://..." | null,
  media_base64: "..." | null,
  caption: "..." | null
}

// Formmy traduce a Meta Cloud API:
POST https://graph.facebook.com/v21.0/{phoneNumberId}/messages
Authorization: Bearer {accessToken}
{ messaging_product: "whatsapp", to: phone, type, [text|image|sticker]: {...} }
```

## Qué hacer en NanoClaw

### 1. Nuevo canal `src/channels/formmy-whatsapp.ts`

Basado en el webhook channel existente, pero con soporte de media:

```env
FORMMY_WHATSAPP_SECRET=shared-secret
FORMMY_WHATSAPP_CALLBACK_URL=https://formmy.app/api/v1/integrations/whatsapp/send
FORMMY_WHATSAPP_INTEGRATION_ID=integration-id-from-formmy
FORMMY_CHANNEL_PORT=3940
```

- **Recibe**: HTTP POST en `/message` (mismo formato que webhook channel)
- **Envía texto**: POST a callback URL con `type: "text"`
- **Envía imagen**: Lee archivo, convierte a base64 o sube a EasyBits, POST con `type: "image"`
- **Envía sticker**: Igual con `type: "sticker"`
- **JIDs**: `formmy_{phoneNumber}` (ej: `formmy_5217712345678`)
- **Se autoregistra** si las env vars existen

### 2. Media entrante

Cuando Formmy envía media URL en el payload, el canal descarga y guarda en el grupo:
- Imágenes → `attachments/img-{ts}.jpg`
- Stickers → `stickers/sticker-{ts}.webp`
- Documentos → `attachments/{filename}`

## Orden de implementación

| Paso | Proyecto | Qué |
|------|----------|-----|
| 1 | Formmy | Agregar `externalAgentUrl` al modelo |
| 2 | Formmy | Forward webhook si tiene externalAgentUrl |
| 3 | Formmy | Send endpoint real (texto + media via Meta API) |
| 4 | NanoClaw | Canal `formmy-whatsapp` con send/receive + media |
| 5 | Test | Conectar Mobilesco por WhatsApp Business API |
| 6 | Migrar | Mover clientes de Baileys a Business API |

## Archivos clave

**Formmy:**
- `app/routes/api.v1.integrations.whatsapp.webhook.tsx` — agregar forward
- `app/routes/api.v1.integrations.whatsapp.send.ts` — implementar send real
- `server/integrations/whatsapp/WhatsAppSDKService.ts` — funciones de media
- `prisma/schema.prisma` — campo externalAgentUrl

**NanoClaw:**
- `src/channels/formmy-whatsapp.ts` — canal nuevo (crear)
- `src/channels/index.ts` — importar canal
- `.env` — config vars
