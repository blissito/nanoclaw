# Plan futuro: skill `pdf-edit` (editar PDF externo byte-idéntico) — PyMuPDF

> Estado: PLANEADO, no ejecutado. Armar cuando un cliente exija editar un PDF
> EXTERNO sin reconstruirlo (caso 2 / pixel-perfect). Para docs que ya hicimos,
> usar la nota "Re-editar" de SKILL.md (HTML + re-export), NO esto.

## Objetivo
"Mismo diseño, cambiar datos puntuales" sobre un PDF que NO vamos a reconstruir:
cambiar fecha/nombre, swapear una foto, llenar formularios — conservando el resto
pixel-perfect.

## Tool: PyMuPDF (fitz)
- pip `pymupdf`. ⚠️ **AGPL** (mismo dueño que mutool, Artifex) → misma deuda de
  licencia; revisar si se productiza. Alternativa permisiva si molesta: pikepdf
  (imágenes/estructura) + pdf-lib JS (texto/overlay) — más clunky.
- Agregar a la línea pip del Dockerfile (`pip3 install --break-system-packages ...`)
  → requiere rebuild + OK (regla de proyecto).

## Capacidades vs límites (honesto)
| Edición | Cómo | Fidelidad |
|---------|------|-----------|
| Swap de imagen en su caja | `page.get_image_rects()` + `page.insert_image(rect, ...)` | pixel-perfect |
| Llenar formularios (AcroForm) | `widget.field_value = ...; widget.update()` | pixel-perfect |
| Texto corto de posición fija | bbox de `page.get_text("dict")` → `add_redact_annot`+`apply_redactions` → `insert_text`/`insert_htmlbox` igualando fuente | bueno si NO reflowea |
| Texto que reflowea / párrafos justificados / texto-a-curvas | — | fuera de alcance v1 |

## Forma de la skill
`container/skills/pdf-edit/` con `SKILL.md` + helper `pdf-edit` (Python, dispatcher):
- `pdf-edit swap-image <pdf> <page> <rect|auto> <newimg>`
- `pdf-edit set-text <pdf> "<viejo>" "<nuevo>"` (busca bbox por texto, redacta+redibuja)
- `pdf-edit fill-form <pdf> <field=value...>`
- Salida a `/workspace/group/`, imprime path. Estilo igual que `pdf-reader`.
- `allowed-tools: Bash(pdf-edit:*), Read`.

## Plan de prueba (validar antes de confiar)
1. PDF real: ORDEN DEL DÍA INNOVAKIDS.
2. `set-text "07 de agosto" "14 de agosto"` → exportar.
3. `swap-image` de una foto de ponente por otra.
4. **Verificación pixel-diff:** `compare` (ImageMagick) entre render original y editado
   → solo la región tocada debe diferir; el resto idéntico. Confirmar fuente igualada
   en el texto (sin halo del redact, sin desalineación).
5. Caso negativo: intentar editar texto que reflowea → documentar que se desborda
   (límite conocido, no bug).

## Gate de decisión
Construir SOLO si:
- un cliente necesita el PDF original byte-idéntico (no sirve reconstruir), Y
- las ediciones son swaps puntuales (no reflow).
Si no → doc-remix → master HTML → re-editar (más simple, sin AGPL, editable siempre).
