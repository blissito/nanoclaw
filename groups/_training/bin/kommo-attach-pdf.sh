#!/bin/bash
# Sube un PDF a Kommo Drive y lo adjunta al lead. Devuelve "ok" al terminar.
# Uso: kommo-attach-pdf.sh LEAD_ID /workspace/group/cot-XXX.pdf [filename-en-kommo.pdf]
set -euo pipefail
LEAD_ID="${1:?lead_id requerido}"
PDF_PATH="${2:?path al PDF requerido}"
FILE_NAME="${3:-$(basename "$PDF_PATH")}"
[[ -f "$PDF_PATH" ]] || { echo "PDF no existe: $PDF_PATH" >&2; exit 1; }
PDF_SIZE=$(stat -c%s "$PDF_PATH")
SESSION=$(curl -sS -X POST "https://drive-g.kommo.com/v1.0/sessions" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"file_name\": \"${FILE_NAME}\", \"file_size\": ${PDF_SIZE}, \"content_type\": \"application/pdf\", \"with_preview\": false}")
UPLOAD_URL=$(echo "$SESSION" | python3 -c "import json,sys; print(json.load(sys.stdin)['upload_url'])")
FILE_UUID=$(curl -sS -X POST "$UPLOAD_URL" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$PDF_PATH" | python3 -c "import json,sys; print(json.load(sys.stdin)['uuid'])")
curl -sS -X PUT "https://siiqtec.kommo.com/api/v4/leads/${LEAD_ID}/files" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[{\"file_uuid\": \"${FILE_UUID}\"}]" >/dev/null
echo "ok"
