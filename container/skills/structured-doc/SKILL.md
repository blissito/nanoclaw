---
name: structured-doc
description: Hub for generating any printable document. Decides between fast_quotation (cotizaciones con pago) and structured_doc (todo lo demás, via templates or custom DSL). fast_pdf is deprecated.
---

# Documentos — hub único

## Decisión binaria del core

| Necesidad | Tool |
|-----------|------|
| Cotización con QR + link de pago | `mcp__easybits__fast_quotation` |
| Cualquier otro documento imprimible (facturas, propuestas, reportes, invitaciones, catálogos, contratos) | `mcp__easybits__structured_doc` |
| Sitio web / dashboard / landing | `mcp__easybits__create_website` |
| HTML ad-hoc sin template | `mcp__easybits__create_document` |

**`fast_pdf` está deprecado** — no lo uses salvo casos de Typst libre que ningún template puede cubrir (raro).

## `fast_quotation` — cotización canónica

Flujo fijo:
1. `mercadopago create-link <monto> "<descripción>"` → URL de pago.
2. `fast_quotation` con company, client, items, totals, brandColor, currency + `paymentUrl` del paso 1.
3. PDF con QR clickeable regresa inline — envíalo como attachment.

No admite layout custom. Si necesitás branding particular o CFDI o esquema de pagos → `structured_doc`.

## `structured_doc` — el hub de todo lo demás

Templates DSL (JSON-tree) + data. El agente nunca escribe layout; o elige un template curado o crea uno con `create_template`.

### Acciones

| Acción | Cuándo |
|--------|--------|
| `list_templates` | Descubrir qué templates existen (siempre empieza aquí si no conocés el catálogo). |
| `get_template_schema` | Solo querés los campos que debés llenar. Lightweight (90% de los casos). |
| `get_template` | Necesitás ver el tree (para clonar, editar, o entender el render). Pesado. |
| `create_template` | No hay template que sirva. Construí el tree DSL desde cero (ver abajo). |
| `delete_template` | Limpiar templates obsoletos que vos creaste. Rehúsa si hay docs que lo referencian. |
| `create_doc` | Generar PDF con template + data. Devuelve `warnings` si hay keys huérfanas. |
| `list_docs` | Buscar docs previos: `{ cursor?, limit?, templateId?, query? }`. |
| `get_doc` | Leer un doc ya creado + PDF cacheado. |
| `patch_doc` / `edit_doc` | Modificar data. `edit_doc` re-renderiza en la misma llamada (preferido para WhatsApp). |
| `render_doc` | Re-render sin cambiar data. |

### Hard rules

1. **Siempre `list_templates` + `get_template_schema` antes de `create_doc`.** Nunca adivines keys.
2. **Match de idioma.** Si el schema usa `clienteNombre`, mandá `clienteNombre` — no `companyName`. Mixed keys → campos vacíos.
3. **No metas datos donde no van.** `emisorCiudad` = ciudad/colonia; el RFC va en `emisorRfc`. Duplicar causa "RFC:" vacío renderizado.
4. **Capacidad de items.** Cada template soporta N items (`i1..i3`, `s1..s5`). Elegí uno que encaje; no trunques.
5. **Descripciones cortas.** ≤40 chars por item para evitar hyphenation de react-pdf ("For-\nmularios"). Detalle largo va en un campo aparte (`nota`, `proyectoDescripcion`).
6. **Leé `warnings` del response de `create_doc`.** Listan placeholders sin data o keys de data sin placeholder. Si aparecen, corregí y re-renderizá.

### Descubrimiento de templates (NO hay lista hardcoded en este skill)

La DB es la fuente de verdad. Un skill con una tabla estática se pudre: cada vez que alguien crea o borra un template, la tabla queda mintiendo. **Siempre empezá con `list_templates`** — la descripción de cada template explica para qué sirve y su `dataSchema` te dice qué campos aceptar.

Heurística para elegir:
1. `list_templates` → filtrá por nombre/description (matching semántico).
2. Si ≥1 candidato claro → `get_template_schema <id>` para ver campos.
3. Si no hay candidato o el schema no alcanza → `create_template` (escape hatch abajo).

Qué buscar en `list_templates`:
- Nombre + description dicen el caso de uso.
- `isPublic: true` + `owned: true` → curado por el equipo (confiable).
- Si ves templates con schema `{}` o casi vacío → son de un solo uso, evitá reutilizarlos.

No confíes en IDs de esta skill — podrían ya no existir. Consultá la DB.

### Brand assets Formmy

- Logo: `https://viento-latente.easybits.cloud/formmy-logo.jpg`
- Acento: `#6366F1` (morado)

### Escape hatch: `create_template` desde cero

Cuando ningún template curado sirve:

```
1. get_template de un template parecido → usar su tree como referencia de estructura
2. Construir nuevo tree: pages[].children[] con nodos {type, style, children}
   • type: "View" (container flexbox), "Text" (con {{interpolation}}), "Image", "Link"
   • style: subset de react-pdf styles (flexDirection, fontSize, color, padding…)
3. dataSchema: { campo: "string" | "url" | "number" }
4. create_template { name, description, tree, dataSchema, isPublic: true }
5. create_doc con el nuevo templateId para validar
```

Si el tree es grande (>200 líneas), considerá clonar y mutar en vez de escribir desde cero.

## Workflow típico

```
Usuario: "hazme una factura CFDI para X"
  ↓
1. list_templates (skip si ya conoces los IDs curados)
2. get_template_schema <cfdi-id>
3. Llenar data con keys EXACTAS del schema
4. create_doc → leer warnings
5. Si warnings → corregir + edit_doc
6. Enviar PDF inline al chat
```
