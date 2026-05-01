---
name: skydropx
description: Cotiza, crea, rastrea y cancela envíos en México vía Skydropx PRO. Dispara cuando el user pida cotización de envío, generar guía, rastrear paquete, o paquetería (FedEx, DHL, Estafeta, J&T, Sendex, etc.). Solo disponible en grupos con el MCP skydropx habilitado.
---

# Skydropx — envíos México

4 tools MCP para gestionar envíos. La cuenta de Skydropx está vinculada a nivel grupo (creds en `.env` del droplet, mismas para todos los users del grupo). Esto significa que **el saldo es del cliente, no del user que pide el envío** — se descuenta de su cartera Skydropx al crear cada guía.

## Tools

| Tool | Para qué | Cuesta saldo? |
|------|----------|---------------|
| `mcp__skydropx__skydropx_quote` | Cotizar tarifas entre dos direcciones | No |
| `mcp__skydropx__skydropx_create_shipment` | **Crear guía real** (genera label PDF, descuenta saldo) | **Sí** |
| `mcp__skydropx__skydropx_track` | Estado actual + historial de un envío | No |
| `mcp__skydropx__skydropx_cancel` | Cancelar guía (solo antes de colectar) | No |

## Flujo típico

1. **Cotizar** → mostrar al user las opciones (carrier, días, precio)
2. **Esperar elección** → el user dice cuál carrier prefiere
3. **Crear** → invocar `skydropx_create_shipment` con el `rate_id` elegido
4. **Entregar guía** → el response trae `label_url` (PDF). Mandarlo por WhatsApp como documento usando el tool `mcp__nanoclaw__send_message` con `subdir="document"`
5. **Tracking** (después) → cuando el user pregunte por su envío, usar `skydropx_track` con el `tracking_number` y `carrier_name` del shipment

## ⚠️ Guardarail crítico

**Nunca llames a `skydropx_create_shipment` sin confirmación explícita del user.** Cuesta dinero real (descuenta saldo Skydropx del cliente). Patrón correcto:

```
User: cotiza un envío de cdmx a monterrey, paquete 2kg
You: [skydropx_quote → muestra opciones]
     "Te encontré 8 opciones. Las 3 más baratas:
      1. J&T Express Standard — $79 (6 días)
      2. Sendex Sin recolección — $84 (1 día)
      3. Imile Express — $52 (2 días)
      ¿Con cuál creo la guía?"
User: la 3
You: [AHORA SÍ skydropx_create_shipment]
```

Si la cotización es para algo "exploratorio" (el user solo quiere saber cuánto cuesta), **no** crees nada. Solo respondes con los precios.

## Schemas

### Address

Skydropx usa `area_level1/2/3` (estilo internacional) en vez de "estado/ciudad/colonia":

| Campo | Qué es | Requerido |
|-------|--------|-----------|
| `area_level1` | Estado (CDMX, Nuevo León, Jalisco...) | sí |
| `area_level2` | Municipio/delegación (Cuauhtémoc, Monterrey, Guadalajara...) | sí |
| `area_level3` | Colonia | recomendado |
| `country_code` | ISO-2: "MX", "US" | sí |
| `postal_code` | CP, e.g. "06600" | sí |
| `street1` | Calle (sin número) | sí |
| `street_number` | Número exterior | recomendado |
| `apartment_number` | Interior/depto | si aplica |
| `reference` | Entre calles, color de fachada, etc. | recomendado |
| `name` | Nombre del contacto | sí |
| `phone` | Con código país: "+5215512345678" | sí |
| `email` | Email del contacto | **sí** (Skydropx la requiere) |
| `rfc` | Solo si el cliente factura | no |

### Parcel

| Campo | Unidad |
|-------|--------|
| `weight` | kg |
| `length` | cm |
| `width` | cm |
| `height` | cm |

## Manejo de respuestas

### `skydropx_quote`

Devuelve un objeto con `id` (quote_id), `is_completed: true`, y un array `rates`. El tool **internamente espera** hasta que la cotización está lista (~2-6 segundos), así que cuando lo recibes ya tiene precios. Filtra `rates` por `success: true` antes de mostrar al user — los `success: false` son carriers que no llegan a esa zona.

Cada rate tiene:
- `id` — usar como `rate_id` para create_shipment
- `provider_display_name` — "DHL", "FedEx", "J&T Express"
- `provider_service_name` — "Express", "Standard", "Día siguiente"
- `total` — precio final con IVA
- `days` — días de entrega estimados
- `pickup` — si el carrier hace recolección a domicilio (`true`) o requiere drop-off (`false`)

Recomendación al user: agrupar por carrier y mostrar 3-5 opciones balanceando precio/velocidad. No vomitar los 30 rates.

### `skydropx_create_shipment`

Devuelve `id` (shipment_id), `tracking_number`, `provider_name` (úsalo como `carrier_name` para track después), y `label_url` (PDF de la guía).

**Tip de entrega:** descarga el PDF y mándalo por WhatsApp con `mcp__nanoclaw__send_message` usando `subdir="document"` y filename descriptivo (`guia-{tracking_number}.pdf`).

### Errores comunes

| Status | Causa probable | Acción |
|--------|---------------|--------|
| 401 | Token rechazado | Bug del MCP (auto-refresh debería resolverlo); reportar al admin |
| 422 | Validación: dirección incompleta o CP inválido | Pedirle al user el dato faltante |
| 422 | "no postal_code coverage" | Carrier no llega ahí; mostrar solo los rates con `success: true` |
| 429 | Rate limit (2 req/s) | El MCP ya hace retry automático |

### `skydropx_track`

Necesita **dos** parámetros: `tracking_number` (la guía) y `carrier_name` (en lowercase: "fedex", "dhl", "estafeta", "jtexpress", "sendex"). El `carrier_name` viene del campo `provider_name` que regresó `create_shipment`.

### `skydropx_cancel`

Solo funciona si el carrier **aún no recolectó** el paquete. Después de recolectado, no hay vuelta atrás. La cancelación puede tomar minutos en confirmarse — si el user pregunta el estado, vuelve a llamar el tool.

## Sandbox vs producción

El droplet de SIIQTEC puede estar apuntando a sandbox (`sb-pro.skydropx.com`) o producción (`pro.skydropx.com`). Las guías de sandbox **no son reales** (no se imprime ninguna etiqueta válida) — son para pruebas. Si el user crea una guía en sandbox y luego se queja de que no llegó nada, esa es la causa. Verificar `SKYDROPX_BASE_URL` en el container env si dudas.
