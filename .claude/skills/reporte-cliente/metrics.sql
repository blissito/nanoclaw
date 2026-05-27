-- Capa 0: métricas de conversaciones del cliente en una ventana de tiempo.
-- Salida: UN objeto JSON. Correr:  sqlite3 /home/nanoclaw/app/store/messages.db < metrics.sql
-- Todo es de lectura (SELECT) — NO toca la DB.
--
-- Scope = chats WABA del cliente (channel 'formmy-whatsapp', 1:1). NO mezcla con grupos Baileys.
-- Para droplets Baileys, cambia el canal en la CTE `scope` a 'whatsapp'.
-- Ventana por defecto: últimos 30 días. Para otro rango, edita SOLO la CTE `p`.
--
-- Nota de semántica (canal formmy-whatsapp en sofi-0): is_bot_message siempre 0 y
-- manual_mode es ubicuo, así que NO son señal fiable de bot/escalamiento. La única
-- señal portable es is_from_me (0=entrante cliente, 1=saliente respuesta). Por eso
-- el reporte mide volumen + capacidad de respuesta, no automatización.

WITH
p AS (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') AS start_ts),
scope AS (SELECT 'formmy-whatsapp' AS channel),

waba AS (  -- chats del cliente (excluye probes/healthchecks)
  SELECT jid FROM chats
  WHERE channel = (SELECT channel FROM scope) AND is_group = 0
    AND jid NOT LIKE 'formmy_audit%' AND jid NOT LIKE '%HEALTHCHECK%'
),

inb AS (  -- entrantes del cliente en ventana
  SELECT m.chat_jid, m.timestamp FROM messages m
  WHERE m.chat_jid IN (SELECT jid FROM waba)
    AND m.timestamp >= (SELECT start_ts FROM p) AND m.is_from_me = 0
),

outb AS (  -- salientes (respuestas) en ventana
  SELECT m.chat_jid, m.timestamp FROM messages m
  WHERE m.chat_jid IN (SELECT jid FROM waba)
    AND m.timestamp >= (SELECT start_ts FROM p) AND m.is_from_me = 1
),

firstin AS (SELECT chat_jid, MIN(timestamp) AS t0 FROM inb GROUP BY chat_jid),

frt AS (  -- segundos hasta la primera respuesta saliente tras el primer entrante
  SELECT f.chat_jid,
    (julianday((SELECT MIN(o.timestamp) FROM outb o
                WHERE o.chat_jid = f.chat_jid AND o.timestamp >= f.t0))
     - julianday(f.t0)) * 86400.0 AS secs
  FROM firstin f
),

frt_ok AS (SELECT secs FROM frt WHERE secs IS NOT NULL AND secs >= 0 ORDER BY secs),

newchats AS (  -- chats cuyo primer mensaje histórico cae en la ventana
  SELECT w.jid FROM waba w
  WHERE (SELECT MIN(timestamp) FROM messages m WHERE m.chat_jid = w.jid) >= (SELECT start_ts FROM p)
    AND w.jid IN (SELECT chat_jid FROM inb)
),

peak AS (  -- bucket día/hora más activo (hora México, UTC-6)
  SELECT strftime('%w', datetime(timestamp, '-6 hours')) AS dow,
         CAST(strftime('%H', datetime(timestamp, '-6 hours')) AS INTEGER) AS hr,
         COUNT(*) AS n
  FROM inb GROUP BY dow, hr ORDER BY n DESC LIMIT 1
),

clientfolders AS (  -- folders de usage_logs que pertenecen a estos chats
  SELECT DISTINCT group_folder FROM formmy_jid_mapping WHERE jid IN (SELECT jid FROM waba)
),

consumo AS (  -- gasto total de modelos del cliente (BYOK)
  SELECT ROUND(SUM(total_cost_usd), 4) AS cost_usd,
         SUM(input_tokens) AS in_tok, SUM(output_tokens) AS out_tok,
         SUM(cache_read_input_tokens) AS cache_read_tok, SUM(num_turns) AS turns
  FROM usage_logs
  WHERE created_at >= (SELECT start_ts FROM p)
    AND (group_folder IN (SELECT group_folder FROM clientfolders)
         OR NOT EXISTS (SELECT 1 FROM clientfolders))  -- fallback Baileys: suma todo
)

SELECT json_object(
  'ventana_inicio', (SELECT start_ts FROM p),
  'generado',       datetime('now'),
  'conversaciones', (SELECT COUNT(DISTINCT chat_jid) FROM inb),
  'conversaciones_nuevas', (SELECT COUNT(*) FROM newchats),
  'mensajes_in',    (SELECT COUNT(*) FROM inb),
  'mensajes_out',   (SELECT COUNT(*) FROM outb),
  'respondidas',    (SELECT COUNT(DISTINCT chat_jid) FROM inb WHERE chat_jid IN (SELECT chat_jid FROM outb)),
  'primera_respuesta_p50_seg',
                    (SELECT ROUND(secs) FROM frt_ok LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM frt_ok)),
  'pico_dow',       (SELECT dow FROM peak),
  'pico_hora',      (SELECT hr FROM peak),
  'consumo',        (SELECT json_object('cost_usd', cost_usd, 'in_tok', in_tok, 'out_tok', out_tok,
                                        'cache_read_tok', cache_read_tok, 'turns', turns) FROM consumo)
);
