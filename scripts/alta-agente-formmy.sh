#!/usr/bin/env bash
#
# alta-agente-formmy.sh — Alta confiable de un agente nuevo en el canal público
# Formmy (WABA). Hace TODO el lado droplet de forma idempotente y verificable, y
# deja claro el único paso manual que queda (pegar el secret en formmy.app).
#
# Por qué existe: cada alta fallaba porque el lado droplet quedaba bien pero la
# coordinación con Formmy (URL + secret del webhook) no se verificaba hasta que
# el cliente veía "Tuve un problema procesando tu mensaje". Este script rota un
# secret PROPIO por agente (identidad/ruteo de conversaciones — lo único que NO
# debe compartirse; API key + OAuth Max son compartidos a propósito), reinicia,
# y corre un self-test sin efectos secundarios que prueba el secret de punta a
# punta ANTES de declarar el alta lista.
#
# Uso:
#   ./scripts/alta-agente-formmy.sh <HOST_IP> [SSH_USER] [PORT]
# Ej:
#   ./scripts/alta-agente-formmy.sh 164.90.150.119            # tania (TOTEQUIM)
#
# Requiere: SSH a root@<HOST_IP> con la key correcta ya en el agent/config.
set -euo pipefail

HOST="${1:?Falta HOST_IP. Uso: $0 <HOST_IP> [SSH_USER] [PORT]}"
USER="${2:-root}"
PORT="${3:-3940}"
APP="/home/nanoclaw/app"
TS="$(date +%Y%m%d-%H%M%S)"
SSH="ssh -o ConnectTimeout=10 ${USER}@${HOST}"

echo "==> Alta agente Formmy en ${USER}@${HOST}:${PORT}"

# 0) Pre-flight: servicio vivo, puerto escuchando, idle (sin containers).
$SSH "systemctl is-active nanoclaw >/dev/null || { echo 'ABORT: nanoclaw no está activo'; exit 1; }"
$SSH "ss -ltn | grep -q ':${PORT} ' || { echo 'ABORT: nadie escucha el puerto ${PORT}'; exit 1; }"
ACTIVE=$($SSH "docker ps --format '{{.Names}}' | grep -c '^nanoclaw-' || true")
echo "    containers activos: ${ACTIVE}"
if [ "${ACTIVE}" != "0" ]; then
  read -r -p "    Hay containers activos. ¿Reiniciar de todas formas? [y/N] " ok
  [ "${ok:-}" = "y" ] || { echo "Cancelado."; exit 1; }
fi

# 1) Secret PROPIO. (No tocamos ANTHROPIC_API_KEY ni CLAUDE_CODE_OAUTH_TOKEN:
#    son compartidos a propósito — cómputo/billing, no identidad.)
SECRET="$(openssl rand -hex 32)"

# 2) Backup + set idempotente del secret en .env del droplet.
$SSH "cd ${APP} && cp .env .env.bak.${TS}-alta-formmy && \
  if grep -q '^FORMMY_CHANNEL_SECRET=' .env; then \
    sed -i 's|^FORMMY_CHANNEL_SECRET=.*|FORMMY_CHANNEL_SECRET=${SECRET}|' .env; \
  else echo 'FORMMY_CHANNEL_SECRET=${SECRET}' >> .env; fi"
echo "    .env respaldado (.env.bak.${TS}-alta-formmy) y secret seteado"

# 3) Restart para cargar el secret (systemd lee EnvironmentFile al arrancar).
$SSH "systemctl restart nanoclaw && sleep 6 && systemctl is-active nanoclaw >/dev/null || { echo 'ABORT: no levantó tras restart'; exit 1; }"

# 4) Verificar que el secret quedó vivo en el environ del proceso.
WANT="$(printf '%s' "${SECRET}" | sha256sum | cut -c1-16)"
GOT=$($SSH "PID=\$(systemctl show -p MainPID --value nanoclaw); tr '\0' '\n' < /proc/\$PID/environ | grep '^FORMMY_CHANNEL_SECRET=' | cut -d= -f2- | tr -d '\n' | sha256sum | cut -c1-16")
[ "${WANT}" = "${GOT}" ] || { echo "ABORT: secret en environ (${GOT}) != esperado (${WANT})"; exit 1; }
echo "    secret vivo en el proceso (sha256/16=${GOT})"

# 5) SELF-TEST sin efectos secundarios:
#    - secret correcto + body {}  -> 400 (pasa auth, falla validación de payload)
#    - secret malo                -> 401 (rechaza)
#    No spawnea container ni manda nada al cliente.
C_OK=$($SSH "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:${PORT}/message -H 'authorization: Bearer ${SECRET}' -H 'content-type: application/json' -d '{}'")
C_BAD=$($SSH "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:${PORT}/message -H 'authorization: Bearer wrong' -H 'content-type: application/json' -d '{}'")
echo "    self-test: secret OK -> ${C_OK} (esp 400) | secret malo -> ${C_BAD} (esp 401)"
[ "${C_OK}" = "400" ] && [ "${C_BAD}" = "401" ] || { echo "ABORT: self-test falló — el canal no valida el secret como se espera"; exit 1; }

cat <<EOF

==> LADO DROPLET LISTO Y PROBADO ✅  (cualquier falla restante es del lado Formmy)

    FORMMY_CHANNEL_SECRET (droplet) = ${SECRET}

LADO FORMMY (Mongo, Fly app formmy-v2): el secret vive en Agent.dropletChannelSecret,
NO en el .env ni en Integration.externalAgentUrl (modelo viejo). UN droplet = UN secret:
TODOS los agentes con dropletHost=${HOST} deben tener este mismo dropletChannelSecret.

  # 1) listar agentes que apuntan a este droplet:
  cat > /tmp/q.js <<'JS'
  const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
  db.\$runCommandRaw({find:'Agent',filter:{dropletHost:'${HOST}'},
    projection:{name:1,dropletChannelPort:1,dropletChannelSecret:1}})
    .then(r=>{console.log(JSON.stringify((r.cursor?r.cursor.firstBatch:[]).map(d=>
      ({id:d._id.\$oid,name:d.name,secret:d.dropletChannelSecret?'set':'MISSING'}))));process.exit(0)});
  JS
  B64=\$(base64</tmp/q.js|tr -d '\n'); fly ssh console --app formmy-v2 -C "node -e \"eval(Buffer.from('\$B64','base64').toString())\""

  # 2) setear el secret en TODOS esos agentes (reemplaza IDS=[...] con los _id del paso 1):
  #    db.\$runCommandRaw({update:'Agent',updates:IDS.map(id=>({q:{_id:{\$oid:id}},
  #      u:{\$set:{dropletChannelSecret:'${SECRET}'}}}))})

Verificación end-to-end (cuando el secret esté en Mongo, manda un
mensaje real al número WABA y observa):

    ${SSH} 'journalctl -u nanoclaw -f | grep -iE "formmy|Auto-provisioned|Spawning|Message sent"'

Debe verse: Auto-provisioned per-user public group -> Spawning container agent
-> respuesta del agente. Si NO aparece nada al mandar el mensaje, el webhook de
Formmy sigue mal (URL o secret) — NO es el droplet.

Recuerda refrescar el backup local del .env:
    scp ${USER}@${HOST}:${APP}/.env ~/.env-backups/<droplet>.env
EOF
