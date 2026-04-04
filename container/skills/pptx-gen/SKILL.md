---
name: pptx-gen
description: Generate PowerPoint (.pptx) presentations from JSON
allowed-tools: Bash(pptx-gen:*)
---

# PowerPoint Generator

Generate `.pptx` presentations programmatically.

## Usage

```bash
pptx-gen '<json>'
pptx-gen /path/to/slides.json
pptx-gen '<json>' /workspace/group/my-presentation.pptx
```

## JSON format

```json
{
  "title": "Presentation Title",
  "author": "Author Name",
  "theme": {
    "background": "FFFFFF",
    "titleColor": "1a1a2e",
    "bodyColor": "333333",
    "accentColor": "0066cc"
  },
  "slides": [
    {
      "title": "Slide Title",
      "subtitle": "Optional subtitle",
      "body": "Body text paragraph",
      "bullets": ["Point 1", "Point 2", "Point 3"],
      "image": "/workspace/group/photo.jpg",
      "imageX": 5, "imageY": 1.8, "imageW": 4, "imageH": 3,
      "table": [
        ["Header 1", "Header 2"],
        ["Cell 1", "Cell 2"]
      ],
      "background": "f5f5f5",
      "notes": "Speaker notes here"
    }
  ]
}
```

## Slide content options

Each slide can have any combination of:
- `title` — large bold heading
- `subtitle` — smaller accent-colored text below title
- `body` — paragraph text
- `bullets` — bulleted list (array of strings)
- `image` — image path or URL with optional position/size (imageX/Y/W/H)
- `table` — 2D array, first row becomes header
- `background` — hex color or image path
- `notes` — speaker notes

## Output & delivery

Saves to `/workspace/group/` and prints the path. Send as document:

```
mcp__nanoclaw__send_message({ text: "Here's your presentation!", document_path: "/workspace/group/presentation-123.pptx" })
```

## Tips

- Build the JSON programmatically for data-driven presentations
- Use generated images (from generate-image, generate-flux) as slide backgrounds or content
- For large presentations, write the JSON to a temp file first, then pass the file path
