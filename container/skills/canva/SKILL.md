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
| `canva_create_design` | Crear diseño nuevo en blanco con un design_type | 2 |
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

### "Crea una presentación / un post de Instagram / un doc"
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
Después dale al user la `urls.edit_url` de la respuesta para que lo edite en Canva.

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
