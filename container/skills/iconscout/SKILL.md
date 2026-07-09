---
name: iconscout
description: Busca y descarga assets de diseño (iconos, ilustraciones, 3D, animaciones Lottie, imágenes AI) desde IconScout. Dispara cuando el user pida un icono/ilustración/animación para un diseño, mockup, presentación o web, o mencione IconScout. 13.8M+ assets con licencia royalty-free.
allowed-tools: Bash
---

# IconScout — assets de diseño

Acceso a más de 13.8M iconos, ilustraciones, iconos 3D, animaciones Lottie e imágenes AI vía la API v3 de IconScout. Las credenciales están a nivel droplet (mismas para todos los grupos), así que **las descargas premium consumen la cuota del dueño de la cuenta** — usa `free` por defecto salvo que el user pida premium explícitamente.

Usa el script `~/.claude/skills/iconscout/iconscout` (no llames la API directo con curl). Su salida es compacta a propósito para no inflar el contexto.

## Buscar

```bash
~/.claude/skills/iconscout/iconscout search "<query>" [asset] [price] [limit]
```

- **asset**: `icon` (default) · `illustration` · `3d` · `lottie` · `ai_image`
- **price**: `all` (default) · `free` · `premium`
- **limit**: cuántos resultados imprimir (default 8)

Imprime una línea por asset: `<uuid> | <nombre> [free|premium] | <preview_url>`. Toma el `uuid` para descargar.

```bash
# Iconos flat gratis de redes sociales
~/.claude/skills/iconscout/iconscout search "social media" icon free

# Ilustraciones SVG (filtra formato al descargar)
~/.claude/skills/iconscout/iconscout search "team work" illustration

# Animación Lottie de loading
~/.claude/skills/iconscout/iconscout search "loading spinner" lottie free
```

## Descargar

```bash
~/.claude/skills/iconscout/iconscout download <uuid> <format> [width] [height] [outfile]
```

Devuelve un URL firmado temporal, baja el archivo y **imprime solo la ruta local** guardada (por defecto `attachments/<uuid>.<format>`). Luego mándalo con `mcp__nanoclaw__send_message`.

**Formatos válidos por tipo:**

| Asset | Formatos | width/height |
|-------|----------|--------------|
| `icon` | `svg`, `png` | png: px (ej. 512). svg: `0 0` |
| `illustration` | `svg`, `png`, `eps` | igual que icon |
| `3d` | `png`, `gltf`, `glb`, `obj`, `fbx`, `blend` | 3D: se ignoran (`0 0`) |
| `lottie` | `json`, `lottie`, `gif`, `mp4` | vector: `0 0` |
| `ai_image` | `png`, `jpg` | px |

```bash
# Icono SVG (vector → 0 0)
~/.claude/skills/iconscout/iconscout download a1b2c3d4-... svg 0 0

# Icono PNG a 512px
~/.claude/skills/iconscout/iconscout download a1b2c3d4-... png 512 512

# Lottie como JSON
~/.claude/skills/iconscout/iconscout download b2c3d4e5-... json 0 0
```

## Flujo típico

1. **Buscar** → mostrar al user 3-5 opciones con su preview.
2. **Esperar elección** (o elegir la más relevante si pidió "el que sea").
3. **Descargar** en el formato correcto para su caso (SVG para editar/escalar, PNG 512 para pegar, JSON para Lottie).
4. **Entregar** el archivo con `send_message` (imagen para png/svg render, documento para json/eps/3d).

## Notas

- Sin subscripción premium activa, descargar un asset `premium` devuelve error 422 — filtra con `price free` o avisa al user.
- El `download_url` es efímero; el script ya baja el archivo, no guardes el URL.
- Formatos vectoriales (`svg`, `json`, `lottie`, `gltf`) siempre con `width height` = `0 0`.
