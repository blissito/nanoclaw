---
name: oficio
description: Redacta un oficio, circular, memorándum, carta o convocatoria institucional DESCTI y entrégalo como .docx EDITABLE (no PDF, no HTML). Úsala ante "haz un oficio", "redacta un oficio/carta/circular/memo", "necesito un oficio para...". NO es para clonar un PDF existente (eso es doc-remix); esto es redactar texto institucional nuevo.
allowed-tools: Bash(python3:*), Bash(curl:*), Write, Read
---

# oficio — redactar oficios institucionales en .docx editable

## Cuándo

Para **documentos de texto que fluye**: oficios, circulares, memorándums, cartas, convocatorias en prosa, dictámenes. Es **redacción nueva**, no clonar un arte existente.

- ¿Te pasan un PDF y quieren "una nueva versión / clon / remix" de su diseño? → eso es **`doc-remix`**, no esto.
- ¿Es una cotización/factura/recibo (campos en tabla)? → eso es **`structured_doc`** (rama tabular de `doc-remix`).
- ¿Es un oficio/carta/circular/memo (prosa)? → **aquí**.

## El defecto que esto elimina

Antes los oficios se armaban con `create_document` + `set_page_html` = **HTML en una página de alto fijo**. Todo lo que pasa de una hoja **se corta en la página 1** (incidente 2026-06-05, descti-innovación). Un `.docx` reflujea solo en Word: **pagina sin cortarse** y además queda **editable** para que el cliente complete el consecutivo, la firma y el sello. Por eso oficio = `.docx`, siempre.

> **PROHIBIDO** armar un oficio con `create_document`/`set_page_html`/`structured_doc`→PDF. Oficio/carta/prosa → SIEMPRE `oficio-docx.py`.

## Patrón: template + data (tú solo armas el JSON)

Igual que `structured_doc`: tú produces un **JSON con el contenido**, el helper hace el membrete (logo DESCTI + regla granate), márgenes, tipografía Arial, cuerpo justificado y firma. No escribes HTML ni colocas el logo a mano.

### 1. Arma el contenido como JSON

Saca el texto de lo que te pidan. Si el oficio se basa en uno previo (mismo formato), mina ese PDF con `doc-remix`/`pdftotext` y toma el texto GROUNDED — no transcribas a ojo. Campos (todos opcionales **salvo `cuerpo`**):

```json
{
  "no_oficio": "DESCTI/DI/045/2026",
  "lugar_fecha": "Pachuca de Soto, Hidalgo, a 5 de junio de 2026",
  "destinatario": {
    "nombre": "MTRO. JUAN PÉREZ LÓPEZ",
    "cargo": "Director General de Vinculación y Transferencia",
    "dependencia": "Secretaría de Educación Pública de Hidalgo",
    "linea_extra": "P R E S E N T E."
  },
  "asunto": "Solicitud de colaboración interinstitucional",
  "cuerpo": ["Primer párrafo del oficio...", "Segundo párrafo..."],
  "despedida": "Sin otro particular, le reitero la seguridad de mi atenta consideración.",
  "firma": { "nombre": "DR. CARLOS MENDOZA", "cargo": "Director de Innovación, DESCTI" },
  "ccp": ["C.c.p. Archivo.", "C.c.p. Minutario."],
  "membrete_lineas": ["DIRECCIÓN DE INNOVACIÓN"]
}
```

- **El membrete lo pone el helper solo** (logo DESCTI canónico + regla granate, se repite en cada página). NO metas el logo en el cuerpo. Para otra dependencia pasa `logo_url`.
- **`cuerpo` es una lista de párrafos** (strings). Escribe el oficio en lenguaje formal institucional (tuteo NO; trato de usted, "le", "su"). Un párrafo por idea.
- **Si NO sabes el consecutivo, déjalo fuera** → sale `_______/2026` para llenar a mano. **No lo inventes**; avísale al usuario que falta.
- `lema` dentro de `firma` es opcional (ej. el lema del gobierno); si no, queda el espacio en blanco para la rúbrica.

### 2. Genera el .docx

Escribe el JSON con `Write` a un archivo y córrelo:

```bash
python3 /home/node/.claude/skills/oficio/oficio-docx.py datos.json /workspace/group/attachments/oficio-<nombre>.docx
```

Imprime la ruta del `.docx`. (Si responde **"falta python-docx"**, la imagen del container todavía no se reconstruyó con la dependencia → genera el oficio con `structured_doc` como PDF **interino** y avisa que el `.docx` queda pendiente del rebuild.)

### 3. Entrega el .docx como adjunto

```
send_message({
  document_path: "/workspace/group/attachments/oficio-<nombre>.docx",
  text: "Aquí tu oficio, editable. Te dejé el consecutivo en blanco para que lo completes."
})
```

**NO lo conviertas a PDF** salvo que lo pidan explícito — el valor del `.docx` es que el cliente lo edita (consecutivo, firma, sello).

## Reglas de redacción (oficio de gobierno)

- Trato de **usted** siempre; lenguaje formal institucional, sin coloquialismos.
- Estructura: destinatario (nombre/cargo/dependencia + "P R E S E N T E.") → asunto → cuerpo → despedida → "A T E N T A M E N T E" + firma → c.c.p.
- Mayúsculas y cargos completos en el destinatario y la firma.
- **No inventes** datos que no tengas: número de oficio, acuerdos citados, nombres. Si faltan, déjalos marcados y pídelos.
- Mira el resultado si dudas: el `.docx` es editable, pero el membrete (logo a tamaño correcto, regla granate) debe verse bien.

## Membrete / logo

El logo DESCTI canónico (PNG transparente, recortado) se descarga solo desde la URL bakeada en el helper. Si cambia la marca o es otra dependencia, pasa `logo_url` (PNG con fondo transparente, ver onboarding de logo en `doc-remix`). El helper lo pone en el header a altura fija — no lo metas en el cuerpo ni lo redibujes con IA.
