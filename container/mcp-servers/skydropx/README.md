# skydropx-mcp

[![npm version](https://img.shields.io/npm/v/skydropx-mcp.svg)](https://www.npmjs.com/package/skydropx-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Servidor MCP (Model Context Protocol) para la API de **Skydropx PRO** — la plataforma agregadora de paqueterías más usada en México.

Permite que un agente de IA (Claude, GPT, etc.) cotice tarifas de envío, genere guías reales, rastree paquetes y cancele envíos en lenguaje natural, integrando proveedores como **FedEx, DHL, Estafeta, J&T Express, Sendex, Paquetexpress, Imile, UPS** y más.

---

## Tools disponibles

| Tool | Descripción |
|------|-------------|
| `skydropx_quote` | Cotiza tarifas entre dos direcciones para un paquete. Hace polling interno hasta que la cotización esté completa (~5-8 segundos típicos). |
| `skydropx_create_shipment` | Crea una guía real con un `rate_id` previo. Devuelve `tracking_number` y `label_url` (PDF descargable). |
| `skydropx_track` | Estado actual + historial de tracking de un envío. |
| `skydropx_cancel` | Cancela una guía (solo antes de que el paquetero la recolecte). |

---

## Configuración

Necesitas credenciales de Skydropx PRO (Conexiones → API en el dashboard):

```bash
SKYDROPX_CLIENT_ID=<tu client_id>
SKYDROPX_CLIENT_SECRET=<tu client_secret>
SKYDROPX_BASE_URL=https://pro.skydropx.com   # o https://sb-pro.skydropx.com para sandbox
```

El servidor implementa **OAuth2 client_credentials** con cache de token en memoria (TTL 2h, refresh automático en 401). Cumple el rate limit de 2 req/s de Skydropx con retry automático en 429.

---

## Uso con Claude Desktop / Claude Code

Agrega al `claude_desktop_config.json` (o `.mcp.json` en Claude Code):

```json
{
  "mcpServers": {
    "skydropx": {
      "command": "npx",
      "args": ["-y", "skydropx-mcp"],
      "env": {
        "SKYDROPX_CLIENT_ID": "tu-client-id",
        "SKYDROPX_CLIENT_SECRET": "tu-client-secret",
        "SKYDROPX_BASE_URL": "https://pro.skydropx.com"
      }
    }
  }
}
```

Reinicia Claude. Ya puedes pedirle cosas como:

> Cotiza un envío de CDMX a Monterrey, paquete de 2kg, 30x20x15 cm

> Crea la guía con la opción más barata

> ¿Dónde va mi paquete con tracking 7891234567?

---

## Uso con otros clientes MCP

Cualquier cliente MCP que soporte transporte stdio funciona. Ejecutable directo:

```bash
SKYDROPX_CLIENT_ID=xxx SKYDROPX_CLIENT_SECRET=yyy npx skydropx-mcp
```

O instalación global:

```bash
npm install -g skydropx-mcp
skydropx-mcp
```

---

## Schemas

### Address

Skydropx usa el modelo `area_level1/2/3` (estilo internacional):

| Campo | Tipo | Requerido | Significado |
|-------|------|-----------|-------------|
| `area_level1` | string | sí | Estado/entidad (ej. "Ciudad de México", "Nuevo León") |
| `area_level2` | string | sí | Municipio/delegación (ej. "Cuauhtémoc", "Monterrey") |
| `area_level3` | string | recomendado | Colonia |
| `country_code` | string (ISO-2) | sí | "MX", "US", etc. |
| `postal_code` | string | sí | Código postal |
| `street1` | string | sí | Calle (sin número) |
| `street_number` | string | recomendado | Número exterior |
| `apartment_number` | string | si aplica | Interior/depto |
| `reference` | string | recomendado | Entre calles, color de fachada, etc. |
| `name` | string | sí | Nombre del contacto |
| `phone` | string | sí | Con código país: `+5215512345678` |
| `email` | string | **sí** | Skydropx la requiere |
| `rfc` | string | opcional | Solo si el cliente factura |

### Parcel

| Campo | Unidad |
|-------|--------|
| `weight` | kg |
| `length` | cm |
| `width` | cm |
| `height` | cm |

---

## Manejo de errores

El servidor devuelve respuestas estructuradas con `isError: true` cuando algo falla:

```json
{
  "status": 422,
  "title": "Unprocessable Entity",
  "detail": "...",
  "hint": "Validation error — check addresses (postal_code, country) and parcel dimensions/weight"
}
```

Códigos comunes:
- `401` — Credenciales rechazadas (revisa client_id/secret y entorno sandbox vs prod)
- `422` — Dirección incompleta o CP sin cobertura del paquetero
- `429` — Rate limit (2 req/s en Skydropx); el servidor reintenta automáticamente

---

## Sandbox vs producción

| Entorno | URL | Notas |
|---------|-----|-------|
| Sandbox | `https://sb-pro.skydropx.com` | Para pruebas. Las guías generadas **no son válidas para envío real**. Credenciales separadas. |
| Producción | `https://pro.skydropx.com` | Las guías cuestan saldo real de tu cuenta Skydropx. |

Cambia entornos solo modificando `SKYDROPX_BASE_URL` (más las credenciales correspondientes).

---

## Detalles técnicos

- **OAuth2:** flujo `client_credentials` con token cacheado en memoria. TTL 2h por defecto, refresh automático cuando faltan <60s o ante 401.
- **Quote async:** la API de Skydropx procesa cotizaciones de forma asíncrona. El tool `skydropx_quote` hace polling interno (8 intentos × 1.5s, máximo 12s) hasta `is_completed: true`, devolviendo solo cotizaciones listas con precio.
- **Retry policy:** reintento automático en 429 (rate limit) y 5xx, con backoff de 600ms.

---

## Origen y mantenimiento

Este paquete vive como parte de [NanoClaw](https://github.com/blissito/nanoclaw) — una plataforma de agentes Claude para WhatsApp/Telegram/Slack. Si encuentras un bug o quieres una nueva tool, abre un [issue](https://github.com/blissito/nanoclaw/issues).

---

## License

[MIT](LICENSE) © Héctor Bliss
