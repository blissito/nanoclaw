#!/usr/bin/env node
// pptx-helper.mjs: Generate .pptx files from JSON input
// Usage: echo '{"title":"...","slides":[...]}' | node pptx-helper.mjs [output_path]

import PptxGenJS from 'pptxgenjs';
import { readFileSync } from 'fs';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
const outputPath = process.argv[2] || `/workspace/group/presentation-${Date.now()}.pptx`;

const pres = new PptxGenJS();

// Presentation metadata
if (input.title) pres.title = input.title;
if (input.author) pres.author = input.author;
if (input.subject) pres.subject = input.subject;

// Default layout
pres.layout = input.layout || 'LAYOUT_WIDE';

// Theme colors
const theme = input.theme || {};
const bgColor = theme.background || 'FFFFFF';
const titleColor = theme.titleColor || '1a1a2e';
const bodyColor = theme.bodyColor || '333333';
const accentColor = theme.accentColor || '0066cc';

for (const slideData of (input.slides || [])) {
  const slide = pres.addSlide();

  // Background
  if (slideData.background) {
    if (slideData.background.startsWith('/') || slideData.background.startsWith('http')) {
      slide.background = { path: slideData.background };
    } else {
      slide.background = { color: slideData.background };
    }
  } else {
    slide.background = { color: bgColor };
  }

  // Title
  if (slideData.title) {
    slide.addText(slideData.title, {
      x: 0.5, y: 0.3, w: '90%',
      fontSize: slideData.titleSize || 28,
      bold: true,
      color: titleColor,
      fontFace: 'Arial',
    });
  }

  // Subtitle
  if (slideData.subtitle) {
    slide.addText(slideData.subtitle, {
      x: 0.5, y: 1.0, w: '90%',
      fontSize: 18,
      color: accentColor,
      fontFace: 'Arial',
    });
  }

  // Body text
  if (slideData.body) {
    const bodyY = slideData.title ? 1.8 : 0.5;
    slide.addText(slideData.body, {
      x: 0.5, y: bodyY, w: '90%', h: 4,
      fontSize: slideData.bodySize || 16,
      color: bodyColor,
      fontFace: 'Arial',
      valign: 'top',
      paraSpaceAfter: 6,
    });
  }

  // Bullet points
  if (slideData.bullets && slideData.bullets.length) {
    const bulletY = slideData.title ? 1.8 : 0.5;
    const bulletRows = slideData.bullets.map(b => ({
      text: b,
      options: { bullet: true, fontSize: 16, color: bodyColor, paraSpaceAfter: 6 },
    }));
    slide.addText(bulletRows, {
      x: 0.5, y: bulletY, w: '90%', h: 4,
      fontFace: 'Arial',
      valign: 'top',
    });
  }

  // Image
  if (slideData.image) {
    const imgOpts = {
      x: slideData.imageX ?? 5, y: slideData.imageY ?? 1.8,
      w: slideData.imageW ?? 4, h: slideData.imageH ?? 3,
    };
    if (slideData.image.startsWith('http')) {
      imgOpts.path = slideData.image;
    } else {
      imgOpts.path = slideData.image;
    }
    slide.addImage(imgOpts);
  }

  // Table
  if (slideData.table && slideData.table.length) {
    const tableY = slideData.title ? 1.8 : 0.5;
    const rows = slideData.table.map((row, i) =>
      row.map(cell => ({
        text: String(cell),
        options: {
          fontSize: 12,
          bold: i === 0,
          color: i === 0 ? 'FFFFFF' : bodyColor,
          fill: { color: i === 0 ? accentColor : (i % 2 === 0 ? 'f0f0f0' : 'FFFFFF') },
        },
      }))
    );
    slide.addTable(rows, {
      x: 0.5, y: tableY, w: '90%',
      border: { pt: 0.5, color: 'cccccc' },
      colW: Array(slideData.table[0].length).fill(12 / slideData.table[0].length),
    });
  }

  // Notes
  if (slideData.notes) {
    slide.addNotes(slideData.notes);
  }
}

await pres.writeFile({ fileName: outputPath });
console.log(outputPath);
