---
name: gif-gen
description: Create animated GIFs from multiple images (slideshow) or by AI-animating a single image
allowed-tools: Bash(generate-gif:*)
---

# GIF Generation

Two modes:

| Mode | Command | Cost |
|------|---------|------|
| **Slideshow** | `generate-gif img1.png img2.png img3.png` | Free |
| **AI animate** | `generate-gif --animate img.png "motion description"` | ~$0.42 |

## When to use each mode

- User sends multiple images + "haz un gif" / "gif con estas" → **Slideshow**
- User sends one image + "anima esto" / "dale vida" / "hazlo gif animado" → **AI animate**

## Slideshow mode

```bash
generate-gif /workspace/group/attachments/img-1.jpg /workspace/group/attachments/img-2.jpg /workspace/group/attachments/img-3.jpg
```

- Needs at least 2 images
- 1 frame per second, loops forever
- Find attachment paths from `[Image: attachments/img-xxx.jpg]` in the conversation

## AI animate mode

```bash
generate-gif --animate /workspace/group/attachments/img-1.jpg "the person smiles and waves"
```

- Takes ~1-3 minutes (AI video generation + conversion)
- The prompt describes the **motion**, not the scene
- Good motion prompts: "gentle breeze blows hair", "camera slowly zooms in", "the person turns and smiles"

## Output & delivery

Saves to `/workspace/group/gif-*.gif`. Send as image:

```
mcp__nanoclaw__send_message({ text: "Here's your GIF!", image_path: "/workspace/group/gif-123.gif" })
```
