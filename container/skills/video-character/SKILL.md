---
name: video-character
description: Generate videos using EasyBits + Runway Gen-4.5. Handles text-to-video, image-to-video with reference photo, and character-preserved video where the same person/pet/mascot appears across multiple clips with the same face. Use for ALL video generation requests.
allowed-tools: mcp__easybits__video_create,mcp__easybits__character_remember,mcp__easybits__character_list,mcp__easybits__character_delete,mcp__easybits__upload_file,mcp__easybits__get_file,mcp__nanoclaw__send_message,Bash(curl:*)
---

# Video Generation (EasyBits + Runway Gen-4.5)

Generate short videos (2–10s). Backed by EasyBits MCP (`video_create`) which orchestrates prompt enhancement → still generation (with character refs if provided) → Gen-4.5 animation. Supports character preservation so a specific person, pet, or mascot keeps the same face across multiple clips.

Handles three modes:
- **Scene only** — no specific subject ("un atardecer en la playa"). Pass `prompt` alone.
- **One-shot photo** — user attaches a photo, wants it animated once. Pass `prompt` + `referenceImage`.
- **Recurring character** — user wants a saved subject to appear. Pass `prompt` + `character` (slug).

## Flow

### 0. Scene-only requests (no subject)

If the user asks for a pure scene with no specific person/pet/mascot ("un atardecer en la playa", "gato volando por el espacio", "una ciudad futurista"), skip straight to **step 3** — translate to English and go. No `character` or `referenceImage` needed.

### 1. User mentions a known character by name

Names like "Toby", "mi perro Luna", "Don Beto", "mi hija María".

```
mcp__easybits__character_list()
```

- **Match found** (by `name` or `slug`) → use `character: "<slug>"` in `video_create`. **Do NOT describe the character's physical appearance in the prompt.**
- **No match and photo attached** → go to step 2.
- **No match and no photo** → ask: *"No tengo guardado a Toby todavía. ¿Me mandas una foto para animarlo?"*

### 2. Photo attached

Find the attachment path from `[Image: attachments/img-xxx.jpg]` in the conversation.

```
mcp__easybits__upload_file({ path: "/workspace/group/attachments/img-xxx.jpg" })
```

Returns a public URL.

**If the user mentioned a proper name** ("este es Toby", "aquí va mi gata Luna"), ask BEFORE generating:

> *"¿Quieres que recuerde a Toby para próximos videos? Así no tienes que mandar foto cada vez."*

- **User says yes** → `character_remember({ name: "Toby", photos: [url] })` → use the returned `slug` in `video_create`.
- **User says no** or it's a photo without a proper name → use `referenceImage: <url>` directly in `video_create`.

### 3. Translate the user's request to English

Runway performs much better with English prompts. Users speak Spanish — you translate internally.

Rules:
- **NO** physical description if you're using `character` (breaks identity preservation).
- **YES** action + setting + lighting/style.
- One sentence is enough — the tool enhances it internally.

Examples:
| Usuario (ES) | prompt param (EN) |
|---|---|
| "Toby corriendo en la playa al atardecer" | `"running along the beach at sunset, cinematic golden hour lighting"` |
| "Mi hija bailando en un escenario con luces" | `"dancing on a stage with dramatic concert lighting, slow motion"` |
| "Don Beto manejando un convertible rojo" | `"driving a red convertible down a coastal highway, aerial shot"` |
| "un video estilo película de ciencia ficción" | `"cinematic sci-fi scene, neon lighting, futuristic atmosphere"` |

### 4. Announce BEFORE calling the tool

**Critical.** Without a text message first, the user sees "escribiendo..." for 2 minutes in silence.

```
mcp__nanoclaw__send_message({ text: "🎬 Va, dame un par de minutos generándolo..." })
```

Variations:
- *"Listo, empezando — te aviso en ~2 min"*
- *"Generando tu video, aguanta tantito"*

Then call `video_create`.

### 5. Call `video_create`

Defaults for WhatsApp:

```
mcp__easybits__video_create({
  prompt: "<translated to English>",
  character: "<slug>",            // if character known or just saved
  // OR
  referenceImage: "<url>",        // if using one-off photo (mutually exclusive with character)
  ratio: "720:1280",              // vertical, optimal for WhatsApp
  duration: 5,                    // 5 seconds, good balance
  model: "gen4.5"                 // cinematic quality
})
```

Override defaults only when the user asks:
- `model: "gen4_turbo"` — if user says "rápido", "prueba", "borrador"
- `duration: 2-10` — if user asks for a specific length
- `ratio: "1280:720"` — if user says "horizontal" or "landscape"
- `ratio: "960:960"` — if user says "cuadrado"

### 6. Deliver the video

Returns `{ videoFileId, ... }`. Fetch the URL, download locally, and send as native video.

```
mcp__easybits__get_file({ id: "<videoFileId>" })
```

Returns a signed URL. Download to `/workspace/group/` so WhatsApp sends it as a playable video (not just a link):

```bash
curl -sL "<url>" -o "/workspace/group/video-<slug-or-id>.mp4"
```

Then:

```
mcp__nanoclaw__send_message({
  text: "Aquí está 👇",
  video_path: "/workspace/group/video-<slug-or-id>.mp4"
})
```

## Error handling — always reply in Spanish

| Error from `video_create` | Tell the user |
|---|---|
| Content policy / moderation rejection | *"Lo rechazó el filtro de contenido. ¿Probamos con otra idea menos intensa?"* |
| Character not recognizable | *"No logro reconocer bien a [nombre] en las fotos. ¿Me mandas otra más clara?"* |
| Missing photo and no character | *"Necesito una foto o un personaje guardado. ¿Me mandas una?"* |
| Timeout / network | *"Se cortó la generación. ¿La intento de nuevo?"* |
| Rate limit / quota | *"Llegamos al límite de generaciones por ahora. Intenta en un rato."* |

## Rules

- **Always** translate `prompt` to English internally.
- **Always** reply to the user in Spanish (captions, confirmations, errors).
- **Never** call `video_create` without sending a text message first announcing it.
- **Never** include physical description in `prompt` when using `character`.
- **Never** assume the user wants to save a character — ask the first time a proper name appears with a new photo.
- **Always** call `character_list` before asking for a new photo if the user mentions a proper name — they may have saved that character already.
- **Prefer** `character` over `referenceImage` when the character is saved — identity preservation is stronger with 1-3 saved reference photos than with a single one-shot.

## Managing saved characters

- `mcp__easybits__character_list()` — list all saved characters.
- `mcp__easybits__character_delete({ id })` — delete when the user says *"olvida a Toby"*, *"borra a [nombre]"*.

## Cross-skill notes

- **Quick animated GIF from a single image** (cheaper, no face consistency) → use `generate-gif --animate` from the `gif-gen` skill.
- **Narrated slideshow from multiple images with voiceover** → use `video-narrate` from the `video-narrate` skill.
- **Static image of a saved character in new scene** (no motion) → use `generate-lora` from the `image-gen` skill if a LoRA is trained, otherwise `face-swap`.
