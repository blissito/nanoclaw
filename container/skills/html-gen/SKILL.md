---
name: html-gen
description: Generate premium HTML+Tailwind pages using Gemini 2.5 Pro, then publish via EasyBits. Use when asked to create landing pages, documentation, dashboards, email templates, or any web content.
allowed-tools: Bash(generate-html:*), Read
---

# HTML Generation — Gemini 2.5 Pro + EasyBits

Generate pixel-perfect, premium HTML+TailwindCSS pages and publish them instantly.

## When to use

- User asks for a landing page, website, documentation page, dashboard, or email template
- User wants to publish content as a web page (not PDF, not image)
- User sends a screenshot/image and says "hazme algo así" or "clona esto"

## Workflow

### Step 1: Generate HTML

```bash
# Basic landing page
generate-html "landing page for a Mexican taquería called El Bigotón, warm colors, food photos"

# With reference image (clone a design)
generate-html "replicate this design exactly" /workspace/group/attachments/img-1234.jpg

# Specific page types
generate-html "API documentation for a REST endpoint" --type doc
generate-html "monthly sales dashboard with charts" --type dashboard
generate-html "promotional email for Black Friday sale" --type email
```

### Step 2: Review the output

```bash
# Read the generated file to verify quality
```

Use the `Read` tool on the generated HTML file. Check layout, content, and styling.

### Step 3: Iterate if needed

If the user wants changes, generate again with a more specific prompt — or edit the HTML file directly with small tweaks.

### Step 4: Publish via EasyBits

Use EasyBits MCP tools to publish the final HTML:

**Option A — As a document (shareable link):**
```
mcp__easybits__create_document({ title: "Landing Page", content: "<html>..." })
```

**Option B — As a website page:**
```
mcp__easybits__set_page_html({ website_id: "...", page_path: "/", html: "<html>..." })
```

**Option C — Upload as file:**
Read the HTML file content and use `mcp__easybits__upload_file` or `mcp__easybits__deploy_website_file`.

## Page types

| Type | Flag | Best for |
|------|------|----------|
| `landing` | `--type landing` (default) | Marketing pages, product pages, sign-up pages |
| `doc` | `--type doc` | Documentation, guides, FAQs, knowledge bases |
| `email` | `--type email` | Newsletter, promotional, transactional emails |
| `dashboard` | `--type dashboard` | Reports, analytics, admin panels |

## Tips for great results

- **Be specific about colors:** "dark theme with emerald accents" beats "green page"
- **Mention the brand:** Include business name, industry, and vibe
- **Reference images work great:** Send a screenshot of a page you like + "hazme algo similar pero para mi negocio"
- **Iterate:** Generate a first version, review, then refine with "cambia X, agrega Y"

## Important

- The HTML is self-contained (Tailwind CDN, Google Fonts, inline everything)
- Images use Unsplash placeholders — replace with real images after if needed
- Always preview the HTML before publishing to EasyBits
- For email type: the output uses a hybrid table+Tailwind approach for email client compatibility
- Cost: ~$0.00 per generation (Gemini API free tier is generous)
