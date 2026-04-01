---
name: image-gen
description: Generate, edit, and face-swap images using fal.ai FLUX, OpenAI gpt-image-1-mini, and face-swap
allowed-tools: Bash(generate-image:*),Bash(generate-flux:*),Bash(generate-preview:*),Bash(face-swap:*)
---

# Image Generation, Editing & Face Swap

You have FOUR image tools. Choose the right one:

| Tool | Model | Cost | When to use |
|------|-------|------|-------------|
| `generate-image` | FLUX.2 [pro] / Kontext | $0.03-0.04 | **Default** — text-to-image, edit/modify photos, combine elements |
| `generate-flux` | FLUX.2 [pro] | $0.03 | Photorealistic, ultra-quality, image-guided style transfer |
| `generate-preview` | gpt-image-1-mini | $0.005 | Quick drafts, previews, iterations before final version |
| `face-swap` | fal.ai | — | Preserve a specific person's face identity |

## Decision guide

- "Genera una imagen de..." / "Hazme un logo" → `generate-image` (text-to-image)
- "Cambia el fondo" / "quita esto" / "pon un sombrero" → `generate-image` (editing with Kontext)
- "Foto realista de..." / "flux" / "fotorrealismo" → `generate-flux`
- "Transforma esta imagen al estilo..." → `generate-flux` with reference image
- "Dame un preview rápido" / iterating on concepts / "a ver cómo se ve" → `generate-preview`
- "Pon MI CARA en esta foto" / "swap faces" → `face-swap`
- User asks for multiple options/variations → use `generate-preview` first, then `generate-image` for the final

## generate-image

```bash
# Text to image (FLUX.2 pro)
generate-image "a cat floating in space, photorealistic"

# Edit with one image (Kontext pro)
generate-image "put this person on a tropical beach" /workspace/group/attachments/img-1234.jpg

# Edit with source image
generate-image "change the background to a sunset" /workspace/group/attachments/img-1234.jpg
```

Find attachment paths from `[Image: attachments/img-xxx.jpg]` in the conversation.

## generate-flux

```bash
# Text to image (photorealistic)
generate-flux "an old Mexican grandfather winning an esports tournament, holding a trophy, photorealistic"

# Image-guided generation (uses reference photo for style/composition)
generate-flux "transform this into a cyberpunk scene" /workspace/group/attachments/img-1234.jpg
```

- Produces ultra-high quality photorealistic images
- Reference image controls style/composition, NOT face identity (use face-swap for that)

## generate-preview

```bash
# Quick cheap preview
generate-preview "a logo for a taco shop, minimalist"
```

- Fast and cheap ($0.005) — use for drafts and iterations
- Text-to-image only (no editing)
- Lower quality than generate-image — use to validate concepts before generating final version

## face-swap

```bash
# Swap the face from photo 1 onto the person in photo 2
face-swap /workspace/group/attachments/img-FACE.jpg /workspace/group/attachments/img-TARGET.jpg
```

- First argument: the photo with the FACE to use (source face)
- Second argument: the photo where the face will be PLACED (target body/scene)

## Output & delivery

All scripts save to `/workspace/group/` and print the path. Send the result as a native image:

```
mcp__nanoclaw__send_message({ text: "Here's your image!", image_path: "/workspace/group/generated-123.jpg" })
```

## Prompt rules

- **Short descriptions (< 20 words):** Expand into a detailed, vivid prompt — add style, lighting, composition, colors, and detail keywords while preserving the user's intent.
- **Medium/long descriptions (≥ 20 words):** Use the user's description exactly as-is. Do not modify or "improve" it.

## Important

- Do NOT call curl or APIs directly — always use these scripts
- JPEG input is supported (no need to convert to PNG)
- Prefer `generate-image` over `generate-flux` for general requests — they use the same model for text-to-image, but `generate-image` also handles editing
