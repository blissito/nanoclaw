#!/usr/bin/env bash
#
# judge-day.sh — LLM-as-judge daily review of Sofi conversations.
#
# Designed for the current stage (3-5 clients, ~30 chats/day per droplet):
# one API call, markdown summary, actionable. Skips per-chat statistical
# rigor — too few chats per day for rates to be meaningful, and pattern
# detection across the whole day is what actually drives prompt fixes.
#
# Pipeline:
#   1. eval-day.sh produces the transcripts (reused, no duplicate SQL).
#   2. Wrap them with an evaluation system prompt.
#   3. One call to Sonnet/Haiku via the Anthropic API.
#   4. Print the markdown response to stdout.
#
# The system prompt asks for:
#   - One-paragraph executive summary
#   - Outcome counts (closed sale / quoted pending / ghosted / error / other)
#   - Top 3 issues with one example each + concrete fix suggestion
#   - Top 3 wins (so we know what's working)
#   - "If I could only change one thing in Sofi's prompt tomorrow…"
#
# Usage:
#   bash scripts/judge-day.sh                      # today, Sonnet 4.6
#   bash scripts/judge-day.sh 2026-05-12           # specific date
#   JUDGE_MODEL=claude-haiku-4-5-20251001 bash scripts/judge-day.sh
#
#   ssh -A root@<ip> 'bash /home/nanoclaw/app/scripts/judge-day.sh' | tee review.md
#
# Env vars:
#   ANTHROPIC_API_KEY  required. Read from /home/nanoclaw/app/.env if unset.
#   JUDGE_MODEL        default claude-sonnet-4-20250514 (~$3/M input).
#                      Override with claude-haiku-4-5-20251001 for ~$0.80/M.
#   MIN_MSGS           passed to eval-day.sh (default 4 — skip greetings).
#   MAX_INPUT_TOKENS   safety cap on transcript size (default 150000).
#                      If exceeded, the script truncates oldest chats first.
#   NANOCLAW_DB        sqlite path (default /home/nanoclaw/app/store/messages.db)
#
# Output:
#   stdout — markdown report. Pipe to less, save to file, send by email.
#
# Cost estimate (per day, sofi-0-sized droplet, ~30 chats):
#   Sonnet 4.6:  ~$0.15-0.30
#   Haiku 4.5:   ~$0.03-0.08
#
# Exit codes:
#   0  → got a response
#   1  → missing API key or DB / eval-day.sh
#   2  → API error (body printed to stderr)
#
# Future (per-client mode): when one droplet hosts >1 client, add
# CHAT_FILTER scoping and run once per client folder. For now sofi-0 is
# 1 client → 1 report.

set -euo pipefail

DATE="${1:-$(date +%Y-%m-%d)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EVAL_SCRIPT="$SCRIPT_DIR/eval-day.sh"
MODEL="${JUDGE_MODEL:-claude-sonnet-4-20250514}"
MAX_INPUT_TOKENS="${MAX_INPUT_TOKENS:-150000}"

if [ ! -x "$EVAL_SCRIPT" ]; then
  echo "eval-day.sh not found or not executable: $EVAL_SCRIPT" >&2
  exit 1
fi

# Resolve API key from env or .env file
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f /home/nanoclaw/app/.env ]; then
  ANTHROPIC_API_KEY="$(grep -E '^ANTHROPIC_API_KEY=' /home/nanoclaw/app/.env | head -1 | cut -d= -f2- | tr -d '"')"
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY not set and not found in /home/nanoclaw/app/.env" >&2
  exit 1
fi

# Pull transcripts via eval-day.sh. Use a high MIN_MSGS to skip 1-shot
# greetings ("buenas tardes" → bot replies → silence) which add noise
# without signal.
TRANSCRIPT="$(MIN_MSGS="${MIN_MSGS:-4}" bash "$EVAL_SCRIPT" "$DATE")"
TRANSCRIPT_BYTES="${#TRANSCRIPT}"

# Rough token estimate (Spanish ~ 3.5 chars/token). Cap at MAX_INPUT_TOKENS.
EST_TOKENS=$(( TRANSCRIPT_BYTES / 3 ))
if [ "$EST_TOKENS" -gt "$MAX_INPUT_TOKENS" ]; then
  echo "# WARNING: transcript ~$EST_TOKENS tokens > cap $MAX_INPUT_TOKENS — truncating to last $MAX_INPUT_TOKENS tokens worth" >&2
  KEEP_BYTES=$(( MAX_INPUT_TOKENS * 3 ))
  TRANSCRIPT="${TRANSCRIPT: -$KEEP_BYTES}"
fi

SYSTEM_PROMPT='Eres un evaluador externo de conversaciones de Sofi, asesora de ventas IA de SIIQTEC (México, ventas de productos químicos/limpieza B2B y B2C vía WhatsApp). Recibes el dump del día y devuelves un informe accionable en Markdown.

Contexto importante:
- Sofi NO debe decir "lead" al cliente (vocabulario interno Kommo). Decir "pedido" o "cotización".
- Sofi NO debe narrar después de send_message ("Le envié al cliente la foto…"). Hay un filtro que la atrapa pero auditamos falsos negativos.
- Flujo SNAP: 1 pregunta de contexto → cotiza → recolecta los 4 datos (nombre, tel, dirección completa, decisión de envío) → genera PDF con `siiqtec_quote_pdf` → manda PDF + audio de cierre → crea/actualiza lead en Kommo.
- Hay mayoreo: `precio_2` desde N piezas, `precio_3` desde M. Si calcula con `precio_publico_directo` cuando aplica mayoreo, es bug grave.
- Rutas propias SIIQTEC (Hidalgo) = envío gratis; paquetería con Skydropx para resto.

Estructura del informe (Markdown, en español mexicano, conciso):

# 📊 Resumen ejecutivo
Un párrafo de 3-4 líneas: cuántos chats, cómo se sintió el día, señal principal.

# 🎯 Outcomes
| outcome | count |
| --- | --- |
| Cotización entregada (pendiente pago) | N |
| Venta cerrada (cliente confirmó pago) | N |
| Greeting + sin contexto comercial | N |
| Cliente ghosted después de respuesta de Sofi | N |
| Escalación a humano | N |
| Error técnico / falla de tool | N |
| Otro | N |

Importante: si no estás seguro de un outcome, ponlo en "Otro". No infles "ventas cerradas".

# 🔥 Top 3 problemas detectados
Para cada uno: nombre corto, chat-ejemplo (teléfono + 1-2 líneas de evidencia), causa probable, fix concreto (PROMPT / DATA / MCP / OTHER). NO inventes; cita textualmente del transcript.

# ✅ Top 3 wins
Cosas que Sofi hizo bien (manejo de objeción, upsell, recovery, tono). Útil para no romper lo que funciona.

# 🛠 Si pudiera cambiar UNA cosa del prompt mañana
Una recomendación concreta + ejemplo de cómo se vería el cambio (1-2 líneas).

# 📈 Métricas operacionales sueltas
- Tasa de cotizaciones generadas vs chats con intención comercial
- Tools que fallaron (nombre + cuántas veces)
- Chats con "esperando bot" >15 min (si los hay)

Reglas:
- Sé honesto: si el día fue malo, dilo. Si fue mediocre, no lo infles.
- Si un chat tiene 1-2 mensajes y nada más, NO cuenta como caso de estudio.
- Si detectas narración leak (3a persona del cliente o "registrado en Kommo" en mensaje al cliente), márcalo como issue CRÍTICO.
- Si Sofi dice "lead" al cliente, márcalo como issue MAYOR (cliente firmó regla custom).
- No uses emojis fuera de los encabezados.
- Tope 1500 palabras.'

USER_PROMPT="Dump del día $DATE para evaluación:

$TRANSCRIPT"

# Build request body via jq (escapes JSON correctly)
BODY="$(jq -n \
  --arg model "$MODEL" \
  --arg system "$SYSTEM_PROMPT" \
  --arg user "$USER_PROMPT" \
  '{
    model: $model,
    max_tokens: 4000,
    system: $system,
    messages: [{role: "user", content: $user}]
  }')"

# Call API
RESPONSE="$(curl -s --max-time 120 \
  -X POST https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "$BODY")"

# Extract text or surface error
TEXT="$(echo "$RESPONSE" | jq -r '.content[0].text // empty')"
if [ -z "$TEXT" ]; then
  echo "API error:" >&2
  echo "$RESPONSE" | jq . >&2 2>/dev/null || echo "$RESPONSE" >&2
  exit 2
fi

# Usage stats footer (cost transparency)
USAGE="$(echo "$RESPONSE" | jq -r '.usage | "input=\(.input_tokens) output=\(.output_tokens)"')"

echo "$TEXT"
echo
echo "---"
echo "_Generado $(date '+%Y-%m-%d %H:%M:%S') · modelo: $MODEL · $USAGE_"
