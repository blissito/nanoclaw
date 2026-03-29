---
name: pdf-clone
description: Clone the visual design/layout of a PDF into an HTML template. Use when asked to replicate, clone, or copy a PDF's design — NOT for reading text content (use pdf-reader for that).
allowed-tools: Bash(pdftoppm:*), Bash(pdf-reader:*), Read
---

# PDF Clone — Visual Design Replication

Clone a PDF's visual layout into an HTML template that can be reused with different data.

## Workflow

### Step 1: Convert PDF pages to images

```bash
pdftoppm -jpeg -r 200 -singlefile attachments/document.pdf /tmp/pdf-preview
# → /tmp/pdf-preview.jpg (first page only)

# Multiple pages:
pdftoppm -jpeg -r 200 attachments/document.pdf /tmp/pdf-page
# → /tmp/pdf-page-1.jpg, /tmp/pdf-page-2.jpg, etc.
```

Options:
- `-r 200` — resolution in DPI (200 is good balance of quality vs size)
- `-singlefile` — only first page
- `-f 2 -l 2` — specific page (page 2)
- `-jpeg` — output format (also supports `-png`)

### Step 2: View the rendered image

```bash
# Read the image to see the visual design
```

Use the `Read` tool on the generated JPG to see the layout visually.

### Step 3: Extract text for reference (optional)

```bash
pdf-reader extract attachments/document.pdf --layout
```

Use `--layout` to understand the spatial positioning of text elements.

### Step 4: Recreate as HTML template

Build an HTML/CSS template that replicates the visual design. Use:
- CSS Grid or Flexbox for layout
- Matching colors, fonts, spacing
- Template slots (`{{variable}}`) for dynamic content
- EasyBits to publish the final template if needed

## Important

- **NEVER use the `Read` tool directly on a PDF** — it may fail with large files. Always convert to image first with `pdftoppm`.
- For text extraction, use `pdf-reader extract` (not `Read`).
- The goal is to clone the **visual design**, not the content. The content will be substituted each time.
- When cloning logos or images from the PDF, describe them or ask the user — don't try to extract them programmatically.
