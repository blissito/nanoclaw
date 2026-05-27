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
| Marca | `totequim` | Cliente de sofi-0. Cambiar en el HTML para otro cliente. |

**Semántica (importante):** en el canal `formmy-whatsapp` de sofi-0, `is_bot_message` está siempre en 0 y `manual_mode` es ubicuo, así que NO sirven para medir bot-vs-humano ni escalamiento. La señal fiable es `is_from_me` (0=entrante, 1=saliente). Por eso el reporte mide **volumen + capacidad de respuesta**, no automatización/contención. (Detalle en memoria `reference_sofi_waba_channel_schema`.) Todo es **solo lectura** sobre prod.

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

Devuelve un objeto JSON con: `conversaciones`, `conversaciones_nuevas`, `mensajes_in`, `mensajes_out`, `respondidas`, `primera_respuesta_p50_seg`, `pico_dow` (0=Dom…6=Sáb, hora México), `pico_hora`, y `consumo` (objeto ya sumado para el cliente). Si `conversaciones` es 0, avisa al usuario y detente — el rango/scope no trae datos.

Cálculos derivados (en la sesión host):
- `% respondidas` = `respondidas / conversaciones`
- `1ª respuesta` = `primera_respuesta_p50_seg` formateado (ej. `8 s`, `36 min`)
- `mensajes/conversación` = `mensajes_in / conversaciones`
- Consumo: `consumo` ya viene sumado (un solo cliente en sofi-0). `costo/conversación` = `cost_usd / conversaciones`; `cache hit` = `cache_read_tok / (cache_read_tok + in_tok)`.

**Ojo con la ventana vs historia real:** la `messages.db` de sofi-0 solo guarda historia reciente (al 2026-05-26, desde ~2026-05-08). Si la ventana pedida es mayor que la historia disponible, ajusta la etiqueta del período al rango real de datos. Por eso `conversaciones_nuevas` NO se muestra (sin historia previa todos parecen nuevos); se reemplaza por `mensajes/conversación`.

## Paso 2 — Capa 1 (temas, gpt-4o-mini)

Primero confirma que la llave existe:

```bash
ssh root@64.23.167.64 "grep -c '^OPENAI_API_KEY=' /home/nanoclaw/app/.env"
```

Si da `0`, avisa al usuario (no abortes el reporte: puedes entregarlo sin la sección de temas). Si existe, copia el script y córrelo:

```bash
scp .claude/skills/reporte-cliente/classify-topics.mjs root@64.23.167.64:/tmp/
ssh root@64.23.167.64 \
  "OPENAI_API_KEY=\$(grep -E '^OPENAI_API_KEY=' /home/nanoclaw/app/.env | cut -d= -f2-) \
   node /tmp/classify-topics.mjs /home/nanoclaw/app/store/messages.db 30 30"
```

(Ajusta `30 30` = días y N al rango/muestra elegidos.) Devuelve `{ sample_size, resueltos, topics }`. Convierte `topics` a porcentajes sobre `sample_size` y ordena de mayor a menor.

**Prueba primero con N=5** para validar la llave y el parseo antes de las 30.

## Paso 3 — Armar el PDF

Llena la plantilla de abajo con los datos de los pasos 1 y 2. Genera las barras de temas (`{{TEMAS_BARS}}`) repitiendo la fila por cada tema con su `%`. Luego, con los tools EasyBits MCP de tu sesión (mismo path que las cotizaciones de Sofi):

1. `mcp__easybits__create_document(name, [{ id, order, name, html }])` → `documentId`
2. `mcp__easybits__export_document(documentId, as: 'pdf')` → `file.url`
3. Descarga el PDF (`curl -o`) y entrégalo.

**Gotcha (memoria `reference_easybits_mcp_behavior`):** usa `export_document` (funciona). NO uses `upload_file` público (roto: url vacía + 403).

### Plantilla HTML (one-pager minimalista)

```html
<!doctype html><html lang="es"><head><meta charset="utf-8">
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-white">
<div class="w-[8.5in] min-h-[11in] px-16 py-14 font-sans text-slate-800">
  <header class="flex items-baseline justify-between border-b border-slate-200 pb-6">
    <div>
      <h1 class="text-3xl font-light tracking-tight">{{MARCA}}</h1>
      <p class="text-slate-400 text-sm mt-1">Reporte de actividad</p>
    </div>
    <p class="text-slate-400 text-sm">{{PERIODO}}</p>
  </header>

  <section class="grid grid-cols-3 gap-8 mt-12 text-center">
    <div><div class="text-5xl font-light">{{CONVERSACIONES}}</div><div class="text-slate-400 text-xs uppercase tracking-widest mt-2">Conversaciones</div></div>
    <div><div class="text-5xl font-light">{{PCT_RESPONDIDAS}}</div><div class="text-slate-400 text-xs uppercase tracking-widest mt-2">Respondidas</div></div>
    <div><div class="text-5xl font-light">{{PRIMERA_RESP}}</div><div class="text-slate-400 text-xs uppercase tracking-widest mt-2">1ª respuesta</div></div>
  </section>

  <section class="grid grid-cols-3 gap-8 mt-10 text-center text-sm">
    <div><span class="text-2xl font-light">{{MENSAJES_IN}}</span><div class="text-slate-400 mt-1">mensajes recibidos</div></div>
    <div><span class="text-2xl font-light">{{MENSAJES_OUT}}</span><div class="text-slate-400 mt-1">mensajes enviados</div></div>
    <div><span class="text-2xl font-light">{{MSGS_POR_CONV}}</span><div class="text-slate-400 mt-1">mensajes / conversación</div></div>
  </section>

  <section class="mt-14">
    <h2 class="text-xs uppercase tracking-widest text-slate-400 mb-5">Temas</h2>
    <div class="space-y-3">{{TEMAS_BARS}}</div>
  </section>

  <section class="mt-12 text-sm text-slate-500">
    <span class="text-slate-400 uppercase tracking-widest text-xs">Horario pico</span>
    <span class="ml-3 text-slate-800">{{PICO}}</span>
  </section>

  <footer class="mt-auto pt-10 border-t border-slate-200 grid grid-cols-4 gap-4 text-center text-xs absolute-none">
    <div><div class="text-lg font-light text-slate-800">{{COSTO}}</div><div class="text-slate-400 mt-1">consumo modelos</div></div>
    <div><div class="text-lg font-light text-slate-800">{{COSTO_CONV}}</div><div class="text-slate-400 mt-1">por conversación</div></div>
    <div><div class="text-lg font-light text-slate-800">{{TOKENS}}</div><div class="text-slate-400 mt-1">tokens</div></div>
    <div><div class="text-lg font-light text-slate-800">{{CACHE_HIT}}</div><div class="text-slate-400 mt-1">cache hit</div></div>
  </footer>

  <p class="text-slate-300 text-[10px] mt-8">Generado {{GENERADO}} · consumo facturado a la cuenta del cliente</p>
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
