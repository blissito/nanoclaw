---
name: big-files
description: Handle large files (>5 MB) and compressed archives (ZIP, TAR, RAR, 7z) before processing them. Triggers when an inbound message contains `[Document: attachments/X.<ext> (NKB)]` with N > 5000, OR any archive (.zip, .tar, .tar.gz, .tgz, .rar, .7z, .gz, .bz2) regardless of size. Reading binary blobs inline blows the context with "Prompt is too long" — this skill replaces blind `Read`/extraction with inspect-then-ask.
allowed-tools: Bash
---

# big-files — inspect before processing

## Why this exists

Meter contenido binario al contexto rompe la conversación con "Prompt is too long". Un ZIP de 100 MB extraído y leído entero, o un PDF de 200 páginas pasado por `Read` directo, sacan al modelo del prompt window y abortan el turno.

La regla simple: **nunca proceses un archivo grande a ciegas. Inspecciona, reporta al usuario, pregunta qué quiere, procesa lo pedido.**

## Cuándo invocar esta skill

Apenas detectes en el mensaje entrante cualquiera de estos patrones:

- `[Document: attachments/X.<ext> (NKB)]` con `N > 5000` (archivo > 5 MB).
- Extensión de archivo comprimido: `.zip`, `.tar`, `.tar.gz`, `.tgz`, `.gz`, `.bz2`, `.rar`, `.7z` — sin importar tamaño.

No esperes a que el usuario pida "ten cuidado" — aplica el protocolo automático.

## Protocolo

### Paso 1 — NO leas el binario crudo

Estas operaciones rompen el contexto y están prohibidas en archivos grandes:

- `Read attachments/X.zip` (o cualquier binario)
- `cat attachments/X.pdf`
- `unzip -p X.zip` sin filtrar
- Cualquier dump del archivo completo a stdout

### Paso 2 — Inspecciona

Según el tipo:

```bash
# ZIP
unzip -l attachments/X.zip

# TAR / TAR.GZ
tar -tzf attachments/X.tar.gz

# 7z
7z l attachments/X.7z

# RAR
unrar l attachments/X.rar

# PDF grande — metadata sin extraer texto
pdf-reader info attachments/X.pdf

# Office grande
office-reader info attachments/X.xlsx   # si existe el subcomando
ls -lh attachments/X.xlsx               # fallback: solo tamaño
```

### Paso 3 — Resume al usuario

Reporta cantidad de archivos, tipos predominantes, tamaño total. Ejemplo:

> Recibí `Jarcería.zip` (113 MB). Adentro vienen 47 archivos:
> • 12 PDFs (catálogos)
> • 30 JPGs (fotos de producto)
> • 5 XLSX (precios)
> ¿Qué necesitas que procese?

### Paso 4 — Procesa solo lo pedido, uno a la vez

Después de que el usuario indique qué le interesa:

```bash
# Extraer SOLO los archivos pedidos
unzip attachments/X.zip "ruta/dentro/del/zip/archivo.pdf" -d attachments/X/

# Luego procesar con la tool especializada
pdf-reader extract attachments/X/archivo.pdf --layout
```

Para PDFs >30 páginas: pregunta qué sección/páginas interesan antes de hacer un resumen completo (`pdf-reader extract X.pdf --pages 1-5`).

Para Office grandes: lo mismo — `office-reader` extrae texto sin meter bytes al contexto.

## Anti-patrón conocido (incidente 2026-05-14)

Cliente mandó `Jarcería.zip` (113 MB). El bot intentó procesarlo de un golpe → Anthropic API devolvió "Prompt is too long" → el turno abortó y el cliente vio el error literal en WhatsApp.

Fix: este protocolo. Si lo hubiera tenido, habría respondido "este ZIP trae 47 archivos, ¿cuál te cotizo primero?" en lugar de quemar el turno.

## Cuándo NO aplicar

- Archivos <5 MB no-archivo (PDF chico, imagen, audio): procesa normal con la tool correspondiente.
- Texto inline `[Document: ... .txt]` con contenido ya incluido en el mensaje: el host ya lo extrajo, no hay binario que leer.
- Imágenes (.jpg, .png, .webp): el pipeline de vision las maneja por separado, no aplican aquí aunque sean grandes.
