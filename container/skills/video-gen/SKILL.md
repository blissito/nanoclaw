---
name: video-gen
description: Generate short videos using fal.ai (Kling 2.6 Pro)
allowed-tools: Bash(generate-video:*)
---

# Video Generation (Kling 2.6 Pro via fal.ai)

Generate 5-second videos from text prompts.

## Usage

```bash
generate-video "a ghost floating through Mexico City at sunset, cinematic aerial"
```

## IMPORTANT: Always warn the user first

Video generation takes ~1-3 minutes. **Before calling `generate-video`, ALWAYS send a message** telling the user it will take a moment:

```
mcp__nanoclaw__send_message({ text: "Generando video, dame 1-2 min..." })
```

Then call `generate-video`. Then send the result.

## Output & delivery

The script saves an `.mp4` to `/workspace/group/` and prints the path. Send as a native video:

```
mcp__nanoclaw__send_message({ text: "Listo:", video_path: "/workspace/group/video-1234.mp4" })
```

## Specs

- Duration: 5 seconds, 16:9
- Cost: ~$0.42 USD per video
- Model: Kling 2.6 Pro (high quality, cinematic)

## NOT for image-to-video

If the user sends an image and wants to animate it, do NOT use this script. Use `generate-gif --animate` from the gif-gen skill instead:

```bash
generate-gif --animate /path/to/image.png "motion description"
```

This script is text-only — it ignores image arguments.

## Prompt tips

- Be descriptive: include style, lighting, camera movement, mood
- Works best with cinematic/nature/abstract scenes
- Faces and text rendering are weak — avoid prompts that depend on them
