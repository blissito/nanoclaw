---
name: video-kling-master
description: Generate a 5-second cinematic video from text using fal.ai Kling 2.1 Master (top tier, better identity preservation than Kling 2.6 Pro).
allowed-tools: Bash(generate-video-kling-master:*)
---

# Text-to-Video — Kling 2.1 Master via fal.ai

Generate a 5-second cinematic video from a text prompt. Kling 2.1 **Master** is
the highest tier of the Kling line — better identity preservation, sharper
detail, and stronger prompt adherence than the older 2.6 Pro tier.

## Usage

```bash
generate-video-kling-master "a ghost floating through Mexico City at sunset, cinematic aerial, golden hour"
```

## IMPORTANT: warn the user first

Master tier is slower (~2–4 min). Send a heads-up before calling:

```
mcp__nanoclaw__send_message({ text: "Generando video tier alto, dame 2-3 min..." })
```

Then call `generate-video-kling-master`. Then send the result.

## Output & delivery

The script writes an `.mp4` to `/workspace/group/` and prints the path:

```
mcp__nanoclaw__send_message({ text: "Listo:", video_path: "/workspace/group/video-kling-master-1234.mp4" })
```

## Specs

- Duration: 5s, 16:9
- Cost: ~$1.40 USD per video ($0.28 per extra second)
- Model: `fal-ai/kling-video/v2.1/master/text-to-video`
- Strengths: cinematic motion, identity preservation, prompt adherence
- Weaknesses: text rendering, complex hands, fingers — same as all video models

## When to use vs. other video skills

- Want **best quality**, willing to pay $1.40 → **this skill** (Kling 2.1 Master, t2v)
- Have a still image + want subtle motion → `video-hailuo` (image-to-video)
- Need cheap/fast prototype → use the older `generate-video` (Kling 2.6 Pro, ~$0.42)

## Prompt tips

- Describe shot composition, lighting, camera movement, mood
- "cinematic aerial", "macro close-up", "tracking shot", "golden hour", "neon"
- Avoid faces and text-heavy scenes
- Keep prompts under ~300 chars — longer prompts dilute attention
