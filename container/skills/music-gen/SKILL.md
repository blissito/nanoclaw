---
name: music-gen
description: Genera música/pistas (instrumental o con voz) desde un prompt usando ElevenLabs Music. Úsala cuando pidan "créame un audio/música así", "una pista lo-fi", o describan mood/género/duración.
allowed-tools: Bash(generate-music:*),Bash(analyze-audio:*),Bash(ffmpeg:*)
---

# Music Gen

Genera una pista de música a partir de un prompt en texto (ElevenLabs Music). El resultado se entrega como nota de audio reproducible.

## Cuándo usarla

- "Ghosty, créame una pista lo-fi de 20 segundos", "música épica para un reel", "algo relajante con piano".
- Para replicar un ejemplo: primero corre `analyze-audio` sobre el audio de referencia, usa esa descripción (mood/género/instrumentos) para armar el prompt, y luego genera.

## Uso

```bash
generate-music "lo-fi chill instrumental, piano suave, beat relajado, sin voz" 20
```

- Arg 1: prompt describiendo la música (mood, género, instrumentos, con/sin voz). Mientras más específico, mejor.
- Arg 2 (opcional): duración en segundos (default 20).

Imprime la ruta del archivo `.ogg` generado.

## Enviar la música

```
mcp__nanoclaw__send_message({ text: "Aquí tu pista 🎵", audio_path: "/workspace/group/attachments/music-123.ogg" })
```

El archivo ya es Opus `.ogg`, así que reproduce inline sin problemas. Si el usuario prefiere el archivo descargable, manda el `.mp3` (déjalo sin transcodear) vía `document_path`.

## Notas

- Para "una pista como esta" a partir de un audio: SIEMPRE `analyze-audio` primero, no inventes el género.
- Avisa antes si va a tardar: la generación puede tomar varios segundos.
- Escribe el prompt con detalle (mood + género + instrumentos + con/sin voz + tempo).
