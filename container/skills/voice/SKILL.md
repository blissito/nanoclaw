---
name: voice
description: Text-to-speech with Spanish voices (Kokoro, local & free) and OpenAI fallback
allowed-tools: Bash(text-to-speech:*),Bash(clone-voice:*),Bash(ffmpeg:*),Bash(yt-dlp:*)
---

# Voice Replies

When the user asks you to respond with voice, or when replying to a voice note and a voice reply feels natural, generate audio.

## Voice catalog

Kokoro runs locally (free, no API key). It ships 3 Spanish voices:

| Voice | Style | When to use |
|-------|-------|-------------|
| `santa` | Male, Spanish | **Default** — everyday conversation |
| `alex` | Male, Spanish | Alternative male voice |
| `dora` | Female, Spanish | Female delivery |

```bash
# Default voice (santa)
text-to-speech "Qué onda, aquí el resumen de hoy"

# Alternative male voice
text-to-speech "Última hora: el servidor está al 99% de uptime" alex

# Female voice
text-to-speech "Te explico cómo funciona el sistema de pagos" dora
```

Legacy names (antonio, jc, brian, daniel, enrique, maya, cristina, regina) still
work — they remap to the closest Kokoro voice. If Kokoro is unavailable the script
falls back to OpenAI `onyx`.

## Sending voice

```
mcp__nanoclaw__send_message({ text: "voice", audio_path: "/workspace/group/tts-123.ogg" })
```

## Voice cloning

### From audio attachment
When someone sends an audio/video and says "clona esta voz", "usa esta voz", "guarda esta voz":

```bash
clone-voice /workspace/group/attachments/audio-123.ogg "nombre-de-la-voz"
```

### From video attachment (extract audio first)
If they send a video file (.mp4, .mov, etc.):

```bash
ffmpeg -i /workspace/group/attachments/video.mp4 -vn -acodec libopus /workspace/group/extracted-audio.ogg -y
clone-voice /workspace/group/extracted-audio.ogg "nombre-de-la-voz"
```

### From YouTube link
When someone sends a YouTube URL and says "clona la voz de este video", "baja este video", "descarga el audio" or similar:

**IMPORTANT:** YouTube blocks ALL requests without cookies. NEVER try without cookies. ALWAYS copy cookies first (source is read-only), then use yt-dlp:

```bash
cp /workspace/youtube-cookies.txt /tmp/yt-cookies.txt
yt-dlp --cookies /tmp/yt-cookies.txt --remote-components ejs:github -x --audio-format wav -o "/workspace/group/yt-audio.%(ext)s" "YOUTUBE_URL"
```

The cookies file is pre-mounted at `/workspace/youtube-cookies.txt` (read-only). You MUST copy it to `/tmp/` first because yt-dlp needs to write to it. Do NOT try cobalt, invidious, or any other workaround — they all fail. Use yt-dlp with cookies directly.

Then clone:
```bash
clone-voice /workspace/group/yt-audio.wav "nombre-de-la-voz"
```

**Warn the user first:** YouTube download + voice cloning takes ~1-2 minutes. Send a message before starting:
```
mcp__nanoclaw__send_message({ text: "Descargando audio de YouTube y clonando la voz, dame 1-2 min..." })
```

For best results, pick a video with clear speech (no music, no background noise).

### After cloning
> ⚠️ Voice cloning relied on ElevenLabs and is currently **unavailable** (no active
> ElevenLabs plan). Kokoro does not support cloning. Calls with `custom`/`cloned`
> fall back to the default `santa` voice. The cloning instructions below are kept
> for when an ElevenLabs plan is restored.

## Important

- ALWAYS write text in Mexican Spanish with natural, casual expressions
- Only use voice when explicitly asked or when replying to a voice note
- Do NOT call TTS APIs directly — always use these scripts
- Voice cloning needs at least 10 seconds of clear audio (30s+ is better)
