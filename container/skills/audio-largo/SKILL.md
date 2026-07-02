---
name: audio-largo
description: Transcribe a texto el HABLA de un audio largo o pesado (reuniones, notas de voz reenviadas, grabaciones de 10–60+ min). Trocea con ffmpeg y transcribe cada parte con Whisper, sin toparse con el límite de 25MB de la API. Úsala cuando llegue un [Audio file: ...] y el usuario pida "transcribe", "qué dice", "analiza el audio", o para resumir/analizar una grabación de voz.
allowed-tools: Bash(audio-largo:*),Bash(ffprobe:*),Bash(ffmpeg:*)
---

# Audio Largo (transcripción)

Para pasar a texto el **habla** de audios largos o pesados. Whisper vía API tiene un tope de 25MB por archivo; esta skill parte el audio en segmentos de 10 min y transcribe cada uno, así maneja grabaciones de cualquier duración.

## Cuándo usarla

- Llega un `[Audio file: attachments/audio-….m4a]` (audio reenviado, no nota de voz) y el usuario pide transcribir, resumir o analizar lo que se dice.
- Notas de voz largas o grabaciones de reuniones donde necesitas el contenido literal.
- NO es para describir música o "vibe" — para eso usa `audio-analyze`.

## Uso

```bash
audio-largo /workspace/group/attachments/audio-1783004764476.m4a
```

Acepta `.ogg`, `.opus`, `.mp3`, `.m4a`, `.mp4`, `.wav`, `.aac`. Idioma por defecto español (`AUDIO_LARGO_LANG=es`).

## Qué devuelve

La **transcripción completa** en texto (concatenada de todos los segmentos), lista para que la leas y hagas el resumen, análisis o lo que pida el usuario. Los segmentos se van imprimiendo conforme se transcriben.

## Notas

- Requiere `OPENAI_API_KEY` (ya está en el contenedor). Sin ella, la skill falla y te avisa.
- Un audio de ~50 min ≈ 6 segmentos; la transcripción tarda ~1–2 min.
- Para el análisis (postura/argumentos/temas), primero corre esta skill para tener el texto y luego razona sobre él; no inventes lo que "supuestamente" dice.
