-- Capa 0: métricas WABA con COEXISTENCIA (bot Sofi + operador humano).
-- Salida: UN objeto JSON. Correr:  sqlite3 /home/nanoclaw/app/store/messages.db < metrics.sql
-- Todo es de lectura (SELECT) — NO toca la DB.
--
-- Scope = chats WABA del cliente (channel 'formmy-whatsapp', 1:1). NO mezcla con grupos Baileys.
-- Para droplets Baileys, cambia el canal en la CTE `scope` a 'whatsapp'.
-- Ventana por defecto: últimos 30 días. Para otro rango, edita SOLO la CTE `p`.
--
-- COEXISTENCIA (clave): en formmy-whatsapp, las respuestas de Sofi NO se etiquetan
-- (is_bot_message siempre 0; todo saliente sale como sender_name='Operador'). La señal
-- fiable es `manual_mode`: =1 cuando Formmy marca que el operador HUMANO tomó la
-- conversación. Por eso el split es a nivel conversación y por PRESENCIA de intervención:
--   autónomas      = conversación SIN ningún mensaje manual_mode=1 (la manejó Sofi sola)
--   con_apoyo_humano = conversación con ≥1 manual_mode=1 (híbrida: Sofi + humano)
-- NO se puede medir "respondidas por el bot" ni "tiempo de respuesta del bot" desde esta DB.

WITH
p AS (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') AS start_ts),
scope AS (SELECT 'formmy-whatsapp' AS channel),

waba AS (
  SELECT jid FROM chats
  WHERE channel = (SELECT channel FROM scope) AND is_group = 0
    AND jid NOT LIKE 'formmy_audit%' AND jid NOT LIKE '%HEALTHCHECK%'
),

inb AS (  -- conversaciones con entrante en ventana
  SELECT DISTINCT m.chat_jid FROM messages m
  WHERE m.chat_jid IN (SELECT jid FROM waba)
    AND m.timestamp >= (SELECT start_ts FROM p) AND m.is_from_me = 0
),

oper AS (  -- conversaciones con intervención humana (manual_mode=1) en ventana
  SELECT DISTINCT m.chat_jid FROM messages m
  WHERE m.chat_jid IN (SELECT jid FROM waba)
    AND m.timestamp >= (SELECT start_ts FROM p) AND m.manual_mode = 1
),

peak AS (  -- bucket día/hora más activo (hora México, UTC-6) sobre entrantes
  SELECT strftime('%w', datetime(m.timestamp, '-6 hours')) AS dow,
         CAST(strftime('%H', datetime(m.timestamp, '-6 hours')) AS INTEGER) AS hr,
         COUNT(*) AS n
  FROM messages m
  WHERE m.chat_jid IN (SELECT jid FROM waba)
    AND m.timestamp >= (SELECT start_ts FROM p) AND m.is_from_me = 0
  GROUP BY dow, hr ORDER BY n DESC LIMIT 1
),

clientfolders AS (
  SELECT DISTINCT group_folder FROM formmy_jid_mapping WHERE jid IN (SELECT jid FROM waba)
),

consumo AS (  -- gasto estimado de modelos (equivalente API; NO factura real bajo plan Max)
  SELECT ROUND(SUM(total_cost_usd), 4) AS cost_usd,
         SUM(input_tokens) AS in_tok, SUM(output_tokens) AS out_tok,
         SUM(cache_read_input_tokens) AS cache_read_tok, SUM(num_turns) AS turns
  FROM usage_logs
  WHERE created_at >= (SELECT start_ts FROM p)
    AND (group_folder IN (SELECT group_folder FROM clientfolders)
         OR NOT EXISTS (SELECT 1 FROM clientfolders))
)

SELECT json_object(
  'ventana_inicio',  (SELECT start_ts FROM p),
  'generado',        datetime('now'),
  'conversaciones',  (SELECT COUNT(*) FROM inb),
  'con_apoyo_humano',(SELECT COUNT(*) FROM inb WHERE chat_jid IN (SELECT chat_jid FROM oper)),
  'autonomas',       (SELECT COUNT(*) FROM inb WHERE chat_jid NOT IN (SELECT chat_jid FROM oper)),
  'mensajes_in',     (SELECT COUNT(*) FROM messages WHERE chat_jid IN (SELECT jid FROM waba) AND timestamp >= (SELECT start_ts FROM p) AND is_from_me = 0),
  'mensajes_out',    (SELECT COUNT(*) FROM messages WHERE chat_jid IN (SELECT jid FROM waba) AND timestamp >= (SELECT start_ts FROM p) AND is_from_me = 1),
  'pico_dow',        (SELECT dow FROM peak),
  'pico_hora',       (SELECT hr FROM peak),
  'consumo',         (SELECT json_object('cost_usd', cost_usd, 'in_tok', in_tok, 'out_tok', out_tok,
                                         'cache_read_tok', cache_read_tok, 'turns', turns) FROM consumo)
);
