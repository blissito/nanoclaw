---
name: audio-analyze
description: Analiza el CONTENIDO de un audio (música o voz) — duración exacta + mood/género/instrumentos/tempo aproximado. Úsala cuando el usuario pida entender, describir o replicar un audio de ejemplo. NUNCA inventes BPM, tonalidad, mood o género: corre esta skill.
allowed-tools: Bash(analyze-audio:*),Bash(ffprobe:*),Bash(ffmpeg:*)
---

# Audio Analyze

Para entender qué hay DENTRO de un audio. La transcripción de voz (whisper) solo sirve para habla; para música o para describir el "vibe" de un ejemplo, usa esta skill.

## Cuándo usarla

- El usuario manda un audio/nota de voz y pide "qué dice", "describe este audio", "qué tipo de música es", "cópiame algo así".
- Antes de generar música con `music-gen` a partir de un ejemplo: analiza primero para acertarle al mood/género.

## Uso

```bash
analyze-audio /workspace/group/attachments/voice-1234567890.ogg
```

Funciona con `.ogg`, `.mp3`, `.wav`, `.m4a`, etc.

## Qué devuelve

1. **Datos exactos (ffprobe):** duración, códec, sample rate, canales. Estos SÍ son medición real.
2. **Descripción del contenido (modelo de audio):** si es música o voz; y si es música: mood, género/estilo, instrumentos, tempo aproximado, si trae voz/letra.

## Honestidad (importante)

- La **duración** es exacta (ffprobe).
- Mood, género, instrumentos y tempo/BPM son **estimaciones del modelo**, NO una medición DSP exacta. Preséntalos como aproximados.
- Si necesitas BPM/tonalidad exactos, dilo: no hay analizador DSP instalado, solo la estimación del modelo.
- Nunca inventes números: si no corriste `analyze-audio`, no des BPM ni key.
