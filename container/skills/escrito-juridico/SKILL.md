---
name: escrito-juridico
description: Redactar escritos jurídicos mexicanos largos (recursos de apelación, demandas, contestaciones, amparos) a partir de varios documentos de un expediente (demanda, contestación, pericial, confesional, sentencia), entregados como .docx editable. Úsalo cuando el usuario pida "recurso de apelación", "redacta el escrito", "haz la demanda/contestación en Word", o cualquier pieza procesal larga que deba correlacionar agravios/hechos con documentos fuente y jurisprudencia verificada.
allowed-tools: Read, Write, Bash, Grep, WebSearch, mcp__nanoclaw__send_message
---

# Escrito jurídico (recurso, demanda, contestación) — de expediente a .docx

Principio: un escrito jurídico largo no se redacta releyendo el expediente completo cada vez que se necesita un dato. Se redacta desde una síntesis (`notas.md`) construida en UNA sola lectura, y se entrega en un `.docx` armado en dos o más pasadas de script. Todo lo demás en esta skill sirve a esas dos reglas.

## 1. Fase de análisis — una sola lectura por documento

Para cada documento del expediente (demanda, contestación, pericial, confesional, sentencia):

1. Extrae a texto plano UNA vez: `office-reader extract "archivo.docx" > analysis/02_demanda.txt` o `pdf-reader extract "archivo.pdf" > analysis/06_sentencia.txt`.
2. Lee ese `.txt` completo UNA sola vez (con `Read` en chunks si hace falta — ver §2).
3. En esa única lectura, vuelca a `analysis/notas.md` los hechos, agravios, considerandos, cláusulas o extractos relevantes **con su número de línea** en el archivo fuente (ej. `[06_sentencia.txt:142] considerando 5°: ...`).

Después de este paso, **prohibido volver a leer el `.txt` completo**. Para una cita textual exacta durante la redacción:

```bash
grep -n "palabra clave" analysis/06_sentencia.txt
sed -n '120,180p' analysis/06_sentencia.txt   # solo la franja que marcó el grep
```

Redacta siempre desde `notas.md`, no desde el `.txt` crudo. Este es el mismo mandato de CLAUDE.md ("Varios documentos — OBLIGATORIO"), aquí aplicado paso a paso.

## 2. Gotcha: límite de tokens del tool Read

`Read` tiene un límite duro (~25000 tokens por llamada). Un `.txt` de sentencia o pericial largo puede exceder eso en una sola llamada y truncar silenciosamente contenido importante.

**Fix:** usa `offset`/`limit` en llamadas sucesivas (ej. `limit: 2000` líneas por llamada) y confirma con `wc -l archivo.txt` cuántas pasadas hacen falta antes de empezar. No asumas que una sola llamada capturó todo el archivo — verifica el conteo de líneas leídas contra `wc -l`.

## 3. Verificación de jurisprudencia — NUNCA inventar

Regla dura, sin excepción: nunca cites número de tesis, registro, rubro o texto de jurisprudencia/tesis que no hayas verificado en esta sesión.

- **`mcp__easybits__research_search` está roto** (`SERVICE_CONFIG_ERROR`, falta `BRIGHTDATA_API_TOKEN`). No lo uses para esto — vas a perder tiempo con un error de config, no de contenido.
- **Usa `WebSearch`** como verificador real. Portales válidos de la SCJN:
  - `sjf2.scjn.gob.mx/detalle/tesis/[registro]` — tesis más antiguas.
  - `sjfsemanal.scjn.gob.mx/detalle/tesis/[registro]` — tesis y jurisprudencia recientes (ej. registro 2027621 confirmado ahí).
- Si citas un artículo de ley, verifica vigencia cuando el asunto sea sensible — las leyes se reforman.

### Cuando NO puedes verificar una tesis a tiempo

Esto va a pasar: hay tesis citadas por la contraparte o por la propia sentencia que no logras confirmar con una búsqueda razonable. La resolución NO es bloquear la entrega ni inventar el contenido. Es:

1. Usa lenguaje cauteloso en el propio escrito — reserva el derecho a impugnar la aplicabilidad de la tesis en lugar de afirmar como hecho un texto que no confirmaste (ej. "la contraparte invoca la tesis con Registro X, cuya aplicabilidad al caso concreto se reserva impugnar").
2. Flagea explícitamente el hueco de verificación al cliente en el mensaje de entrega, recomendando confirmación directa en sjf2.scjn.gob.mx antes de presentar el escrito.

Esto pasó en esta sesión con Registro 223791 y 216554 (citadas por la propia sentencia, no verificables a tiempo) vs. Registro 2027621 (1a./J. 178/2023, sí verificada y citada con confianza plena). El criterio de "hedgear + avisar" es el patrón correcto bajo presión de tiempo, no un parche de emergencia.

## 4. Generación del .docx — patrón de dos (o más) pasadas

python-docx (`docx` v1.2.0+) es la librería. Patrón para entrega por secciones (cuando el cliente pide "manda cada sección conforme la termines" o el escrito es largo):

**Script 1 (`gen_p1.py`)** — crea el documento, escribe proemio + primeras secciones, guarda:

```python
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING  # OJO: ambos viven en docx.enum.text, NO en docx.enum.paragraph
from docx.oxml.ns import qn

doc = Document()
doc.styles['Normal'].font.name = 'Times New Roman'
doc.styles['Normal'].font.size = Pt(12)
sec = doc.sections[0]
sec.left_margin = Cm(3); sec.right_margin = Cm(2)
sec.top_margin = Cm(2.5); sec.bottom_margin = Cm(2.5)

def p(text="", bold=False, center=False, justify=False, size=12, space_after=8, italic=False):
    par = doc.add_paragraph()
    par.paragraph_format.space_after = Pt(space_after)
    par.paragraph_format.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIVE
    if center: par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    elif justify: par.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    run = par.add_run(text)
    run.bold = bold; run.italic = italic; run.font.size = Pt(size)
    return par

# ... proemio, antecedentes, agravio primero ...
doc.save("/workspace/group/analysis/recurso_apelacion.docx")
```

**Script 2+ (`gen_p2.py`, `gen_p3.py`...)** — reabre el mismo archivo y sigue agregando:

```python
from docx import Document
PATH = "/workspace/group/analysis/recurso_apelacion.docx"
doc = Document(PATH)  # reabre lo ya escrito
# redefinir p()/heading()/subheading() igual que en p1
# ... agravio segundo en adelante, petitorios, protesta/firma ...
doc.save(PATH)
```

Este patrón permite mandar cada sección al cliente conforme se completa (con `send_message` + `document_path` apuntando al `.docx` actualizado) sin perder cohesión — al final es un solo archivo, no fragmentos.

**Antes de la entrega final:** verifica integridad — cuenta de párrafos (`len(doc.paragraphs)`) y tamaño de archivo (`ls -la`) — para descartar corrupción del proceso de guardar/reabrir dos veces.

## 5. Esqueleto estándar de un recurso de apelación (CDMX/CPCDMX)

Reutilizable como outline para futuras solicitudes similares:

1. **Proemio** — dirigido al juez de origen (ej. "C. JUEZ CUARTO DE LO CIVIL DE LA CIUDAD DE MÉXICO"), quién apela, contra qué sentencia y expediente.
2. **Antecedentes** — hechos numerados del expediente, extraídos de `notas.md`.
3. **Agravios** — uno por cada error identificado, cada uno correlacionado explícitamente con el considerando/resolutivo específico de la sentencia que ataca (cita con número de línea del `.txt` fuente cuando sea posible). Fundamenta cada agravio con artículos aplicables (CPCDMX/CCDMX) y, si aplica, tesis verificada.
4. **Capítulo de argumentos adicionales** — respuestas a excepciones o argumentos de la contraparte que la sentencia no resolvió bien.
5. **Petitorios** — puntos petitorios numerados, cerrando con protesta y firma.

## PROHIBIDO

- Releer un `.txt` completo de un documento ya procesado en `notas.md` (rompe la disciplina de contexto — CLAUDE.md).
- Citar un número de registro/tesis/artículo sin haberlo verificado en esta sesión (WebSearch o vigencia confirmada).
- Usar `mcp__easybits__research_search` para verificar jurisprudencia — está roto (falta config de BrightData), no reintentes en loop esperando que funcione.
- Bloquear la entrega completa del escrito por una sola tesis no verificable — hedgea esa cita puntual y avisa al cliente, no detengas todo el documento.
- Importar `WD_LINE_SPACING` desde `docx.enum.paragraph` (no existe ahí; incidente de esta sesión, corregido usando `docx.enum.text`).

## Robustez

Si `WebSearch` no encuentra una tesis tras 2-3 intentos con variaciones de la query (número de registro, rubro parcial, año + materia), no sigas intentando indefinidamente — pasa al protocolo de §3 (hedge + avisar). Los agravios y petitorios NO dependen de esa tesis para ser válidos; el fundamento legal (artículos del código) sostiene el argumento aunque la tesis quede pendiente de confirmación.

## Techo honesto

Esta skill no sustituye la revisión de un abogado titulado antes de presentar el escrito ante el juzgado. Cualquier entrega debe recordar al cliente (con naturalidad, no como muletilla en cada mensaje) que esto es un borrador para revisión del despacho, y que cualquier tesis/artículo marcado como "no verificado en esta sesión" debe confirmarse directamente en sjf2.scjn.gob.mx o sjfsemanal.scjn.gob.mx antes de firmar o presentar.

## Cross-refs

- `doc-remix` — para rehacer documentos con marca/logo/fotos institucionales sin usar difusión de imagen (no aplica a escritos jurídicos puros, pero sí si el escrito lleva membrete o anexos con logotipos).
- `office-reader` — extracción de `.docx`/`.doc` a texto plano (paso 1 de §1).
- `pdf-reader` — extracción de `.pdf` a texto plano (paso 1 de §1, para sentencias/pericial en PDF).
- `big-files` — si algún anexo del expediente viene comprimido (.zip).
