---
name: voice
description: Text-to-speech with Mexican Spanish voices (ElevenLabs) and voice cloning
allowed-tools: Bash(text-to-speech:*),Bash(clone-voice:*),Bash(ffmpeg:*),Bash(yt-dlp:*)
---

# Voice Replies

When the user asks you to respond with voice, or when replying to a voice note and a voice reply feels natural, generate audio.

## Voice catalog

Pick the voice that fits the moment:

| Voice | Style | When to use |
|-------|-------|-------------|
| `antonio` | Confident, gentle, latino | **Default** — everyday conversation |
| `jc` | Energetic, broadcaster | News, data, exciting updates |
| `brian` | Warm, soft, podcast | Long explanations, calm tone |
| `daniel` | Young, natural, casual | Casual banter, young audience |
| `enrique` | Rich, credible, narrator | Serious narration, formal reports |
| `maya` | Dynamic, Mexican female | Female storytelling, energetic |
| `cristina` | Young, conversational, Mexican female | Female casual chat |
| `regina` | Sweet, friendly, Mexican female | Female warm/professional |
| `custom` | Cloned voice | When group has a custom cloned voice |

```bash
# Default voice (antonio)
text-to-speech "Qué onda, aquí el resumen de hoy" antonio

# Energetic delivery
text-to-speech "Última hora: el servidor está al 99% de uptime" jc

# Calm explanation
text-to-speech "Te explico cómo funciona el sistema de pagos" brian

# Custom cloned voice (if available)
text-to-speech "Esto con la voz personalizada" custom
```

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

**IMPORTANT:** YouTube blocks ALL requests without cookies. NEVER try without cookies. ALWAYS use this exact command:

```bash
yt-dlp --cookies /workspace/youtube-cookies.txt --remote-components ejs:github -x --audio-format wav -o "/workspace/group/yt-audio.%(ext)s" "YOUTUBE_URL"
```

The cookies file is pre-mounted at `/workspace/youtube-cookies.txt`. Do NOT try cobalt, invidious, or any other workaround — they all fail. Use yt-dlp with cookies directly.

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
This uploads the audio to ElevenLabs, creates a cloned voice, and saves it to the group config. Future calls with `text-to-speech "text" custom` will use the cloned voice.

To stop using the cloned voice: delete `/workspace/group/voice_config.json`.

## Important

- ALWAYS write text in Mexican Spanish with natural, casual expressions
- Only use voice when explicitly asked or when replying to a voice note
- Do NOT call TTS APIs directly — always use these scripts
- Voice cloning needs at least 10 seconds of clear audio (30s+ is better)
