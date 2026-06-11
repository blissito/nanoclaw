---
name: doc-remix
description: Haz una versión nueva/ejecutiva/más limpia de un documento institucional (PDFs tipo "orden del día", agendas, hojas de evento, programas) MINANDO sus assets reales (logos, fotos de ponentes, texto, fuentes) y RECONSTRUYENDO en HTML — nunca re-difundiendo la página como imagen. Úsala ante "haz una nueva versión", "versión ejecutiva", "rehazlo más limpio", "adáptalo" de un PDF.
allowed-tools: Bash(pdf-assets:*), Bash(pdftoppm:*), Bash(pdfimages:*), Bash(pdftotext:*), Bash(pdffonts:*), Bash(identify:*), Bash(convert:*), Bash(curl:*), Read
---

# doc-remix — rehacer documentos minando sus assets

## Principio: **mina, no redibujes**

Un PDF es **data estructurada**, no una foto. Adentro trae los logos, las fotos (muchas ya recortadas con transparencia), el texto y las fuentes — listos para reusar. Si mandas la página a un editor de imagen IA (diffusion: `edit_image`/`create_or_edit_image`) **deforma los logos y el texto**. Extrae los assets reales y **reconstruye en HTML**.

Esto sirve para versiones **ejecutivas / simplificadas / re-maquetadas**, no para clones pixel-perfect del arte original. Dilo al usuario si pide un clon idéntico.

## ¿Tabular o free-form? — elige la rama ANTES de reconstruir

Clasifica el documento primero:

- **Tabular / formato fijo** (cotización, factura, recibo, orden de compra, lista de precios, agenda con tabla): el contenido son campos en una plantilla repetible → **rama `structured_doc`** (sección de abajo). Es la que **NO se cuelga**: el modelo solo emite un JSON de datos chico y el template hace el layout. Cero `set_page_html` gigante, cero subida foto-por-foto. **Úsala SIEMPRE que el doc sea tabular** — armar a mano el HTML de una cotización es justo lo que atora al agente.
- **Free-form** (orden del día con fotos de personas posicionadas, posters, layouts editoriales no tabulares): no hay plantilla repetible → **rama HTML página-por-página** (el `## Workflow` de más abajo).

## Rama tabular: `structured_doc` (cotizaciones, facturas, recibos)

El motor es **template + data**: tú solo produces el objeto `data`, el template (JSON @react-pdf/renderer) arma el layout. Render ~1s, PDF inline, master re-editable. Validado en CoreGrid (2026-06-03).

1. **Mina igual** (`pdf-assets mine <archivo>`) para sacar el logo real + el texto. VE el `page-1.png` UNA vez para captar el layout; lee `text.txt` para los datos (folio, cliente, conceptos, montos, notas).
2. **Sube el logo minado UNA vez, público:** `upload_file({fileName, contentType:"image/png", size, access:"public"})` → PUT los bytes al `putUrl` devuelto → `curl -sI <file.url>` debe dar **200** antes de usarlo. Esa `file.url` es tu `logoUrl`. (Una sola vez por marca; reutiliza la URL en futuras cotizaciones.)
3. **Busca template fiel:** `structured_doc({action:"list_templates"})`. Si ya hay uno que respeta la marca y el layout del original (ej. *"Cotización Coregrid · FIEL"*), úsalo y salta al paso 5.
4. **Si NO existe uno fiel, créalo UNA vez** con `structured_doc({action:"create_template", name, description, dataSchema, tree})`. El `tree` es JSON @react-pdf/renderer (`{type:"View"|"Text"|"Image", style, children}`, placeholders `{{campo}}`) — **replica el layout del original** mirando el `page-1.png`: header, tabla con bordes, totales, notas. **REGLA DE FIDELIDAD: clona lo que el original TIENE y NADA que no tenga.** Si el original no trae IVA, ni subtotal, ni barra de footer → NO los metas (error real 2026-06-03: el template genérico agregaba "IVA (16%) $0.00" y un footer que el original no tenía). Guarda el `templateId`.
5. **Genera:** `structured_doc({action:"create_doc", templateId, name, data})`. El `data` sale de `text.txt`; `logoUrl` = la URL del paso 2. Devuelve el PDF inline (no hace falta `get_file`). Si `warnings` lista placeholders sin atar, son campos vacíos — rellena o ignóralos.
6. **Valida fidelidad (solo la PRIMERA vez de un formato/template nuevo):** si acabas de CREAR el template en el paso 4, entrega el PDF como **borrador** y pide OK explícito ("¿así queda fiel al original?") ANTES de mandarlo a un cliente. Las cotizaciones van directo al cliente que paga: un template recién hecho puede fallar un detalle sutil (color, un campo de más). Si reutilizaste un template fiel que ya existía (paso 3), NO hace falta borrador — entrega directo.
7. **Re-editar después** (cambiar un dato sin reconstruir): `get_doc` → `patch_doc`/`edit_doc` → re-render. El primer doc te deja un master para siempre.
8. **Entrega** el PDF como adjunto.

> **PROHIBIDO** armar a mano el HTML de una cotización/factura con `create_document` + `set_page_html`. Ese output gigante es exactamente lo que cuelga al agente (incidente 2026-06-02). Tabular → SIEMPRE `structured_doc`.

## Workflow (rama free-form: HTML página-por-página)

> Esta rama es **solo para documentos free-form** (orden del día con fotos posicionadas, posters, layouts editoriales). Para cotizaciones/facturas/recibos usa la **rama tabular `structured_doc`** de arriba — NO este path.

> **Avisa antes de los tramos largos.** Minar, `extract-photos.py` y el armado/subida tardan ~1 min
> en silencio. Manda un `send_message` corto ("dame un momento, lo estoy armando") ANTES de empezar
> esa parte — si no, el usuario cree que te colgaste aunque vayas avanzando bien (incidente 2026-06-02).

1. **Mina:** `pdf-assets mine <archivo|url>` → lee el manifiesto que imprime (assets clasificados + rutas a texto, renders y fuentes).
2. **VE el original UNA vez:** `Read` el `page-1.png` (thumbnail) para captar la estructura. No reconstruyas un layout que no miraste — pero **una ojeada basta**. El texto/orden/nombres NO salen de la imagen, salen de `text.txt`.
3. **Lee la estructura:** `Read` el `text.txt` (es `-layout`) para orden del día, nombres, horarios, descripciones. **De aquí en adelante construyes desde texto** (`text.txt` + manifiesto), no re-mirando los renders.
4. **Elige assets** del manifiesto:
   - `logo` y `photo`/`photo (cutout)` → úsalos.
   - `mask` → **descártalos** (son máscaras/ruido).
   - `background` → solo como raster (de fondo); no intentes volverlos editables.
5. **Onboarding de cada logo** (sub-paso abajo).
6. **Reconstruye en HTML, UNA PÁGINA POR TURNO.** `create_document` → luego por cada hoja: **sube los assets de esa hoja en bulk** (ver "Subir assets en bulk" abajo) → `add_page` + `set_page_html` de **esa sola página** (con los `<img src>` = las URLs devueltas + el texto real + la tipografía de `fonts.txt`, ej. Montserrat vía Google Fonts) → al final `export_document`/`deploy_document`. Página 816×1056px, `overflow:hidden`.
   - **PROHIBIDO** generar el HTML de varias páginas en un solo `set_page_html`. Generar las 6 hojas en un turno produce un output gigante que **cuelga al agente** esperando a la API (incidente 2026-06-02, ghosty-anuar: se atoró 2 veces justo en *"construyo el HTML de 6 páginas"*, sesión chica pero turno infinito). Una hoja por llamada = turno acotado = no se cuelga.
   - **PROHIBIDO** subir assets uno por uno con `upload_file`. ~25 fotos = ~25 round-trips = 4-7 min y nunca llega al armado (incidente 2026-06-03). Usa SIEMPRE `bulk_upload_files`.
7. **Verifica (una sola imagen):** `export_document` (o `get_page_screenshot`), `Read` **ese** resultado UNA vez y cotéjalo contra `text.txt` + el manifiesto — confirma que cada logo/foto se ve, que ninguna columna colapsó y que ningún texto se partió letra por letra. **No digas "listo" sin mirar el render. Pero NO re-leas las páginas fuente para comparar** — ya tienes el texto.
8. **Entrega** el PDF como adjunto.

## Re-editar un doc que YA hiciste (cambiar datos, NO reconstruir)

Si te piden cambiar un dato puntual (fecha, nombre, foto) de un documento que ya
construiste o remixeaste antes (vive como doc HTML en EasyBits), **NO lo reconstruyas
desde cero.** Edita el HTML y re-exporta:

1. `list_documents` para hallarlo → `get_page_html` (lee el HTML real primero).
2. `set_page_html` / `replace_html` con el cambio quirúrgico.
3. `export_document` y entrega el PDF.

El primer doc-remix te deja un "master" editable para siempre — los cambios de datos
son triviales y conservan el diseño. (Para editar un PDF EXTERNO byte-idéntico sin
reconstruirlo, eso es otra herramienta; no es doc-remix.)

## Onboarding de logo (para que se use bien)

```bash
# recorta el relleno blanco y deja fondo transparente
convert logo.png -fuzz 8% -trim +repage -background none logo-trim.png
```

- Súbelo público con el patrón **bulk** de abajo (un solo logo igual va por `bulk_upload_files`; `upload_file` suelto solo si de plano es UN archivo aislado).
- Verifica antes de embeber: `curl -sI <url>` debe dar `HTTP/2 200`.
- Úsalo por ALTURA en CSS (`height:48-72px; width:auto; object-fit:contain`). Nunca lo deformes (no fuerces width y height juntos). Nunca por debajo de 48px (el tagline deja de leerse).
- NUNCA lo edites/redibujes con generadores de imagen. Es un archivo: se coloca tal cual.

## Subir assets en bulk (rápido — NUNCA uno por uno)

Subir foto por foto con `upload_file` es el cuello que te cuelga (~25 round-trips, 4-7 min, nunca
llegas al armado — incidente 2026-06-03). Sube los assets de una página **de golpe**:

1. `bulk_upload_files({ items: [{fileName, contentType:"image/png", size, access:"public"}, ...] })`
   en lotes de **≤20** → devuelve `[{file, putUrl}, ...]`.
   - Si `bulk_upload_files` no aparece como tool, invócala vía
     `run_tool({ name:"bulk_upload_files", params:{ items:[...] } })` (los meta-tools
     `discover_tools`/`run_tool` siempre están).
2. Haz los PUT de los bytes a cada `putUrl` **en paralelo**, en UN solo bloque Bash:
   ```bash
   curl -s -X PUT --data-binary @foto1.png "<putUrl1>" & \
   curl -s -X PUT --data-binary @foto2.png "<putUrl2>" & \
   wait
   ```
3. Embebe el `file.url` **literal** que devolvió cada item (NUNCA construyas la URL a mano desde
   `storageKey`/`fileName` → da 403). Un `curl -sI <url>` debe dar 200 antes de embeber.

## Disciplina de layout (evita texto roto)

- Datos en grid de columnas de ancho igual (`repeat(N, minmax(0,1fr))`), no en flex que colapsa.
- Valores cortos (fecha, hora, monto) → `white-space:nowrap`. Si no cabe, baja el `font-size`, NO lo quiebres.
- PROHIBIDO `word-break:break-all` / `overflow-wrap:anywhere` en texto normal — es la causa del bug "una letra por línea".

## Robustez (NO entres en loop con tools que fallan)

- **Re-leer renders de página después de la primera ojeada está PROHIBIDO.** Cada `Read` de un
  `page-N.png` mete la imagen completa al contexto vía visión, y el contexto es append-only — no
  sale nunca. Re-leerlos para "re-chequear el layout" infló la sesión a **12 MB / ~104K tokens por
  turno** y colgó al agente (incidente 2026-06-02, ghosty-anuar: 34 re-lecturas de 6 páginas). El
  layout se sostiene desde `text.txt` + el manifiesto, **no** re-mirando los PNG. Si dudas de un
  dato, está en `text.txt`.
- Para PDF→editable construye con `create_document` → `set_page_html` → `export_document`.
- Si el usuario dice "clona/clonar este documento", eso significa **hacer una copia
  editable** — usa el camino que funcione (`create_document`), NO asumas una tool
  literal llamada "clone".
- **`pdf_to_images` ya rasteriza NATIVO (pdftoppm, memoria acotada)** — funciona con
  PDFs pesados (hasta ~90MB+). Úsalo normal, con el `maxPages` que necesites. Solo
  falla si el archivo supera **150MB** ("PDF too large to rasterize") → pide uno más
  liviano o divídelo. ⚠️ **Si aún ves `-32603`/"terminated", el deploy con poppler
  todavía no está — NO reintentes en loop, espera.**
- **`clone_document` está DESHABILITADO** (no aparece en tools/list, no lo invoques).
  Para clonar un PDF: `pdf_to_images` → genera HTML por página con visión →
  `create_document` con las secciones.
- **`agent_run`:** si `agent_run_status` devuelve `"running"` 2-3 veces seguidas sin
  avanzar → asume que el job murió por dentro → `agent_run_destroy` + reporta. **NO
  lo pollees 12 veces.**

## Fotos / assets posicionados — EL MÉTODO CORRECTO (clave, aprendido a la mala)

Para reconstruir páginas con **fotos + nombres** (personal a cargo, ponentes, tarjetas):

- **El PDF digital YA SABE dónde está cada imagen** (trae el bbox de colocación). El detector
  correcto es **leer esa data embebida con PyMuPDF**, NO "ver" la página.
- Corré **`python3 .../doc-remix/extract-photos.py "$run/source.pdf" <pagina>`** — usa SIEMPRE el
  `source.pdf` del run dir (nombre limpio). **NUNCA le pases el adjunto original:** nombres con
  espacios/acentos/paréntesis (`ORDEN DEL DÍA (2).pdf`) o duplicados rompen el comando y te meten en
  loop de reintentos (incidente 2026-06-02). Extrae cada foto por su xref + el **nombre del texto a
  su derecha** → JSON `[{file, bbox, name}]`. Determinista.
- **PyMuPDF (`fitz`) viene pre-instalado.** Si llegara a faltar: `pip install pymupdf
  --break-system-packages -q` UNA vez; si falla, reporta, **NO reintentes en loop**.
- **El match foto↔nombre es POSICIONAL, NUNCA facial.** Emparejar caras por reconocimiento se
  equivoca y pone la cara incorrecta bajo un funcionario (defecto grave en gobierno).

**Lo que NO funciona (probado y falló):**
- ❌ Recortar por coordenadas a ojo del render → descentrado / fotos cortadas.
- ❌ Detección de color del anillo → junta círculos adyacentes / no detecta.
- ❌ Match facial a mano o por VLM → caras cruzadas.
- ✅ **PyMuPDF `get_image_info` (posición embebida) → perfecto.**

PDF **escaneado** (sin estructura embebida) → ahí sí un detector ML: **Surya** o **PaddleOCR
PP-Structure** (devuelven bounding boxes). Pero el caso normal (orden del día, oficios) es digital.

Nota: extract-photos.py usa PyMuPDF (AGPL). Alternativa permisiva: **pypdfium2** (PDFium/BSD),
que también expone objetos imagen con posición.

## Techo honesto (qué NO se puede)

- Los **assets crudos** (fotos, logos, texto, fuentes, colores) se extraen limpios.
- La **composición / el diseño / los fondos decorativos ("pixel")** NO se extraen como editables → se reconstruyen, se recrean en CSS, o se reusan como raster (asset `background` o el render completo de la página como fondo).
- HTML→PDF es **RGB**; para imprenta CMYK/Pantone hay desfase de color (ok para pantalla/WhatsApp/PDF digital).

## Cross-refs

- Para replicar look-and-feel de una página → `pdf-clone`.
- Para solo extraer texto → `pdf-reader`.
- Si el comando `pdf-assets` no se encuentra: `/home/node/.claude/skills/doc-remix/pdf-assets mine <archivo>`.
