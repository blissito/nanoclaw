---
name: pdf-gen
description: Generate beautiful PDFs from templates — invitations, reports, proposals, one-pagers. Use instead of calling fast_pdf directly. Ensures professional density and layout.
---

# PDF Generation Guide

You have access to `mcp__easybits__fast_pdf` for PDF generation. This guide ensures every PDF looks professional. **Read this before every fast_pdf call.**

## Universal Rules

1. **Density first.** Every page must have 3+ content sections and be at least 70% full. A page with a single callout or heading is a failure — move content up or eliminate the page.
1b. **CRITICAL: heading level 1 causes a page break.** Typst inserts a forced page break before every `heading level 1`. Use h1 ONLY for the document's main title (the very first heading). ALL other section titles MUST be `level: 2` or `level: 3`. Using h1 for each category/chapter is the #1 cause of blank pages.
2. **Page budget.** Before building sections, estimate: total content ÷ 3 sections per page = max pages. If you only have content for 1 page, make it 1 page. Never pad with whitespace.
3. **Style must match tone:**
   - `bold` → invitations, events, celebrations, marketing
   - `modern` → reports, summaries, dashboards
   - `minimal` → formal documents, contracts, proposals
   - `corporate` → ONLY for actual corporate/business documents
4. **Images.** Use `width: "55%"` for images inside a 1-page doc (larger pushes content to page 2). Use `width: "100%"` ONLY when the image is on its own cover page. Always include a caption.
5. **Use raw `typst` for stats.** The built-in `stats` section type has uneven sizing. Use this Typst grid instead:
   ```json
   { "type": "typst", "code": "#v(8pt)\n#grid(\n  columns: (1fr, 1fr, 1fr, 1fr),\n  gutter: 12pt,\n  [\n    #align(center)[\n      #text(size: 11pt, fill: rgb(\"666666\"))[EMOJI LABEL]\n      #v(4pt)\n      #text(size: 14pt, weight: \"bold\")[VALUE]\n    ]\n  ],\n  ... repeat for each column ...\n)\n#v(8pt)" }
   ```
6. **Cover page** only for 3+ page documents. For 1-2 pages, put everything on the main pages.
7. **Header/footer.** Set `headerFooter: false` for invitations and flyers. Use `true` for reports and formal docs.

## Stock Images

When you need a stock image and don't have one from the user, use Unsplash direct URLs. These work reliably with fast_pdf:

**Nature / Outdoors:**
- Mountains at sunset: `https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800`
- Forest path: `https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800`
- Lake reflection: `https://images.unsplash.com/photo-1439066615861-d1af74d74000?w=800`
- Campfire: `https://images.unsplash.com/photo-1475483768296-6163e08872a1?w=800`
- Beach sunset: `https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800`

**Food / Gatherings:**
- BBQ grill: `https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800`
- Party table: `https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=800`
- Birthday cake: `https://images.unsplash.com/photo-1558636508-e0db3814bd1d?w=800`
- Outdoor picnic: `https://images.unsplash.com/photo-1526382925646-27b5eb86796e?w=800`

**Business / Professional:**
- Office workspace: `https://images.unsplash.com/photo-1497366216548-37526070297c?w=800`
- Team meeting: `https://images.unsplash.com/photo-1552664730-d307ca884978?w=800`
- Charts/data: `https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800`

**City / Urban:**
- City skyline: `https://images.unsplash.com/photo-1449824913935-59a10b8d2000?w=800`
- Street at night: `https://images.unsplash.com/photo-1519501025264-65ba15a82390?w=800`

Pick the image that best matches the document's topic. Append `?w=800` to keep file size reasonable. If none fit, skip the image — a dense 1-page PDF without an image is better than one with an irrelevant stock photo.

## Pre-flight Checklist

Before calling fast_pdf, verify:
- [ ] Each page has 3+ sections
- [ ] No page has 40%+ empty space
- [ ] Style matches the content tone
- [ ] Page count is the minimum necessary
- [ ] Paragraphs are 40+ words (no one-liners)
- [ ] Typst grid used for key data points (not built-in stats)
- [ ] Image width is 55% (or omitted) for 1-page docs

---

## Template: Invitation (1 page)

**Use for:** birthdays, events, parties, gatherings, meetups.
**Style:** `bold` | **Cover page:** `false` | **headerFooter:** `false`
**Target:** 1 page (2 only if there's genuinely too much content)

### Structure

```json
{
  "style": "bold",
  "coverPage": false,
  "headerFooter": false,
  "brandColor": "#7C5AE6",
  "sections": [
    { "type": "heading", "level": 1, "text": "EVENT TITLE 🎉" },
    { "type": "paragraph", "text": "2-3 sentences describing the event, the vibe, and why they should come. Make it warm and personal, at least 40 words." },
    { "type": "image", "url": "UNSPLASH_URL?w=800", "width": "55%", "caption": "Venue description" },
    { "type": "typst", "code": "#v(8pt)\n#grid(\n  columns: (1fr, 1fr, 1fr, 1fr),\n  gutter: 12pt,\n  [\n    #align(center)[\n      #text(size: 11pt, fill: rgb(\"666666\"))[📅 FECHA]\n      #v(4pt)\n      #text(size: 14pt, weight: \"bold\")[Sábado 12 de abril]\n    ]\n  ],\n  [\n    #align(center)[\n      #text(size: 11pt, fill: rgb(\"666666\"))[📍 LUGAR]\n      #v(4pt)\n      #text(size: 14pt, weight: \"bold\")[El Cedral, Hidalgo]\n    ]\n  ],\n  [\n    #align(center)[\n      #text(size: 11pt, fill: rgb(\"666666\"))[🕐 HORA]\n      #v(4pt)\n      #text(size: 14pt, weight: \"bold\")[10:00 AM]\n    ]\n  ],\n  [\n    #align(center)[\n      #text(size: 11pt, fill: rgb(\"666666\"))[🌡️ CLIMA]\n      #v(4pt)\n      #text(size: 14pt, weight: \"bold\")[12–18°C ☀️]\n    ]\n  ],\n)\n#v(8pt)" },
    { "type": "callout", "variant": "success", "title": "🎒 Qué llevar", "text": "List of items, requirements, dress code, etc. Be specific and helpful." },
    { "type": "two-column", "left": "🍖 MENÚ\n\nFood details — what's being served, who's cooking, what to bring. 40+ words.", "right": "📍 CÓMO LLEGAR\n\nDirections, landmarks, travel time from nearest city. Be practical. 40+ words." },
    { "type": "quote", "text": "Personal closing message from the host.", "attribution": "— Host Name 🎂" }
  ]
}
```

### Key rules for invitations
- Heading FIRST, then paragraph, then image at 55% — this order keeps everything on 1 page
- Typst grid for logistics — label on top (gray, 11pt), value below (bold, 14pt)
- Callout for requirements/what to bring — visually distinct, easy to scan
- Two-column for details + directions — maximizes horizontal space
- Quote for personal closing — warm, not corporate

---

## Template: Report (2-4 pages)

**Use for:** summaries, analysis, research results, status updates.
**Style:** `modern` | **Cover page:** `true` (if 3+ pages) | **headerFooter:** `true`

### Structure

```json
{
  "style": "modern",
  "coverPage": true,
  "headerFooter": true,
  "sections": [
    { "type": "heading", "level": 1, "text": "Executive Summary" },
    { "type": "paragraph", "text": "3-5 sentence overview of findings. What happened, why it matters, what to do next." },
    { "type": "typst", "code": "#v(8pt)\n#grid(\n  columns: (1fr, 1fr, 1fr),\n  gutter: 12pt,\n  [\n    #align(center)[\n      #text(size: 11pt, fill: rgb(\"666666\"))[LABEL 1]\n      #v(4pt)\n      #text(size: 18pt, weight: \"bold\")[42%]\n    ]\n  ],\n  [\n    #align(center)[\n      #text(size: 11pt, fill: rgb(\"666666\"))[LABEL 2]\n      #v(4pt)\n      #text(size: 18pt, weight: \"bold\")[$12,500]\n    ]\n  ],\n  [\n    #align(center)[\n      #text(size: 11pt, fill: rgb(\"666666\"))[LABEL 3]\n      #v(4pt)\n      #text(size: 18pt, weight: \"bold\")[3 weeks]\n    ]\n  ],\n)\n#v(8pt)" },
    { "type": "divider" },
    { "type": "heading", "level": 2, "text": "Section Title" },
    { "type": "paragraph", "text": "Detailed analysis paragraph — 3-5 sentences minimum. Include data, context, and interpretation." },
    { "type": "table", "headers": ["Category", "Value", "Change"], "rows": [["Row 1", "data", "+5%"], ["Row 2", "data", "-2%"]] },
    { "type": "heading", "level": 2, "text": "Next Steps" },
    { "type": "list", "items": ["Action item 1 with owner and deadline", "Action item 2 with owner and deadline"], "ordered": true },
    { "type": "callout", "variant": "info", "title": "Conclusion", "text": "Key takeaway and recommended action." }
  ]
}
```

### Key rules for reports
- Typst grid with larger font (18pt) for key metrics — executives scan numbers first
- Tables for comparative data — never describe in prose what belongs in a table
- Dense paragraphs (3-5 sentences) — no filler
- Callout only for conclusions or warnings — not for regular content
- Ordered lists for action items — numbered = accountable

---

## Template: One-Pager (1 page)

**Use for:** flyers, quick summaries, product sheets, event announcements.
**Style:** `bold` | **Cover page:** `false` | **headerFooter:** `false`

### Structure

```json
{
  "style": "bold",
  "coverPage": false,
  "headerFooter": false,
  "sections": [
    { "type": "heading", "level": 1, "text": "TITLE" },
    { "type": "paragraph", "text": "Brief hook — 2-3 sentences that grab attention and explain the value proposition." },
    { "type": "typst", "code": "#v(8pt)\n#grid(\n  columns: (1fr, 1fr, 1fr),\n  gutter: 12pt,\n  [\n    #align(center)[\n      #text(size: 11pt, fill: rgb(\"666666\"))[LABEL]\n      #v(4pt)\n      #text(size: 16pt, weight: \"bold\")[VALUE]\n    ]\n  ],\n  ... repeat ...\n)\n#v(8pt)" },
    { "type": "two-column", "left": "Left column detail — features, benefits, or description. 40+ words.", "right": "Right column detail — pricing, schedule, or specs. 40+ words." },
    { "type": "callout", "variant": "success", "title": "Call to Action", "text": "What should the reader do next? Be specific: register, call, visit, reply." }
  ]
}
```

### Key rules for one-pagers
- Everything fits on 1 page — if it doesn't, you have too much content (split into report)
- Typst grid is the visual anchor — bold numbers catch the eye
- Two-column maximizes horizontal space — no wasted whitespace
- Callout CTA at the bottom — the last thing they read is what to do

---

## Template: Catalog (4-8 pages)

**Use for:** product catalogs, menus, service listings, portfolios.
**Style:** `modern` or `corporate` | **Cover page:** `true` | **headerFooter:** `true`
**Key principle:** Pack 2-3 product categories per page. Each category = h2 + image (small) + paragraph + table. NEVER use h1 for categories.

### Structure

```json
{
  "style": "modern",
  "coverPage": true,
  "headerFooter": true,
  "brandColor": "#2C3E50",
  "sections": [
    { "type": "heading", "level": 2, "text": "🛋️ SALA — Confort Contemporáneo" },
    { "type": "divider" },
    { "type": "image", "url": "PRODUCT_IMAGE_URL?w=800", "width": "45%", "caption": "Serie Bosque — sofá de lino natural" },
    { "type": "paragraph", "text": "Describe the product line in 2-3 sentences. Materials, sizes, colors available. At least 40 words with real details." },
    { "type": "table", "headers": ["Producto", "Material", "Medidas cm", "Precio"], "rows": [["Product 1", "Material", "WxDxH", "$X"], ["Product 2", "Material", "WxDxH", "$X"]] },
    { "type": "callout", "variant": "success", "title": "⭐ Destacado", "text": "Best-seller callout or special offer for this category." },
    { "type": "heading", "level": 2, "text": "🍽️ COMEDOR — Next Category" },
    { "type": "divider" },
    { "type": "paragraph", "text": "Description of next category..." },
    { "type": "table", "headers": ["Producto", "Material", "Medidas cm", "Precio"], "rows": [["...", "...", "...", "..."]] }
  ]
}
```

### Key rules for catalogs
- **ALL category titles are h2, NEVER h1** — h1 forces a page break and creates blank pages
- Image at 45% width max — leaves room for text to flow around/below on same page
- Table is the core of each category — products, specs, prices in columns
- Pack 2 categories per page when tables are short (3-4 rows each)
- Use divider between categories, not headings, to avoid visual breaks
- Callout only for 1-2 standout products across the whole catalog, not every category
- End with a closing section (contact, warranty, ordering info) — not a blank page

---

## Anti-patterns (NEVER do these)

| ❌ Don't | ✅ Do instead |
|----------|--------------|
| Use `heading level 1` for section/category titles | Use `level: 2` — h1 forces a page break |
| Page with only a callout | Combine with surrounding paragraphs |
| Separate heading+paragraph for date, location, time | Use a single Typst grid |
| Style `corporate` for a birthday party | Use `bold` or `modern` |
| 4 pages with 30% content each | 1-2 dense pages |
| One-sentence paragraphs | 40+ word paragraphs minimum |
| Image at 100% width on a 1-page doc | Image at 55% width (100% only on cover pages) |
| Cover page for a 1-page document | Skip cover, put content on main page |
| Built-in `stats` section | Typst grid (better font control and spacing) |
