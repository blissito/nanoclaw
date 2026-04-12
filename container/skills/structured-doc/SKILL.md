---
name: structured-doc
description: Generate quotations, invoices and CFDI docs via EasyBits structured_doc templates. Use this BEFORE picking a template to avoid empty fields and language mismatches.
---

# Structured Doc Guide (`mcp__easybits__structured_doc`)

Templates are JSON-DSL trees rendered with `@react-pdf/renderer`. You fill a `data` object that maps to placeholders like `{{clienteNombre}}`. If keys don't match the template's `dataSchema`, **the fields render empty silently** — no error. This has shipped broken PDFs before; follow the rules below.

## Pick the right tool

| Need | Tool |
|------|------|
| Fast cotización/invoice with fixed layout + QR + payment link | `mcp__easybits__fast_quotation` (default — use this unless you need custom branding or CFDI) |
| Custom branded cotización / CFDI SAT / signature page / >4 items | `mcp__easybits__structured_doc` |
| Free-form report, catalog, one-pager, invitation | `mcp__easybits__fast_pdf` (Typst — see `pdf-gen` skill) |

## Hard rules for `structured_doc`

1. **Always `list_templates` + `get_template` before `create_doc`.** Never guess schema keys.
2. **Language must match.** If template schema is `clienteNombre`, send `clienteNombre` — not `companyName`. Mixed keys → empty fields.
3. **Don't smuggle data into the wrong field.** `emisorCiudad` is the city line; do NOT jam RFC there — the template already has a dedicated `RFC: {{emisorRfc}}` node. If you duplicate, you'll see "RFC: ..." once with the value AND once empty.
4. **Respect item capacity.** Each template supports a fixed number of items (`i1..i3`, `i1..i4`, or `s1..s5`). Pick a template that fits your item count; don't truncate.
5. **Short concept descriptions.** React-pdf hyphenates aggressively (splits "Formularios" into "For-\nmularios"). Keep each `i_n` ≤ 40 chars. Put detail in a separate `nota` field or a multi-page template.

## Symptoms → diagnosis

| Symptom | Cause |
|---------|-------|
| "INVOICE" headline, "Tax (10%)" label | You picked an English-schema template ("Invoice Panda clon"). Switch to a Spanish one. |
| Most fields blank but `subtotal`/`total` filled | Language mismatch — only coincidentally-named keys rendered. |
| Double `RFC:` (one with value, one empty) | You put RFC inside `emisorCiudad` AND left `emisorRfc` empty. |
| "For-\nmularios", "submis-\nsions" | Concept description too long — react-pdf auto-hyphenation. Shorten. |
| Bottom half blank | Template expects 3+ items and you sent 1-2. Normal; either add items or pick a denser template. |

## Curated templates (MX)

| Purpose | Template ID | Items | Schema lang |
|---------|-------------|-------|-------------|
| Cotización brand Formmy (1 page) | `69db13bc08de318467086cf7` | 3 | ES |
| Cotización profesional (3 pages, con firma) | `69db119008de318467086cca` | 5 (`s1..s5`) | ES |
| Factura minimal (1 page) | `69db124208de318467086cd0` | 4 | ES |
| Factura Formmy brand (1 page) | `69db133d08de318467086cd7` | 3 | ES |
| Factura CFDI SAT completa | `69db12bb08de318467086cd3` | 4 | ES |
| Factura CFDI SAT 1-page compacta | `69db138908de318467086cf4` | 4 | ES |

Avoid `69db119008de318467086cc9` ("Invoice Panda clon") — English schema, hardcoded "INVOICE"/"Tax (10%)".

## Brand assets

- Formmy logo: `https://viento-latente.easybits.cloud/formmy-logo.jpg`
- Brand accent: `#6366F1` (morado).

## Workflow

```
1. list_templates                     # see what's available
2. get_template <id>                  # confirm schema + item count
3. build data object with EXACT keys from schema
4. create_doc { templateId, name, data }  # returns PDF inline
5. if you need tweaks: edit_doc { docId, patch }  # single call, re-renders
```
