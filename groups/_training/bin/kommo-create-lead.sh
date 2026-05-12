#!/bin/bash
# Crea un lead en Kommo SIIQTEC y devuelve el LEAD_ID por stdout.
# Uso: kommo-create-lead.sh "NOMBRE_CLIENTE" "PRODUCTO_PRINCIPAL"
set -euo pipefail
NOMBRE="${1:?nombre del cliente requerido}"
PRODUCTO="${2:?producto principal requerido}"
RESP=$(curl -sS -X POST "https://siiqtec.kommo.com/api/v4/leads" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[{\"name\": \"${NOMBRE} — ${PRODUCTO}\", \"pipeline_id\": 13710355}]")
echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['_embedded']['leads'][0]['id'])"
