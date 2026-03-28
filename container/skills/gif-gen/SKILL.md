---
name: gif-gen
description: Create animated GIFs — crop regions, convert formats, slideshow, or AI-animate
allowed-tools: Bash(generate-gif:*)
---

# GIF Generation

| Mode | Command | Cost |
|------|---------|------|
| **Crop** | `generate-gif --crop WxH+X+Y img.png` | Free |
| **Convert** | `generate-gif --convert img.avif` | Free |
| **Sprite sheet** | `generate-gif --sprite 4x3 [--fps N] [--format gif\|webp\|mp4] sprite.png` | Free |
| **Slideshow** | `generate-gif img1.png img2.png img3.png` | Free |
| **AI animate** | `generate-gif --animate img.png "motion description"` | ~$0.42 |

## When to use each mode

- User sends image + "recorta X y hazlo gif" / "solo la parte de..." → **Crop**
- User sends image + "conviértelo a gif" / "hazlo gif" (no animation needed) → **Convert**
- User sends sprite sheet + "anima este sprite" / "hazlo gif/webp/mp4" → **Sprite sheet**
- User sends multiple images + "haz un gif" / "gif con estas" → **Slideshow**
- User sends one image + "anima esto" / "dale vida" / "hazlo gif animado" → **AI animate**

## Crop mode — pixel-perfect cropping

Use vision to look at the image and calculate exact pixel coordinates for the crop region.

**Steps:**
1. Read the image dimensions first: `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 /path/to/img.jpg`
2. Look at the image (you already have it as multimodal input) and estimate where the desired region is as a percentage of the full image
3. Convert percentages to pixel coordinates: X = pct_x × width, Y = pct_y × height, W = pct_w × width, H = pct_h × height
4. Round to integers and run: `generate-gif --crop WxH+X+Y /path/to/img.jpg`

**Example:** User says "solo la calavera de la izquierda" on a 1920x1080 image. You see the skull occupies roughly the left 40% horizontally and middle 60% vertically:
```bash
# W=768 (40% of 1920), H=648 (60% of 1080), X=0, Y=216 (20% offset from top)
generate-gif --crop 768x648+0+216 /workspace/group/attachments/img-1.jpg
```

**Important:** Always use `ffprobe` to get real dimensions — don't guess from the resized vision thumbnail.

## Sprite sheet mode

Animate a sprite sheet (grid of frames) into GIF, webp, or mp4.

```bash
generate-gif --sprite 4x3 /workspace/group/attachments/spritesheet.png
generate-gif --sprite 8x2 --fps 15 --format webp spritesheet.png
generate-gif --sprite 6x1 --fps 24 --format mp4 spritesheet.png
```

- `COLSxROWS`: grid layout (e.g. `4x3` = 4 columns, 3 rows = 12 frames, read left-to-right, top-to-bottom)
- `--fps N`: frames per second (default: 10)
- `--format gif|webp|mp4`: output format (default: gif)

**How to determine the grid:**
1. Use `ffprobe` to get image dimensions
2. Look at the image with vision — count columns and rows of frames
3. Verify: image_width / cols and image_height / rows should give clean frame sizes

**Iterate with the user:** If the animation speed feels off, adjust `--fps`. If they want a different format, re-run with `--format`. Quick iterations since it's all local ffmpeg.

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

Saves to `/workspace/group/gif-*.gif` or `sprite-*.*`. Send as image:

```
mcp__nanoclaw__send_message({ text: "Here's your GIF!", image_path: "/workspace/group/gif-123.gif" })
```
