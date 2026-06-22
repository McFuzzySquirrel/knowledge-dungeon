/**
 * Scans `public/assets/` recursively for SVG files, extracts dimensions from
 * `viewBox` or `width`/`height` attributes, and writes a sprite manifest JSON
 * to `public/assets/sprite-manifest.json`.
 *
 * Usage: node scripts/generate-sprite-manifest.mjs
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = resolve(__dirname, '..', 'public', 'assets');
const OUTPUT_PATH = join(ASSETS_ROOT, 'sprite-manifest.json');

/**
 * Attempt to extract width and height from SVG string.
 * Falls back to 64x64 if unparseable.
 */
function extractDimensions(svgContent) {
  // Try width/height attributes on the <svg> element
  const widthMatch = svgContent.match(/<svg[^>]*\swidth\s*=\s*"(\d+)"/i);
  const heightMatch = svgContent.match(/<svg[^>]*\sheight\s*=\s*"(\d+)"/i);
  if (widthMatch && heightMatch) {
    return { width: parseInt(widthMatch[1], 10), height: parseInt(heightMatch[1], 10) };
  }

  // Try third and fourth values from viewBox
  const viewBoxMatch = svgContent.match(/<svg[^>]*\sviewBox\s*=\s*"\d+\s+\d+\s+(\d+)\s+(\d+)"/i);
  if (viewBoxMatch) {
    return { width: parseInt(viewBoxMatch[1], 10), height: parseInt(viewBoxMatch[2], 10) };
  }

  return { width: 64, height: 64 };
}

/**
 * Recursively discover all .svg files under a directory.
 */
function walkSvgs(dir, root) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkSvgs(fullPath, root));
    } else if (entry.isFile() && entry.name.endsWith('.svg')) {
      const relPath = relative(root, fullPath);
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

function resolveCategory(relPath) {
  const dir = dirname(relPath).replace(/\\/g, '/');
  if (dir === '.' || dir === '') return 'Sprites';
  const parts = dir.split('/');
  // Capitalize first letter of each directory part
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function generateManifest() {
  const svgs = walkSvgs(ASSETS_ROOT, ASSETS_ROOT);
  svgs.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const sprites = [];
  for (const { fullPath, relPath } of svgs) {
    const content = readFileSync(fullPath, 'utf8');
    const { width, height } = extractDimensions(content);
    const name = basename(relPath, '.svg');
    const category = resolveCategory(relPath);

    sprites.push({
      path: relPath.replace(/\\/g, '/'),
      name,
      category,
      width,
      height,
    });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalSprites: sprites.length,
    sprites,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Sprite manifest written: ${OUTPUT_PATH} (${sprites.length} sprites)`);
}

generateManifest();
