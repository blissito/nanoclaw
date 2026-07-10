---
name: sintesis-docs
description: Sintetizar o redactar un entregable a partir de varios documentos fuente (o pocos muy grandes) que juntos NO caben en la ventana de contexto — reportes multi-fuente, due diligence, análisis/comparación de contratos, resúmenes de expediente, investigación. Úsalo cuando debas correlacionar información entre múltiples documentos y producir un documento nuevo, y leerlos todos completos reventaría el contexto ("Prompt is too long"). NO es para leer un solo documento corto.
allowed-tools: Read, Write, Bash, Grep
---

# Síntesis de documentos — de un corpus grande a un entregable

Principio: un entregable que correlaciona muchas fuentes NO se redacta releyendo cada documento completo cada vez que se necesita un dato. Se redacta desde una síntesis (`analysis/notas.md`) construida en UNA sola lectura por documento, y se consulta el original solo por rebanadas puntuales. **El killer de contexto es releer, no leer.**

## Cuándo aplica

- Varios documentos (5+) que hay que cruzar: un reporte a partir de N PDFs, due diligence, comparar/analizar contratos, resumen de un expediente, investigación multi-fuente.
- O pocos documentos pero muy grandes (una sola fuente de cientos de páginas).
- Señal de que lo necesitas: leer todo de corrido daría "Prompt is too long", o ya te pasó.

## 1. Extraer una vez → a archivo (nunca a stdout suelto)

Por cada documento, extrae a texto plano UNA vez y **redirige a archivo** (el `extract` a pantalla vuelca todo al contexto y lo satura):

```bash
office-reader extract "fuente.docx" > analysis/02_fuente.txt     # Word / Excel
pdf-reader   extract "fuente.pdf"   > analysis/06_fuente.txt     # PDF
```

Numera con prefijo (`01_`, `02_`…) para orden estable. NUNCA `Read` sobre el binario original; NUNCA re-extraigas algo que ya volcaste a `analysis/`.

## 2. Índice de notas con anclas de línea

Lee cada `.txt` UNA sola vez y vuelca a `analysis/notas.md` lo relevante (hechos, cifras, cláusulas, hallazgos) **con su número de línea en la fuente**:

```
[06_fuente.txt:142] hallazgo clave: ...
[02_fuente.txt:88]  cifra: $1,250,677.20 ...
```

`notas.md` es tu memoria de trabajo comprimida. Redacta el entregable **desde `notas.md`**, no desde los `.txt` crudos. Como vive en disco, sobrevive a las auto-compactaciones del contexto: si el SDK compacta y pierdes detalle, lo recuperas releyendo `notas.md` (chico), no los originales.

## 3. Gotcha: límite de `Read` (~25k tokens por llamada)

`Read` trunca en silencio los archivos largos. Antes de leer un `.txt` grande: `wc -l archivo.txt`, luego léelo con `offset`/`limit` en pasadas (p.ej. 2000 líneas) y confirma que cubriste el total. No asumas que una sola llamada capturó todo el archivo.

## 4. Citas verbatim — por rebanada, no por relectura

Cuando necesites el texto exacto de una fuente durante la redacción:

```bash
grep -n "palabra clave" analysis/06_fuente.txt   # ubica la línea
sed -n '120,180p'       analysis/06_fuente.txt   # lee solo esa franja
```

Nunca vuelvas a `Read` el archivo completo solo para citar un fragmento.

## 5. Entregables largos — por partes / dos pasadas

Si el entregable es largo o el usuario pide "manda cada sección conforme la termines":

- Genera el documento **incrementalmente**. Para `.docx`, patrón de dos pasadas con `python-docx`: un script crea el documento + escribe las primeras secciones y guarda; el siguiente reabre (`Document(path)`) y agrega. Verifica integridad al final (`len(doc.paragraphs)`, `ls -la`).
- **Reporta avance** con mensajes de progreso conforme cierras cada sección. Además de ser buena UX en canales de chat, en entornos con timeout por inactividad cada emisión mantiene vivo el proceso.

## PROHIBIDO

- Releer completo un `.txt` que ya sintetizaste en `notas.md`.
- Tener todos los documentos completos en contexto a la vez.
- `Read`/`cat` sin `limit` de una fuente que ya procesaste.

## Cross-refs

- `office-reader` / `pdf-reader` — extracción a texto plano (paso 1).
- `big-files` — si alguna fuente viene comprimida (.zip).
- `structured-doc` — para entregables tabulares/estructurados.
- `escrito-juridico` — especialización legal (recursos, demandas, amparos): aplica este mismo patrón + verificación de jurisprudencia SCJN y esqueletos procesales.
