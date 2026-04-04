#!/usr/bin/env node
// pptx-helper.mjs: Generate .pptx presentations from JSON with smart layouts
// Usage: echo '{"title":"...","slides":[...]}' | node pptx-helper.mjs [output_path]

import PptxGenJS from 'pptxgenjs';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
const outputPath = process.argv[2] || `/workspace/group/presentation-${Date.now()}.pptx`;

const pres = new PptxGenJS();

if (input.title) pres.title = input.title;
if (input.author) pres.author = input.author;
if (input.subject) pres.subject = input.subject;
pres.layout = input.layout || 'LAYOUT_WIDE';

// Theme
const theme = input.theme || {};
const bgColor = theme.background || 'FFFFFF';
const accentColor = theme.accentColor || '6366f1'; // indigo-500

// Auto-detect dark background and adjust text colors
function hexLuminance(hex) {
  hex = hex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b);
}

function resolveColor(value, fallbackLight, fallbackDark, bg) {
  if (value && value !== 'auto') return value;
  return hexLuminance(bg) < 128 ? fallbackDark : fallbackLight;
}

function slideBgColor(slideData) {
  if (slideData.background) {
    if (slideData.background.startsWith('/') || slideData.background.startsWith('http')) return bgColor;
    return slideData.background;
  }
  return bgColor;
}

// Auto-detect layout
function detectLayout(s) {
  if (s.layout) return s.layout;
  const hasText = s.body || (s.bullets && s.bullets.length);
  const hasImage = !!s.image;
  const hasTable = s.table && s.table.length;
  const hasColumns = s.columns && s.columns.length;
  if (hasColumns) return 'comparison';
  if (hasTable) return 'table';
  if (hasImage && hasText) return 'image-right';
  if (hasImage) return 'image-full';
  if (!hasText && !hasTable) return 'title';
  return 'content';
}

// Render helpers
function addAccentBar(slide, color) {
  slide.addShape(pres.ShapeType.rect, {
    x: 0, y: 0, w: 0.15, h: '100%',
    fill: { color },
    line: { color, width: 0 },
  });
}

function addTitle(slide, text, opts = {}) {
  if (!text) return;
  const bg = opts.bg || bgColor;
  const color = resolveColor(opts.color, theme.titleColor || '1e293b', 'FFFFFF', bg);
  slide.addText(text, {
    x: opts.x ?? 0.6, y: opts.y ?? 0.3, w: opts.w ?? '85%',
    fontSize: opts.fontSize || 28,
    bold: true,
    color,
    fontFace: 'Arial',
  });
}

function addSubtitle(slide, text, opts = {}) {
  if (!text) return;
  slide.addText(text, {
    x: opts.x ?? 0.6, y: opts.y ?? 1.0, w: opts.w ?? '85%',
    fontSize: 18,
    color: accentColor,
    fontFace: 'Arial',
  });
}

function addBody(slide, text, opts = {}) {
  if (!text) return;
  const bg = opts.bg || bgColor;
  const color = resolveColor(opts.color, theme.bodyColor || '475569', 'D1D5DB', bg);
  slide.addText(text, {
    x: opts.x ?? 0.6, y: opts.y ?? 1.6, w: opts.w ?? '85%', h: opts.h ?? 4,
    fontSize: opts.fontSize || 16,
    color,
    fontFace: 'Arial',
    valign: 'top',
    paraSpaceAfter: 8,
    lineSpacingMultiple: 1.3,
  });
}

function addBullets(slide, bullets, opts = {}) {
  if (!bullets || !bullets.length) return;
  const bg = opts.bg || bgColor;
  const color = resolveColor(opts.color, theme.bodyColor || '475569', 'D1D5DB', bg);
  const rows = bullets.map(b => ({
    text: b,
    options: { bullet: { code: '2022' }, fontSize: opts.fontSize || 16, color, paraSpaceAfter: 10 },
  }));
  slide.addText(rows, {
    x: opts.x ?? 0.6, y: opts.y ?? 1.6, w: opts.w ?? '85%', h: opts.h ?? 4,
    fontFace: 'Arial',
    valign: 'top',
    lineSpacingMultiple: 1.3,
  });
}

// Download HTTP images to local temp files so pptxgenjs can embed them
const tempDir = mkdtempSync(join(tmpdir(), 'pptx-'));
let imgCounter = 0;

function resolveImagePath(src) {
  if (!src || !src.startsWith('http')) return src;
  try {
    const ext = src.match(/\.(png|jpe?g|gif|webp|svg)/i)?.[1] || 'png';
    const localPath = join(tempDir, `img-${++imgCounter}.${ext}`);
    execSync(`curl -sL -o "${localPath}" --max-time 15 "${src}"`, { timeout: 20000 });
    return localPath;
  } catch {
    console.error(`Warning: failed to download image: ${src}`);
    return src; // fallback to URL, may fail
  }
}

function addImage(slide, src, opts = {}) {
  if (!src) return;
  const localPath = resolveImagePath(src);
  slide.addImage({
    path: localPath,
    x: opts.x ?? 5, y: opts.y ?? 1.2,
    w: opts.w ?? 4.5, h: opts.h ?? 3.5,
    rounding: true,
  });
}

function addTable(slide, data, opts = {}) {
  if (!data || !data.length) return;
  const bg = opts.bg || bgColor;
  const isDark = hexLuminance(bg) < 128;
  const colCount = data[0].length;
  const fontSize = colCount > 4 ? 10 : 12;

  const rows = data.map((row, i) =>
    row.map(cell => ({
      text: String(cell),
      options: {
        fontSize,
        bold: i === 0,
        color: i === 0 ? 'FFFFFF' : (isDark ? 'E2E8F0' : '334155'),
        fill: { color: i === 0 ? accentColor : (isDark ? (i % 2 === 0 ? '334155' : '1e293b') : (i % 2 === 0 ? 'f1f5f9' : 'FFFFFF')) },
        margin: [6, 8, 6, 8],
        valign: 'middle',
      },
    }))
  );
  slide.addTable(rows, {
    x: opts.x ?? 0.6, y: opts.y ?? 1.6, w: opts.w ?? '85%',
    border: { pt: 0.5, color: isDark ? '475569' : 'e2e8f0' },
    colW: Array(colCount).fill((opts.tableW || 11.5) / colCount),
    autoPage: true,
  });
}

function setBackground(slide, slideData) {
  if (slideData.background) {
    if (slideData.background.startsWith('/') || slideData.background.startsWith('http')) {
      slide.background = { path: slideData.background };
    } else {
      slide.background = { color: slideData.background };
    }
  } else {
    slide.background = { color: bgColor };
  }
}

// --- Layout renderers ---

const layouts = {
  title(slide, s, bg) {
    // Centered title slide - no accent bar
    addTitle(slide, s.title, { y: 2.2, fontSize: 36, w: '80%', x: 1.3, bg });
    addSubtitle(slide, s.subtitle, { y: 3.2, w: '80%', x: 1.3 });
    if (s.body) addBody(slide, s.body, { y: 3.8, w: '70%', x: 2, fontSize: 14, bg });
    if (s.image) addImage(slide, s.image, { x: 3.5, y: 1.0, w: 3, h: 1.5 });
    // Decorative bottom bar
    slide.addShape(pres.ShapeType.rect, {
      x: 1.3, y: 3.05, w: 2, h: 0.06,
      fill: { color: accentColor },
      line: { width: 0 },
    });
  },

  content(slide, s, bg) {
    addAccentBar(slide, accentColor);
    addTitle(slide, s.title, { bg });
    addSubtitle(slide, s.subtitle);
    const contentY = s.subtitle ? 1.6 : (s.title ? 1.3 : 0.5);
    if (s.body) addBody(slide, s.body, { y: contentY, bg });
    if (s.bullets) addBullets(slide, s.bullets, { y: contentY, bg });
  },

  'image-right'(slide, s, bg) {
    addAccentBar(slide, accentColor);
    addTitle(slide, s.title, { w: '55%', bg });
    addSubtitle(slide, s.subtitle, { w: '55%' });
    const contentY = s.subtitle ? 1.6 : (s.title ? 1.3 : 0.5);
    if (s.body) addBody(slide, s.body, { y: contentY, w: 5.8, bg });
    if (s.bullets) addBullets(slide, s.bullets, { y: contentY, w: 5.8, bg });
    addImage(slide, s.image, { x: 7, y: 1.0, w: 5.2, h: 4.2 });
  },

  'image-left'(slide, s, bg) {
    addAccentBar(slide, accentColor);
    addImage(slide, s.image, { x: 0.5, y: 1.0, w: 5.2, h: 4.2 });
    addTitle(slide, s.title, { x: 6.2, w: 5.5, bg });
    addSubtitle(slide, s.subtitle, { x: 6.2, w: 5.5 });
    const contentY = s.subtitle ? 1.6 : (s.title ? 1.3 : 0.5);
    if (s.body) addBody(slide, s.body, { x: 6.2, y: contentY, w: 5.5, bg });
    if (s.bullets) addBullets(slide, s.bullets, { x: 6.2, y: contentY, w: 5.5, bg });
  },

  'image-full'(slide, s, bg) {
    // No accent bar - let image breathe
    addTitle(slide, s.title, { y: 0.2, fontSize: 24, bg });
    addImage(slide, s.image, { x: 1.5, y: 1.0, w: 10, h: 5.5 });
  },

  comparison(slide, s, bg) {
    addAccentBar(slide, accentColor);
    addTitle(slide, s.title, { bg });
    const cols = s.columns || [];
    const col1 = cols[0] || {};
    const col2 = cols[1] || {};
    // Column 1
    if (col1.title) {
      slide.addText(col1.title, {
        x: 0.6, y: 1.3, w: 5.5,
        fontSize: 18, bold: true, color: accentColor, fontFace: 'Arial',
      });
    }
    if (col1.bullets) addBullets(slide, col1.bullets, { x: 0.6, y: 1.9, w: 5.5, h: 3.5, bg });
    if (col1.body) addBody(slide, col1.body, { x: 0.6, y: 1.9, w: 5.5, h: 3.5, bg });
    // Divider line
    slide.addShape(pres.ShapeType.line, {
      x: 6.4, y: 1.3, w: 0, h: 4,
      line: { color: accentColor, width: 1, dashType: 'dash' },
    });
    // Column 2
    if (col2.title) {
      slide.addText(col2.title, {
        x: 6.8, y: 1.3, w: 5.5,
        fontSize: 18, bold: true, color: accentColor, fontFace: 'Arial',
      });
    }
    if (col2.bullets) addBullets(slide, col2.bullets, { x: 6.8, y: 1.9, w: 5.5, h: 3.5, bg });
    if (col2.body) addBody(slide, col2.body, { x: 6.8, y: 1.9, w: 5.5, h: 3.5, bg });
  },

  table(slide, s, bg) {
    addAccentBar(slide, accentColor);
    addTitle(slide, s.title, { bg });
    addSubtitle(slide, s.subtitle);
    const tableY = s.subtitle ? 1.6 : (s.title ? 1.3 : 0.5);
    addTable(slide, s.table, { y: tableY, bg });
    // Also render bullets below table if present
    if (s.bullets) {
      const bulletY = tableY + 0.5 + (s.table.length * 0.45);
      addBullets(slide, s.bullets, { y: Math.min(bulletY, 4.5), bg });
    }
  },
};

// --- Main render loop ---

for (const slideData of (input.slides || [])) {
  const slide = pres.addSlide();
  setBackground(slide, slideData);

  const bg = slideBgColor(slideData);
  const layout = detectLayout(slideData);
  const renderer = layouts[layout] || layouts.content;
  renderer(slide, slideData, bg);

  if (slideData.notes) slide.addNotes(slideData.notes);
}

await pres.writeFile({ fileName: outputPath });
console.log(outputPath);
