---
name: reporte-cliente
description: Genera un reporte minimalista (PDF de una página) de la actividad del agente para un cliente. Métricas de conversaciones vía SQL (cero tokens) + top temas con una muestra clasificada por gpt-4o-mini. Usar para "reporte del cliente", "reporte de sofi", "métricas de conversaciones", "report".
---

# Reporte de cliente (beta)

Skill de operador: lo corre la sesión host (no el agente del contenedor) porque requiere SSH al droplet y lectura de toda la DB.

Produce un PDF de una página con dos capas:
- **Capa 0** — métricas agregadas vía SQL sobre `messages`/`chats`/`usage_logs`. Cero tokens.
- **Capa 1** — top temas, clasificando una muestra de conversaciones con `gpt-4o-mini`.

## Parámetros (confirmar con el usuario, con estos defaults)

| Parámetro | Default | Notas |
|---|---|---|
| Droplet | `sofi-0` → `root@64.23.167.64` (team Sofi) | Ver memoria `reference_prod_ssh` para la llave. Parametrizable para otros droplets. |
| Scope | WABA del cliente: `channel='formmy-whatsapp'`, 1:1 | **NO mezclar con Baileys** (`channel='whatsapp'` = grupos admin Siiqtec). Para droplets Baileys, cambia el canal en `metrics.sql` (CTE `scope`) y en `classify-topics.mjs` (`CHANNEL`). |
| Rango | últimos 30 días | Editable (ver Paso 1). |
| Muestra (N) | 30 conversaciones | Las de más mensajes entrantes. |
| Marca | `SIIQTEC` | Cliente de sofi-0 (NO "totequim"). Cambiar en el HTML para otro cliente. |

**Coexistencia (clave):** WABA es bot (Sofi) + operador humano vía Formmy; las conversaciones son **híbridas**. `is_bot_message` siempre 0 y todo saliente sale como `sender_name='Operador'` → NO se puede medir "respondidas por el bot" ni tiempo de respuesta del bot. La señal fiable es **`manual_mode=1` = el operador humano tomó la conversación**. El split se mide por presencia de intervención a nivel conversación: **autónomas** (sin manual_mode) vs **con apoyo humano** (≥1 manual_mode, híbridas). NO etiquetar cada conversación como puro-bot/puro-humano. (Detalle en memoria `reference_sofi_waba_channel_schema`.) Todo es **solo lectura** sobre prod.

## Paso 1 — Capa 0 (SQL, solo lectura)

Pipea `metrics.sql` al `sqlite3` remoto y captura el JSON:

```bash
ssh root@64.23.167.64 'sqlite3 /home/nanoclaw/app/store/messages.db' \
  < .claude/skills/reporte-cliente/metrics.sql
```

Para otro rango, sustituye los días antes de pipear:

```bash
sed 's/-30 days/-60 days/' .claude/skills/reporte-cliente/metrics.sql \
  | ssh root@64.23.167.64 'sqlite3 /home/nanoclaw/app/store/messages.db'
```

Devuelve un objeto JSON con: `conversaciones`, `con_apoyo_humano`, `autonomas`, `mensajes_in`, `mensajes_out`, `pico_dow` (0=Dom…6=Sáb, hora México), `pico_hora`, y `consumo` (objeto sumado). Si `conversaciones` es 0, avisa al usuario y detente.

Cálculos derivados (en la sesión host):
- `% autónomas` = `autonomas / conversaciones` (Sofi sola); `% con apoyo` = `con_apoyo_humano / conversaciones` (híbridas).
- `mensajes/conversación` = `mensajes_in / conversaciones`.
- Consumo: estimado (plan Max, equivalente API, NO factura real). En MXN: `cost_usd * tc` (tc ~18, ajustable). Mostrar como una línea, no como bloque grande.

**Ojo con la ventana vs historia real:** la `messages.db` de sofi-0 solo guarda historia reciente (al 2026-05-26, desde ~2026-05-11). Si la ventana pedida es mayor que la historia disponible, ajusta la etiqueta del período al rango real de datos (ej. "11–27 may 2026").

**Lo que NO se puede medir (limitación de tracking):** respuestas/tiempo del bot (no se etiquetan), resolución (no hay tabla `conversations`), secuencia de handoffs. Esto va en el diagnóstico interno, NO en el PDF del cliente.

## Paso 2 — Capa 1 (temas, gpt-4o-mini)

**sofi-0 NO tiene `OPENAI_API_KEY`** (usa whisper local), así que la clasificación corre **localmente** con la key de tu `.env` del repo. La data se jala por SSH (solo lectura) y la key nunca sale de tu máquina. Este es el modo recomendado:

```bash
# 1) Jala la muestra (top-N chats + texto entrante) desde el droplet, read-only:
ssh root@64.23.167.64 'sqlite3 -json /home/nanoclaw/app/store/messages.db "
  SELECT m.chat_jid AS jid, substr(group_concat(m.content, char(10)),1,1500) AS text, COUNT(*) n
  FROM messages m JOIN chats c ON c.jid=m.chat_jid
  WHERE c.channel=''formmy-whatsapp'' AND c.is_group=0
    AND c.jid NOT LIKE ''formmy_audit%'' AND c.jid NOT LIKE ''%HEALTHCHECK%''
    AND m.is_from_me=0 AND m.content IS NOT NULL AND m.content!=''''
    AND m.timestamp >= strftime(''%Y-%m-%dT%H:%M:%fZ'',''now'',''-30 days'')
  GROUP BY m.chat_jid ORDER BY n DESC LIMIT 30;"' > /tmp/sofi_sample.json

# 2) Clasifica local con tu key (modo --sample):
OPENAI_API_KEY=$(grep -E '^OPENAI_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"') \
  node .claude/skills/reporte-cliente/classify-topics.mjs --sample /tmp/sofi_sample.json
```

Devuelve `{ sample_size, resueltos, topics }`. Convierte `topics` a porcentajes sobre `sample_size` y ordena de mayor a menor.

**Modo alterno (droplet con su propia key):** `scp` el script y corre `node classify-topics.mjs <db> <días> <N>` con `OPENAI_API_KEY` del `.env` del droplet. Si no hay key en ningún lado, entrega el reporte SIN la sección de temas (no abortes).

## Paso 3 — Armar el PDF

Llena la plantilla de abajo con los datos de los pasos 1 y 2. Genera las barras de temas (`{{TEMAS_BARS}}`) repitiendo la fila por cada tema con su `%`. Luego, con los tools EasyBits MCP de tu sesión (mismo path que las cotizaciones de Sofi):

1. `mcp__easybits__create_document(name, [{ id, order, name, html }], brandKitId)` → `documentId`
2. `mcp__easybits__export_document(documentId, as: 'pdf')` → `file.url`
3. Descarga el PDF (`curl -o ~/Downloads/...`), `open -R` para Finder y `open` para Preview.

**Brand kit fixter.org:** `brandKitId='69f4357ae2888eff16f30f5e'` (tinta `#19262a`, menta `#85ddcb`, blanco, Inter). Para impresión: fondo **blanco** y los hex de la paleta hardcodeados en el HTML (garantiza el render aunque las clases semánticas no resuelvan); pasa igual `brandKitId` para metadata/logo.

**Gotcha (memoria `reference_easybits_mcp_behavior`):** usa `export_document` (funciona, probado 2026-05-26). NO uses `upload_file` público (roto: url vacía + 403).

### Plantilla HTML (one-pager minimalista, coexistencia, paleta fixter — validada 2026-05-26)

Fondo blanco; hex hardcodeados (tinta `#19262a`, menta `#85ddcb`, claro `#dae8e5`). La tarjeta del medio (autónomas = valor del bot) va en oscuro como acento.

```html
<!doctype html><html lang="es"><head><meta charset="utf-8">
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>*{font-family:'Inter',ui-sans-serif,system-ui,sans-serif}</style></head>
<body class="bg-white">
<div class="w-[8.5in] h-[11in] bg-white text-[#19262a] px-[1in] py-[0.9in] flex flex-col">
  <header class="flex items-start justify-between">
    <div>
      <p class="text-[10px] uppercase tracking-[0.25em] text-[#19262a]/40">Reporte de actividad · WhatsApp</p>
      <h1 class="text-5xl font-medium tracking-tight mt-2">{{MARCA}}</h1>
      <p class="text-sm text-[#19262a]/50 mt-1">Asistente Sofi + equipo</p>
    </div>
    <div class="text-right"><p class="text-sm font-medium">{{PERIODO}}</p>
      <p class="text-[10px] uppercase tracking-[0.2em] text-[#19262a]/40 mt-1">Periodo</p></div>
  </header>
  <div class="h-[3px] w-16 bg-[#85ddcb] rounded-full mt-6"></div>

  <section class="grid grid-cols-3 gap-5 mt-10">
    <div class="rounded-2xl border border-[#dae8e5] p-6"><div class="text-5xl font-light leading-none">{{CONVERSACIONES}}</div><div class="text-[11px] uppercase tracking-[0.16em] text-[#19262a]/45 mt-3">Conversaciones</div></div>
    <div class="rounded-2xl bg-[#19262a] text-white p-6"><div class="text-5xl font-light leading-none">{{PCT_AUTONOMAS}}<span class="text-2xl align-top">%</span></div><div class="text-[11px] uppercase tracking-[0.16em] text-white/60 mt-3">Autónomas · solo Sofi</div><div class="text-[10px] text-white/40 mt-1">{{N_AUTONOMAS}} conversaciones</div></div>
    <div class="rounded-2xl border border-[#dae8e5] p-6"><div class="text-5xl font-light leading-none">{{PCT_APOYO}}<span class="text-2xl align-top">%</span></div><div class="text-[11px] uppercase tracking-[0.16em] text-[#19262a]/45 mt-3">Con apoyo humano</div><div class="text-[10px] text-[#19262a]/35 mt-1">{{N_APOYO}} · híbridas</div></div>
  </section>

  <p class="text-sm text-[#19262a]/50 mt-8">{{MENSAJES_IN}} mensajes recibidos · {{MSGS_POR_CONV}} por conversación · {{PICO}}</p>

  <section class="mt-12">
    <p class="text-[11px] uppercase tracking-[0.2em] text-[#19262a]/50 mb-4">Temas más frecuentes</p>
    <div class="space-y-3">{{TEMAS_BARS}}</div>
    <p class="text-[10px] text-[#19262a]/35 mt-3">muestra de {{N_MUESTRA}} conversaciones</p>
  </section>

  <div class="mt-auto">
    <p class="text-xs text-[#19262a]/45">Consumo estimado de modelos: {{CONSUMO_MXN}} <span class="text-[#19262a]/35">(equivalente API, plan Max · no factura real)</span></p>
    <footer class="flex items-center justify-between mt-4 pt-4 border-t border-[#dae8e5]">
      <img src="https://fixter.org/logo.png" alt="Fixter" class="h-5 opacity-70">
      <p class="text-[10px] text-[#19262a]/40">Generado {{GENERADO}}</p>
    </footer>
  </div>
</div>
</body></html>
```

Fila de tema para `{{TEMAS_BARS}}` (una por tema, ancho = `%`):

```html
<div class="flex items-center gap-4">
  <span class="w-44 text-sm">{{TEMA}}</span>
  <div class="flex-1 bg-slate-100 rounded h-2"><div class="bg-slate-700 h-2 rounded" style="width:{{PCT}}%"></div></div>
  <span class="w-12 text-right text-sm text-slate-500">{{PCT}}%</span>
</div>
```

Mapa de `pico_dow`: 0 Domingo, 1 Lunes, 2 Martes, 3 Miércoles, 4 Jueves, 5 Viernes, 6 Sábado. Formatea el pico como `<Día> ~<hora>:00 h`.

## Paso 4 — Entregar

Entrega a bliss el PDF: la URL de EasyBits + la ruta local descargada. El envío directo al chat del cliente (vía IPC) queda fuera del beta.

## Notas

- **Solo lectura en prod.** `metrics.sql` es todo SELECT; `classify-topics.mjs` solo lee. No se escribe a la DB ni se manda nada a ningún chat.
- **Audiencia:** el cliente administra su propia cuenta de modelos (BYOK), por eso el bloque de consumo (costo/tokens) le es útil y se incluye.
- **Reusable:** cambia el droplet/IP, la `MARCA` del HTML y la `TAXONOMY` en `classify-topics.mjs` para otro cliente.
