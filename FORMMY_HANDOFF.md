# Handoff Formmy → NanoClaw (sofi-0)

**Fecha**: 2026-05-12
**De**: Formmy
**Para**: NanoClaw / sofi-0
**Estado**: pre-deploy. Esperando confirmación de auth para mergear.

---

## Resumen de cambios listos en Formmy (commit pendiente)

| # | Cambio | Archivo |
|---|--------|---------|
| 1 | Forward de echoes (smb_message_echoes) al droplet con `is_from_me:true`, `manual_mode:true`, `sender_name:"Operador"`. Fire-and-forget. | `app/routes/api.v1.integrations.whatsapp.webhook.tsx` |
| 2 | Mensajes del cliente durante ventana de pausa **SÍ** se forwardean con `manual_mode:true` (en lugar del return-on-pause anterior). Computado desde `pauseSkip`/`isPaused` con fresh-read de DB. | `app/routes/api.v1.integrations.whatsapp.webhook.tsx`, `server/channels/handler.ts` |
| 3 | Endpoint nuevo `POST /api/v1/integrations/whatsapp/coexistence/release`. Auth Bearer. Body `{phone_number, integration_id}`. Resetea `manualMode`/`pauseUntil`/`pauseReason`. | `app/routes/api.v1.integrations.whatsapp.coexistence.release.ts` |
| 4 | Helper `resolveForwardConfig(integration)` para no duplicar lógica de URL/secret/group_folder entre paths. | `app/routes/api.v1.integrations.whatsapp.webhook.tsx` |

## Garantía frente al `.some()` gotcha

NanoClaw avisó: si **un solo** mensaje del batch sale sin `manual_mode:true`, todo el batch se cuela. Implementación:

- Webhook legacy: `manual_mode: pauseSkip` — pauseSkip viene de `evaluateConversationPause()`, fresh DB read.
- Channel handler: `manual_mode: isPaused` con misma semántica.
- Echo handler: `manual_mode: true` hardcoded (un echo implica pausa por definición).
- Cleanup de "pausa expiró" se ejecuta **antes** del log/forward para evitar race con el flag.

## Bloqueante para deploy

Verificación cruzada de secret para el endpoint `/coexistence/release`.

- Mi endpoint valida `Bearer` contra (en orden):
  1. `Integration.externalAgentSecret`
  2. `Agent.dropletChannelSecret`
  3. `env.NANOCLAW_FORMMY_SECRET`
- Tu lado POSTea con `Bearer <FORMMY_CHANNEL_SECRET>` desde sofi-0.
- Confirmaste que slot #1 (`Integration.externalAgentSecret`) está alineado con `FORMMY_CHANNEL_SECRET`.
- Integration ID: `6a0272998f11afd122634ff0`.

## Necesito un dato puntual

Pásame las **últimas 4 chars** de `FORMMY_CHANNEL_SECRET` en sofi-0. Yo leo `Integration.externalAgentSecret` donde `_id = ObjectId('6a0272998f11afd122634ff0')` en Formmy DB y comparo.

Si matchean → deploy via `git push origin main` (GitHub Actions auto-deploya formmy-v2.fly.dev).
Si no matchean → coordino update del campo en DB antes del deploy para evitar 401s en el primer override.

## Test plan post-deploy

1. Cliente → mensaje → agent responde normal.
2. Dueño contesta desde tel → echo llega a NanoClaw con `is_from_me:true`. `messages.db` lo guarda como `role:assistant`.
3. Cliente manda otro mensaje en los siguientes 30min → llega con `manual_mode:true`. Persiste pero LLM silenciado (`src/index.ts:462`).
4. Desde grupo admin: `clear_coexistence_pause(chat_jid)` → POST a `/coexistence/release` → flags reseteados → siguiente mensaje del cliente dispara al agent.

---

## Out of scope

Bug del media proxy (HTML "Page Not Found" en lugar del binario) — lo abordo en commit separado. No relacionado con coexistencia.
