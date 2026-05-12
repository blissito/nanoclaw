#!/bin/bash
# Agrega una nota tipo common al lead.
# Uso: kommo-add-note.sh LEAD_ID "texto de la nota (multilinea OK)"
set -euo pipefail
LEAD_ID="${1:?lead_id requerido}"
TEXT="${2:?texto requerido}"
JSON_TEXT=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$TEXT")
curl -sS -X POST "https://siiqtec.kommo.com/api/v4/leads/${LEAD_ID}/notes" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[{\"note_type\": \"common\", \"params\": {\"text\": ${JSON_TEXT}}}]" >/dev/null
echo "ok"
