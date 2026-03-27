---
name: image-gen
description: Generate, edit, and face-swap images using OpenAI gpt-image-1, FLUX Ultra, and fal.ai
allowed-tools: Bash(generate-image:*),Bash(generate-flux:*),Bash(face-swap:*)
---

# Image Generation, Editing & Face Swap

You have THREE image tools. Choose the right one:

| Tool | When to use |
|------|-------------|
| `generate-image` | Create images from text, edit/modify photos, combine elements, change styles, add/remove objects |
| `generate-flux` | Photorealistic images, ultra-high quality, or when user asks for "flux" / "flux ultra" / "realista". Also supports image-guided generation with a reference photo |
| `face-swap` | Put someone's FACE onto another person's body/photo. Use ONLY when the user wants to preserve a specific person's face identity |

## Decision guide

- "Ponme en la playa" → `generate-image` (creative edit, face identity doesn't need to be exact)
- "Pon MI CARA en esta foto" / "swap faces" / "quiero verme como X" → `face-swap` (face identity must be preserved)
- "Hazme un logo" / "genera una imagen de..." → `generate-image` (text-to-image)
- "Cambia el fondo" / "quita esto" → `generate-image` (image editing)
- "Foto realista de..." / "flux ultra" / "fotorrealismo" → `generate-flux` (photorealistic)
- "Genera algo basado en esta imagen" + wants photorealism → `generate-flux` with reference image

## generate-image

```bash
# Text to image
generate-image "a cat floating in space, photorealistic"

# Edit with one image
generate-image "put this person on a tropical beach" /workspace/group/attachments/img-1234.jpg

# Combine multiple images
generate-image "put the person from the first image into the scene of the second image" /workspace/group/attachments/img-1234.jpg /workspace/group/attachments/img-5678.jpg
```

Up to 10 source images supported. Find attachment paths from `[Image: attachments/img-xxx.jpg]` in the conversation.

## generate-flux

```bash
# Text to image (photorealistic)
generate-flux "an old Mexican grandfather winning an esports tournament, holding a trophy, photorealistic"

# Image-guided generation (uses reference photo for style/composition)
generate-flux "transform this into a cyberpunk scene" /workspace/group/attachments/img-1234.jpg
```

- Produces ultra-high quality photorealistic images (up to 2K)
- Reference image is optional — controls style/composition, NOT face identity (use face-swap for that)
- Output is JPEG

## face-swap

```bash
# Swap the face from photo 1 onto the person in photo 2
face-swap /workspace/group/attachments/img-FACE.jpg /workspace/group/attachments/img-TARGET.jpg
```

- First argument: the photo with the FACE to use (source face)
- Second argument: the photo where the face will be PLACED (target body/scene)
- Takes ~10-20 seconds to process

## Output & delivery

Both scripts save to `/workspace/group/` and print the path. Send the result as a native image:

```
mcp__nanoclaw__send_message({ text: "Here's your image!", image_path: "/workspace/group/generated-123.png" })
```

## Prompt rules

- **Short descriptions (< 20 words):** Expand into a detailed, vivid prompt — add style, lighting, composition, colors, and detail keywords while preserving the user's intent.
- **Medium/long descriptions (≥ 20 words):** Use the user's description exactly as-is. Do not modify or "improve" it.

## Important

- Do NOT call curl or APIs directly — always use these scripts
- JPEG input is supported (no need to convert to PNG)
- Do NOT fall back to dall-e-2 or dall-e-3
