---
name: pptx-gen
description: Generate PowerPoint (.pptx) presentations from JSON with smart layouts
allowed-tools: Bash(pptx-gen:*)
---

# PowerPoint Generator

Generate `.pptx` presentations with automatic layout detection and professional styling.

## Usage

```bash
pptx-gen '<json>'
pptx-gen /path/to/slides.json
pptx-gen '<json>' /workspace/group/my-presentation.pptx
```

## Layouts

Each slide auto-detects the best layout based on its content, or you can set `layout` explicitly:

| Layout | Auto-detected when | Description |
|--------|-------------------|-------------|
| `title` | Only title/subtitle, no body/bullets/table | Centered title, decorative accent line |
| `content` | Has body/bullets, no image | Full-width content with accent bar |
| `image-right` | Has image + body/bullets | Text left (55%), image right (45%) |
| `image-left` | Manual only | Image left, text right |
| `image-full` | Has image, no body/bullets | Large centered image with title above |
| `comparison` | Has `columns` array | Two columns with divider line |
| `table` | Has table data | Title + well-spaced table |

## JSON format

```json
{
  "title": "Presentation Title",
  "author": "Author Name",
  "theme": {
    "background": "1a1a2e",
    "titleColor": "auto",
    "bodyColor": "auto",
    "accentColor": "6366f1"
  },
  "slides": [
    {
      "layout": "title",
      "title": "Main Title",
      "subtitle": "Subtitle text"
    },
    {
      "title": "Key Features",
      "bullets": ["Feature 1", "Feature 2", "Feature 3"]
    },
    {
      "title": "Our Product",
      "body": "Description text here",
      "image": "https://example.com/photo.jpg"
    },
    {
      "layout": "comparison",
      "title": "Us vs Them",
      "columns": [
        { "title": "Our Solution", "bullets": ["Fast", "Reliable"] },
        { "title": "Traditional", "bullets": ["Slow", "Fragile"] }
      ]
    },
    {
      "title": "Metrics",
      "table": [
        ["Metric", "Q1", "Q2"],
        ["Revenue", "$10k", "$25k"]
      ]
    }
  ]
}
```

## Theme

Colors are 6-digit hex (no #). Set `titleColor` and `bodyColor` to `"auto"` (or omit them) for automatic contrast detection — dark backgrounds get light text, light backgrounds get dark text.

Default accent: indigo (`6366f1`). Good alternatives: purple `7c3aed`, blue `3b82f6`, emerald `10b981`, rose `f43f5e`.

## Slide content options

- `layout` — override auto-detection (title, content, image-right, image-left, image-full, comparison, table)
- `title` — slide heading
- `subtitle` — accent-colored text below title
- `body` — paragraph text
- `bullets` — bulleted list (array of strings)
- `image` — local path or Pexels URL (do NOT generate AI images, use Pexels search instead)
- `table` — 2D array, first row = header
- `columns` — for comparison layout: `[{title, bullets}, {title, bullets}]`
- `background` — hex color or image path (overrides theme per-slide)
- `notes` — speaker notes

## Images: use Pexels only

**Do NOT generate AI images** (no generate-flux, no generate-image). Use Pexels for stock photos:

```bash
# Search Pexels and use the URL directly in the slide JSON
# The helper auto-downloads HTTP images, so URLs work fine
```

Use Pexels image URLs directly in the `image` field. The helper downloads them automatically via curl.

## Best practices

- **Keep it concise**: 4-6 slides max unless the user asks for more
- **No AI image generation**: only Pexels stock photos or no images at all
- **Let layouts auto-detect**: don't set `layout` unless you need a specific one
- **Dark themes**: set background color and leave titleColor/bodyColor as "auto"

## Output & delivery

Saves to `/workspace/group/` and prints the path. Send as document:

```
mcp__nanoclaw__send_message({ text: "Here's your presentation!", document_path: "/workspace/group/presentation-123.pptx" })
```
