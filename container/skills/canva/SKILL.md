---
name: canva
description: Trabaja con la cuenta de Canva del usuario — listar/crear/exportar diseños vía Canva Connect API. OAuth multi-user (cada user vincula su Canva). Dispara cuando el user pida diseños, presentaciones, posts, o exportar algo a PDF/PNG.
---

# Canva — diseños del usuario

Tienes 7 tools MCP para hablar con Canva en nombre del user actual. La conexión es **per-user** (vía OAuth en ghosty.studio); cada user tiene su propia cuenta vinculada.

## Tools disponibles

| Tool | Para qué | Costo |
|------|----------|-------|
| `canva_connect` | Genera link mágico para que el user vincule su Canva | 0 |
| `canva_get_user_profile` | Confirmar qué cuenta está vinculada | 1 |
| `canva_list_designs` | Listar diseños del user (paginado, filtrable) | 1 |
| `canva_get_design` | Detalles de un diseño (URL de edición, thumbnail) | 1 |
| `canva_create_design` | Crear diseño **EN BLANCO** (sin contenido) | 2 |
| `canva_list_brand_templates` | Listar Brand Templates del user (rellenables vía autofill) | 1 |
| `canva_get_brand_template_dataset` | Ver qué fields acepta una template (text/image/chart) | 1 |
| `canva_create_design_autofill` | **Crear diseño CON CONTENIDO** rellenando una Brand Template | 5 |
| `canva_get_autofill_status` | Status del autofill, devuelve design final | 1 |
| `canva_upload_asset` | Subir imagen/video → asset_id para usar en autofill | 2 |
| `canva_import_design` | Importar PPTX/DOCX/PDF → diseño Canva editable | 5 |
| `canva_get_import_status` | Status del import, devuelve designs creados | 1 |
| `canva_export_design` | Exportar a PDF/PNG/JPG (async — devuelve job_id) | **10** |
| `canva_get_export_status` | Ver status de un export job, obtener URL de descarga | 1 |

## El flujo OAuth (lee esto antes de la primera llamada)

Si una tool devuelve `needs_oauth`:

1. Llama `canva_connect` → obtienes un link
2. Mándale el link al user diciéndole algo como:
   > Para conectar tu Canva, abre este link y autoriza: <link>. Expira en 10 min.
3. Espera a que el user diga "ya" / "listo" antes de reintentar
4. Una vez autorizado, todas las tools funcionan sin pasos adicionales

**Nunca pretendas que el user ya conectó su Canva.** Si la tool dice `needs_oauth`, sigue el flujo arriba.

## Cuotas — sé eficiente

Cada llamada se registra y cuenta contra cuota diaria. Reglas:

- **No hagas polling agresivo** del export status. Espera 10-15 segundos entre `canva_get_export_status`. Los exports tardan típicamente 5-30 segundos.
- **Antes de exportar**, confirma con el user qué páginas/formato quiere. No exportes "por si acaso".
- **`canva_list_designs`** acepta filtro `query` (búsqueda libre) — úsalo en vez de listar todo y filtrar manualmente.
- Si una tool devuelve cuota agotada (`hourly_limit_exceeded`, `daily_limit_exceeded`, etc.), avísale al user con el `retry_after_seconds` que viene en el error.

## Workflows comunes

### "Lista mis diseños / qué tengo en Canva"
```
canva_list_designs({ ownership: 'owned' })
```
Si hay muchos, usa `query` para filtrar por título: `canva_list_designs({ query: 'webinar' })`.

### "Hazme una propuesta / presentación con CONTENIDO X"

⚠️ **Nunca uses `canva_create_design` para esto** — solo crea un canvas vacío y el PDF saldrá en blanco.

Flujo correcto con **autofill** (requiere Canva Enterprise en la cuenta del user):

1. `canva_list_brand_templates({ query: 'propuesta' })` — encontrar la template
2. `canva_get_brand_template_dataset({ brand_template_id })` — descubrir qué fields acepta (ej. `cliente`, `monto`, `fecha`)
3. (Si hay fields tipo image) `canva_upload_asset({ file_path: '/workspace/...png' })` → guarda el `asset_id`
4. `canva_create_design_autofill({ brand_template_id, title, data: { cliente: { type:'text', text:'Brenda Go' }, logo: { type:'image', asset_id:'...' } } })` → job_id
5. Loop `canva_get_autofill_status({ job_id })` cada 5-10s hasta `status === 'success'` (máx 6 intentos)
6. `result.design` trae `id`, `urls.edit_url`, `thumbnail.url` — manda thumbnail al user (ver patrón abajo)
7. Si user pide PDF, `canva_export_design({ design_id, format: 'pdf' })` y sigue export flow

**Si el user NO tiene Brand Templates** (autofill falla con `not_supported` o similar) usa el flujo de import:
1. Genera el contenido como PPTX (Bash con pptxgenjs) o como PDF
2. `canva_import_design({ file_path, title })` → job_id
3. `canva_get_import_status({ job_id })` hasta success
4. `result.designs[0]` es el diseño Canva editable resultante

### "Crea una presentación EN BLANCO / un post de Instagram VACÍO para editar a mano"
Mapeo design_type → user request:
- `presentation`, `presentation_4_3`, `presentation_16_9`
- `instagram_post`, `instagram_story`
- `doc` (Canva Docs)
- `youtube_thumbnail`
- `linkedin_post`
- `flyer`, `poster`, `business_card`, `letterhead`
- `tshirt`

```
canva_create_design({ design_type: 'instagram_post', title: 'Promo lunes' })
```

**MANDA EL THUMBNAIL, NO SOLO EL LINK.** La respuesta incluye `design.thumbnail.url` (PNG ~600px, gratis, no consume quota). UX > URL feo. Patrón a seguir:

1. Llama `canva_create_design`
2. De la respuesta, toma `design.thumbnail.url` → mándala como **imagen** por WhatsApp (Bash con `wget` + `send-message --image`, o el helper de envío de imágenes de NanoClaw)
3. En el caption pones: `✅ Listo — edítalo aquí: <design.urls.edit_url>` (sin pegar el URL gigante crudo, usa formato `*Editar diseño*` con link embebido si el canal lo soporta)

Mismo patrón aplica a `canva_get_design` y `canva_list_designs` (cuando muestres un diseño específico). Para listas de diseños, manda solo nombres + edit_url; el thumbnail solo cuando el user enfoca uno en particular.

⚠️ El `thumbnail.url` de Canva expira en ~horas. Para URLs estables, sube el PNG a EasyBits primero. Para mensajes one-shot por WhatsApp no hace falta — el cliente ya lo cacheó.

### "Exporta el diseño X a PDF"
1. `canva_export_design({ design_id, format: 'pdf' })` → job_id
2. Espera 10s
3. `canva_get_export_status({ export_id: job_id })`
4. Si `status === 'in_progress'`, espera otros 10s y repite (máx 6 intentos = 60s)
5. Cuando `status === 'success'`, los `urls` te dan los archivos descargables
6. Manda esas URLs al user (o súbelas a EasyBits si quieres URLs estables)

⚠️ Si después de 60s sigue `in_progress`, avísale al user y pídele que reintente más tarde.

### "Cambia esto en mi diseño"
La Canva Connect API **no edita contenido directamente** desde acá — solo crea, lista y exporta. Para editar, manda al user el `urls.edit_url` del diseño y que lo modifique él en Canva.

## Errores típicos

- **`needs_oauth`** → flujo OAuth (ver arriba)
- **`hourly_limit_exceeded` / `daily_limit_exceeded`** → reportar `retry_after_seconds` al user
- **`Canva 401`** → el access_token de Canva expiró y el refresh falló. Llama a `canva_connect` para re-vincular.
- **`Canva 403`** → falta scope. Indica al user que reautorice (re-llama `canva_connect`); el portal pedirá los nuevos scopes.
- **`Canva 404` en get_design** → el diseño no existe o el user no tiene acceso.

## Lo que NO puedes hacer

- Editar contenido de un diseño (texto, imágenes internas) vía API — no es un endpoint público
- Usar templates premium si el user no tiene plan Pro
- Acceder a diseños de OTRO user (cada token está scoped al user que autorizó)
- Exportar diseños mayores a ~100 páginas en una sola llamada (limitación de Canva)
