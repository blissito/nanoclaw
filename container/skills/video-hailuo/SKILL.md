---
name: video-hailuo
description: Animate a still image into a 6-second video using fal.ai MiniMax Hailuo 02 (image-to-video). Best for animals and high realism preservation.
allowed-tools: Bash(generate-video-hailuo:*)
---

# Image-to-Video — MiniMax Hailuo 02 (Standard) via fal.ai

Animate a still image into a short video. Highest fidelity to the source image
in this category. Particularly good with animals and natural motion.

## Usage

```bash
generate-video-hailuo /path/to/image.jpg "the cat slowly turns its head and blinks"
generate-video-hailuo /workspace/group/attachments/img-1234.png "wind blows through the grass, subtle camera push-in"
```

First arg = path to source image (jpg/png/webp). Second arg = motion prompt.

## IMPORTANT: warn the user first

Generation takes ~1–3 min. Send a heads-up before calling the script:

```
mcp__nanoclaw__send_message({ text: "Animando la imagen, dame 1-2 min..." })
```

Then call `generate-video-hailuo`. Then send the result.

## Output & delivery

The script writes an `.mp4` to `/workspace/group/` and prints the path.
Send it as a native video:

```
mcp__nanoclaw__send_message({ text: "Listo:", video_path: "/workspace/group/video-hailuo-1234.mp4" })
```

## Specs

- Duration: 6s, 16:9 (default), aspect ratio inherited from source
- Cost: ~$0.45 USD per video (Hailuo 02 standard)
- Model: `fal-ai/minimax/hailuo-02/standard/image-to-video`
- Strengths: animal motion, identity/texture preservation, realistic physics

## When to use vs. other video skills

- Have a **still image** + want subtle motion → **this skill** (Hailuo i2v)
- Have a **text prompt** only, want cinematic → `video-kling-master` (Kling 2.1 Master, t2v)
- Have an image + want a looping GIF (not video) → `gif-gen --animate`

## Prompt tips

- Describe motion only — the look is locked by the image
- "subtle camera push-in", "head turn", "blink", "wind in fur", "tail flick"
- Avoid prompts that contradict the image (asking a still object to walk away)
- Faces/text are weak — Hailuo preserves them well but exaggerated motion warps them
