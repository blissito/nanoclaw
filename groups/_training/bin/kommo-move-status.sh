#!/bin/bash
# Mueve un lead a un status del pipeline Siiqtec IA.
# Uso: kommo-move-status.sh LEAD_ID STATUS_NAME
#   STATUS_NAME: entrantes | cotizacion | pagado | enviado | cerrado | cancelado
set -euo pipefail
LEAD_ID="${1:?lead_id requerido}"
STATUS_NAME="${2:?status requerido}"
case "$STATUS_NAME" in
  entrantes)  STATUS_ID=105786907 ;;
  cotizacion) STATUS_ID=105786915 ;;
  pagado)     STATUS_ID=105786983 ;;
  enviado)    STATUS_ID=105786987 ;;
  cerrado)    STATUS_ID=105786991 ;;
  cancelado)  STATUS_ID=105786995 ;;
  *) echo "status desconocido: $STATUS_NAME (válidos: entrantes|cotizacion|pagado|enviado|cerrado|cancelado)" >&2; exit 1 ;;
esac
curl -sS -X PATCH "https://siiqtec.kommo.com/api/v4/leads/${LEAD_ID}" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"status_id\": ${STATUS_ID}}" >/dev/null
echo "ok"
