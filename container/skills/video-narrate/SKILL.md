---
name: video-narrate
description: Create narrated videos from static images — animates with Kling AI, adds voiceover, optional lip sync
allowed-tools: Bash(video-narrate:*)
---

# Video Narration (Kling + ElevenLabs + LipSync)

Create narrated videos from static images. Each image becomes an animated 5-second clip with voiceover narration. Scenes with people can have lip-synced audio.

## When to use

- User wants a **narrated video** from images (slideshow with voice)
- User says "haz un video narrado", "anima estas fotos con voz", "video con narración"
- User provides multiple images and wants them turned into a story/presentation
- NOT for single image animation (use `generate-gif --animate`) or text-to-video (use `generate-video`)

## Usage

```bash
video-narrate img1.png img2.png img3.png img4.png \
  --prompts "aerial pan of the city" "chef cooking in kitchen" "slow zoom into the plate" "chef talking to camera" \
  --texts "Bienvenidos a la Ciudad de México" "El chef Juan prepara su platillo estrella" "Su especialidad es el mole oaxaqueño" "Les presento mi receta favorita" \
  --lipsync 0 1 0 1 \
  --voice regina
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| images (positional) | Yes | Paths to images (.png/.jpg) |
| `--prompts` | Yes | One per image — describes camera movement/animation style |
| `--texts` | Yes | One per image — narration text (what the voice says) |
| `--lipsync` | No | One 0/1 per image. 1 = lip sync (for scenes with people). Default: all 0 |
| `--voice` | No | ElevenLabs voice (default: antonio). Same voices as text-to-speech |
| `--video-vol` | No | Kling ambient audio volume 0.0–1.0 (default: 0.35) |
| `--narr-vol` | No | Narration volume 0.0–2.0 (default: 1.2) |
| `--output` | No | Output filename (default: auto-generated) |

## How to decide --lipsync per scene

Look at each image:
- **Person talking/facing camera** → `1` (lip sync makes it look natural)
- **Landscape, food, objects, crowd** → `0` (no lips to sync, just overlay narration)

## Cost

| Scene type | Cost |
|------------|------|
| Without lip sync | ~$0.42 (Kling) + ~$0.01 (TTS) |
| With lip sync | ~$0.49 (Kling + LipSync) + ~$0.01 (TTS) |

A 4-clip video with 2 lip-synced scenes ≈ $1.82

## IMPORTANT

- Each clip takes **1-3 minutes** to generate (Kling queue). A 4-clip video = 4-12 min.
- **Always warn the user** before starting: "Generando video narrado con N escenas, esto tarda unos minutos..."
- **Send progress updates**: "Escena 2/4 lista..." between clips
- Keep narration texts **short** (under 15 words per scene) — each scene is only 5 seconds
- Prompts describe **camera movement**, not image content (e.g. "slow zoom in", "pan left to right")

## Output & delivery

```
mcp__nanoclaw__send_message({ text: "Tu video narrado:", video_path: "/workspace/group/video-narrate-123.mp4" })
```
