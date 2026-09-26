#!/usr/bin/env node

/* global document, window, Element, HTMLElement, NodeFilter, getComputedStyle */
/*
 * The browser globals above are declared rather than configured, because this file
 * mixes Node (a preview server, Playwright) with browser code that runs inside the
 * page through `page.evaluate`. A global comment is file-scoped, so the
 * repository's lint configuration is left exactly as it was and no other script
 * gains a browser environment it does not have.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

import { chromium } from '@playwright/test';

const ROOT = resolve(process.cwd());
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.KD_VERIFIER_A11Y_PORT ?? 43197);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function startPreview() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', ORIGIN);
    let filePath = join(DIST, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname.endsWith('/')) filePath = join(filePath, 'index.html');
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      response.end(body);
    } catch (error) {
      process.stderr.write(`[verifier-a11y] MISS ${filePath} ${String(error).slice(0, 120)}\n`);
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });
  return new Promise((done) => server.listen(PORT, '127.0.0.1', () => done(server)));
}

const MEASURE = () => {
  const out = { contrast: [], nonText: [], targets: [], liveRegions: [], headings: [], roles: [] };
  const surface = document.querySelector('[data-kd-surface="data-center"]');
  out.present = surface !== null;
  if (!surface) return out;

  const parseColor = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value ?? '');
    if (!match) return null;
    const parts = (match[1] ?? '').split(/[,\s/]+/).filter(Boolean).map((part) => Number.parseFloat(part));
    return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] === undefined ? 1 : parts[3] };
  };
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (foreground, background) => {
    const a = luminance(foreground);
    const b = luminance(background);
    return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
  };
  /** The nearest ancestor background that is actually opaque. */
  const paintedBehind = (element) => {
    let node = element;
    while (node instanceof Element) {
      const style = getComputedStyle(node);
      const color = parseColor(style.backgroundColor);
      if (color && color.a > 0.95) {
        // A gradient is not a flat colour; report it so a false pass is visible.
        return { color, gradient: style.backgroundImage !== 'none' ? style.backgroundImage.slice(0, 60) : null };
      }
      node = node.parentElement;
    }
    return { color: { r: 255, g: 255, b: 255, a: 1 }, gradient: null };
  };

  // ── Text contrast, one measurement per distinct rendered style ──
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    if (text.length === 0) continue;
    const parent = node.parentElement;
    if (!(parent instanceof Element)) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (style.color === 'rgba(0, 0, 0, 0)') continue;
    const key = `${parent.tagName}.${parent.className}|${style.color}|${style.fontSize}|${style.fontWeight}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const foreground = parseColor(style.color);
    const behind = paintedBehind(parent);
    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    out.contrast.push({
      selector: `${parent.tagName}.${String(parent.className).split(' ')[0]}`,
      fontSizePx: size,
      fontWeight: style.fontWeight,
      large,
      ratio: foreground ? ratio(foreground, behind.color) : null,
      required: large ? 3 : 4.5,
      overGradient: behind.gradient !== null,
      sample: text.slice(0, 40),
    });
  }

  // ── Non-text contrast: a control's boundary against what is painted behind it ──
  for (const control of surface.querySelectorAll('button, input, [role="tab"], summary, a')) {
    const style = getComputedStyle(control);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const behind = paintedBehind(control.parentElement ?? control);
    const own = parseColor(style.backgroundColor);
    const border = parseColor(style.borderTopColor);
    const borderWidth = Number.parseFloat(style.borderTopWidth);
    // WCAG 1.4.11 is about the *boundary or graphic* needed to identify a control,
    // measured against what is painted behind it. The control's label is text and
    // is covered by 1.4.3, which is measured above, so it is not a candidate here.
    const candidates = [];
    if (border && border.a > 0 && borderWidth > 0) candidates.push({ what: 'border', color: border });
    if (own && own.a > 0) candidates.push({ what: 'fill', color: own });
    for (const candidate of candidates) {
      out.nonText.push({
        selector: `${control.tagName}.${String(control.className).split(' ')[0]}`,
        label: (control.textContent ?? control.getAttribute('aria-label') ?? '').trim().slice(0, 28),
        what: candidate.what,
        boundary: `${candidate.color.r},${candidate.color.g},${candidate.color.b}`,
        behind: `${behind.color.r},${behind.color.g},${behind.color.b}`,
        borderRatio: border && border.a > 0 && borderWidth > 0 ? ratio(border, behind.color) : null,
        ratio: ratio(candidate.color, behind.color),
        required: 3,
        overGradient: behind.gradient !== null,
      });
    }
  }

  // ── Touch targets: every focusable thing the surface renders ──
  for (const control of surface.querySelectorAll('button, input:not([hidden]), [role="tab"], summary, a, [tabindex]')) {
    const rect = control.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    out.targets.push({
      selector: `${control.tagName}.${String(control.className).split(' ')[0]}`,
      label: (control.textContent ?? control.getAttribute('aria-label') ?? '').trim().slice(0, 28),
      width: Number(rect.width.toFixed(1)),
      height: Number(rect.height.toFixed(1)),
      meets44: rect.width >= 44 && rect.height >= 44,
    });
  }

  // ── Focus indicator ──
  // Measured on whatever currently has focus, *including* the `:focus-visible`
  // state, and reported whether a focus indicator is visible at all. A control
  // focused with `element.focus()` from script does not match `:focus-visible` in
  // Chromium, so this is a real measurement only when the caller has pressed Tab.
  const active = document.activeElement;
  if (active instanceof HTMLElement && surface.contains(active)) {
    const style = getComputedStyle(active);
    const behind = paintedBehind(active.parentElement ?? active);
    const outline = parseColor(style.outlineColor);
    const hasOutline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
    const hasShadow = style.boxShadow !== 'none';
    out.focusIndicator = {
      activeSelector: `${active.tagName}.${String(active.className).split(' ')[0]}`,
      activeLabel: (active.textContent ?? '').trim().slice(0, 32),
      matchesFocusVisible: active.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidthPx: Number.parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
      outlineRatio: hasOutline && outline ? ratio(outline, behind.color) : null,
      hasBoxShadow: hasShadow,
      boxShadow: style.boxShadow.slice(0, 90),
      // A focus indicator exists when the outline is drawn *and* contrasts with
      // what is behind it, or when a shadow draws something visible.
      hasVisibleIndicator: (hasOutline && (outline ? ratio(outline, behind.color) >= 3 : false)) || hasShadow,
    };
  }

  // ── Motion ──
  const animated = Array.from(surface.querySelectorAll('*')).filter((element) => {
    const style = getComputedStyle(element);
    return (
      (style.transitionDuration !== '0s' && style.transitionDuration !== '') ||
      (style.animationName !== 'none' && style.animationName !== '')
    );
  });
  out.motion = {
    surfaceAttribute: surface.getAttribute('data-kd-motion'),
    animatedElementCount: animated.length,
    animatedSelectors: animated.slice(0, 6).map((element) => `${element.tagName}.${String(element.className).split(' ')[0]}`),
    longestTransitionSeconds: Math.max(
      0,
      ...animated.map((element) =>
        Math.max(
          ...getComputedStyle(element)
            .transitionDuration.split(',')
            .map((value) => Number.parseFloat(value) || 0),
        ),
      ),
    ),
  };

  // ── Live regions, headings, roles ──
  out.liveRegions = Array.from(surface.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).map(
    (element) => ({
      selector: `${element.tagName}.${String(element.className).split(' ')[0]}`,
      role: element.getAttribute('role'),
      ariaLive: element.getAttribute('aria-live'),
      text: (element.textContent ?? '').trim().slice(0, 48),
    }),
  );
  out.headings = Array.from(surface.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((element) => ({
    level: Number(element.tagName.slice(1)),
    text: (element.textContent ?? '').trim().slice(0, 40),
  }));
  out.roles = Array.from(surface.querySelectorAll('[role]')).map((element) => element.getAttribute('role'));
  out.dialogCount = document.querySelectorAll('[role="dialog"]').length;
  out.dialogModal = document.querySelector('[role="dialog"]')?.getAttribute('aria-modal') ?? null;

  // ── Layout overflow at the current viewport, and *where* it comes from ──
  out.overflow = {
    documentOffenders: Array.from(document.querySelectorAll('body *'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.right > window.innerWidth + 1;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${element.tagName}.${String(element.className).split(' ')[0]}@${Math.round(rect.right)}`;
      })
      .slice(0, 10),
    viewportWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    offenders: Array.from(surface.querySelectorAll('*'))
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .map((element) => `${element.tagName}.${String(element.className).split(' ')[0]}`)
      .slice(0, 8),
  };

  // ── The cascade interaction: what Chromium actually paints on a Data Center
  //    button, with the fixed doubled-class selector and with the original
  //    single-class selector the implementer says was outranked. ──
  const probe = document.createElement('button');
  probe.className = 'kd-button kd-button--primary';
  probe.textContent = 'probe';
  surface.appendChild(probe);
  const withFix = getComputedStyle(probe);
  out.cascade = {
    withFix: {
      background: withFix.backgroundImage === 'none' ? withFix.backgroundColor : withFix.backgroundImage.slice(0, 60),
      color: withFix.color,
      borderColor: withFix.borderTopColor,
      borderWidth: withFix.borderTopWidth,
      minHeight: withFix.minHeight,
    },
  };
  probe.remove();
  return out;
};

const CASCADE_EXPERIMENT = (mode) => {
  const out = { mode, disabled: [], collapsedRuleCount: 0, probe: null };
  // Collect the Data Center's own rules from its real stylesheet.
  let dataCenterRules = '';
  for (const sheet of Array.from(document.styleSheets)) {
    const href = sheet.href ?? '';
    if (!/DataCenter-[A-Za-z0-9_-]+\.css$/.test(href)) continue;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule.selectorText === undefined) continue;
      dataCenterRules += `${rule.selectorText}{${rule.style.cssText}}\n`;
    }
    // Disable the real sheet so only the injected copy is in play.
    const link = document.querySelector(`link[href$="${href.split('/').pop()}"]`);
    if (link) {
      link.disabled = true;
      out.disabled.push(href.split('/').pop());
    }
  }
  if (dataCenterRules.length === 0) return out;

  if (mode === 'as-shipped') {
    out.collapsedRuleCount = (dataCenterRules.match(/\{/g) ?? []).length;
    return out;
  }
  // The state before the fix: the same rules with the doubled class collapsed to a
  // single class, which is (0,2,0) and therefore loses to the shell's
  // `:root[data-graphics='rpg'] button` at (0,2,1).
  const collapsed = dataCenterRules.replace(/\.([A-Za-z][\w-]*)\.\1\b/g, '.$1');
  out.collapsedRuleCount = (collapsed.match(/\{/g) ?? []).length;
  out.sampleCollapsedRule = (collapsed.split('\n').find((line) => line.includes('.kd-button{')) ?? '').slice(0, 100);
  const style = document.createElement('style');
  style.dataset.verifierProbe = 'collapsed-doubled-class';
  style.textContent = collapsed;
  document.head.appendChild(style);

  const surface = document.querySelector('[data-kd-surface="data-center"]');
  const button = surface === null ? null : surface.querySelector('.kd-button--primary');
  if (button) {
    const computed = getComputedStyle(button);
    out.probe = {
      backgroundImage: computed.backgroundImage === 'none' ? 'none' : computed.backgroundImage.slice(0, 60),
      backgroundColor: computed.backgroundColor,
      color: computed.color,
      borderColor: computed.borderTopColor,
      boxShadow: computed.boxShadow === 'none' ? 'none' : computed.boxShadow.slice(0, 50),
      minHeight: computed.minHeight,
    };
  }
  return out;
};

const DIALOG = () => {
  const dialog = document.querySelector('[data-kd-surface="restore-confirmation"]');
  if (!dialog) return { open: false };
  const active = document.activeElement;
  const focusables = Array.from(
    dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ).filter((element) => element.getBoundingClientRect().width > 0);
  const rect = dialog.getBoundingClientRect();
  return {
    open: true,
    ariaModal: dialog.getAttribute('aria-modal'),
    labelledBy: dialog.getAttribute('aria-labelledby'),
    describedBy: dialog.getAttribute('aria-describedby'),
    focusableCount: focusables.length,
    focusableLabels: focusables.map((element) => (element.textContent ?? '').trim().slice(0, 32)),
    activeElement: (active?.textContent ?? active?.getAttribute('aria-label') ?? active?.tagName ?? '').trim().slice(0, 40),
    activeIsInsideDialog: dialog.contains(active),
    activeTag: active?.tagName ?? null,
    dialogBox: { width: Math.round(rect.width), height: Math.round(rect.height) },
    bodyText: (dialog.textContent ?? '').trim().slice(0, 400),
  };
};

const report = { schemaVersion: 1, suite: 'phase5-verifier-a11y', measurements: {} };

async function waitForWelcome(page) {
  try {
    await page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }).waitFor({ timeout: 30_000 });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: String(error.message).slice(0, 160),
      headings: await page
        .evaluate(() =>
          Array.from(document.querySelectorAll('h1,h2,h3')).map(
            (element) => `${element.tagName}:${(element.textContent ?? '').trim().slice(0, 40)}`,
          ),
        )
        .catch(() => []),
      bodyStart: await page.evaluate(() => (document.body.innerText ?? '').slice(0, 300)).catch(() => ''),
    };
  }
}

async function measureAt(page, target, label) {
  target[label] = await page.evaluate(MEASURE);
  return target[label];
}

async function main() {
  const server = await startPreview();
  const browser = await chromium.launch();
  const results = { pageErrors: [], bootResponses: [], bootFailed: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (error) => results.pageErrors.push(String(error.message).slice(0, 200)));
    page.on('response', (response) => results.bootResponses.push([response.status(), response.url().slice(0, 80)]));
    page.on('requestfailed', (request) => results.bootFailed.push([request.url().slice(0, 80), String(request.failure()?.errorText)]));
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    results.boot = await waitForWelcome(page);
    results.sidebarControlCount = await page.getByRole('button', { name: 'Open Data Center' }).count();
    await page.getByRole('button', { name: 'Open Data Center' }).first().click();
    await page.locator('[data-kd-surface="data-center"]').waitFor({ timeout: 30_000 });
    await page.getByRole('tab', { name: 'Full device backup' }).click();

    await measureAt(page, results, 'desktop-1280x900');

    // Focus indicator, measured with a real key press so `:focus-visible` applies.
    await page.keyboard.press('Tab');
    results.focusIndicatorByKeyboard = await page.evaluate(MEASURE);
    // The cascade experiment, with the real stylesheets and with the doubling
    // collapsed. Run on the `rpg` theme, which is the one that carries the shell
    // rule the implementer names.
    await page.evaluate(() => document.documentElement.setAttribute('data-graphics', 'rpg'));
    // As shipped: the real Data Center stylesheet, doubled class and all.
    results.cascadeAsShipped = await page.evaluate(() => {
      const surface = document.querySelector('[data-kd-surface="data-center"]');
      const button = surface === null ? null : surface.querySelector('.kd-button--primary');
      if (button === null) return { probe: null };
      const computed = getComputedStyle(button);
      return {
        probe: {
          backgroundImage: computed.backgroundImage === 'none' ? 'none' : computed.backgroundImage.slice(0, 60),
          backgroundColor: computed.backgroundColor,
          color: computed.color,
          borderColor: computed.borderTopColor,
          boxShadow: computed.boxShadow === 'none' ? 'none' : computed.boxShadow.slice(0, 50),
          minHeight: computed.minHeight,
        },
      };
    });
    // The state before the fix, reproduced without editing production source.
    results.cascadeWithDoubledClassCollapsed = await page.evaluate(CASCADE_EXPERIMENT, 'collapsed');
    results.cascadeDiffer =
      JSON.stringify(results.cascadeAsShipped.probe) !== JSON.stringify(results.cascadeWithDoubledClassCollapsed.probe);
    await page.evaluate(() => document.documentElement.removeAttribute('data-graphics'));

    // ── A real export, downloaded from the page ──
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Download device backup' }).click();
    const download = await downloadPromise;
    const archivePath = await download.path();
    const archive = archivePath === null ? null : await readFile(archivePath);
    results.export = {
      suggestedFilename: download.suggestedFilename(),
      byteLength: archive?.byteLength ?? 0,
      status: (await page.locator('[data-kd-surface="export-status"]').textContent())?.trim().slice(0, 200) ?? '',
    };

    // ── 320 CSS px and 200% zoom, measured on the same populated surface ──
    await page.setViewportSize({ width: 320, height: 640 });
    await measureAt(page, results, 'narrow-320x640');
    await page.setViewportSize({ width: 640, height: 450 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    await measureAt(page, results, 'zoom-200-percent');
    await page.evaluate(() => {
      document.documentElement.style.zoom = '';
    });
    await page.setViewportSize({ width: 1280, height: 900 });

    // ── The dialog, with a real archive ──
    const inspect = page.getByRole('button', { name: 'Inspect a backup file' });
    await inspect.focus();
    results.focusBeforeOpen = await page.evaluate(() => ({
      label: (document.activeElement?.textContent ?? '').trim().slice(0, 40),
    }));
    if (archive !== null) {
      await page.locator('input[type="file"]').setInputFiles({
        name: 'zz-verifier-round-trip.kdbak',
        mimeType: 'application/zip',
        buffer: archive,
      });
      await page.locator('[data-kd-surface="restore-confirmation"]').waitFor({ timeout: 30_000 });
      await page.waitForFunction(
        () => {
          const button = Array.from(document.querySelectorAll('button')).find((element) =>
            (element.textContent ?? '').includes('Replace device data'),
          );
          return button !== undefined && button.disabled === false;
        },
        undefined,
        { timeout: 30_000 },
      );
      results.dialogOnOpen = await page.evaluate(DIALOG);
      // Focus containment: tab far more times than there are controls and record
      // where focus goes.
      const visited = [];
      for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press('Tab');
        visited.push(await page.evaluate(DIALOG));
      }
      results.dialogFocusCycle = {
        steps: visited.length,
        allInsideDialog: visited.every((entry) => entry.activeIsInsideDialog === true),
        activeElements: visited.map((entry) => entry.activeElement),
        repeated: visited.map((entry) => entry.activeElement).filter((value, index, all) => all.indexOf(value) !== index),
      };
      // Escape, and restoration of focus to the control that opened it.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      results.afterEscape = await page.evaluate(DIALOG);
      results.focusAfterEscape = await page.evaluate(() => ({
        label: (document.activeElement?.textContent ?? document.activeElement?.tagName ?? '').trim().slice(0, 40),
        isInspectButton: (document.activeElement?.textContent ?? '').trim() === 'Inspect a backup file',
      }));
      // The preview surface, measured, with a real file chosen.
      results.previewText = (await page
        .locator('[data-kd-surface="backup-preview"]')
        .textContent()
        .catch(() => ''))?.trim().slice(0, 600) ?? '';
      results.previewHasDigest = /[0-9a-f]{64}/.test(results.previewText);
      results.previewShowsAttachmentId = /att-|attachment-/.test(results.previewText);
      // Re-open and perform the real restore, then read the outcome surface.
      await page.locator('input[type="file"]').setInputFiles({
        name: 'zz-verifier-round-trip.kdbak',
        mimeType: 'application/zip',
        buffer: archive,
      });
      await page.waitForFunction(
        () => {
          const button = Array.from(document.querySelectorAll('button')).find((element) =>
            (element.textContent ?? '').includes('Replace device data'),
          );
          return button !== undefined && button.disabled === false;
        },
        undefined,
        { timeout: 30_000 },
      );
      await page.getByRole('button', { name: 'Replace device data with this backup' }).click();
      await page
        .locator('[data-kd-surface="restore-outcome"]')
        .waitFor({ timeout: 60_000 });
      // The "Restoring" state is the busy one; the settled report is what follows.
      await page.waitForFunction(
        () => {
          const section = document.querySelector('[data-kd-surface="restore-outcome"]');
          return section !== null && !(section.textContent ?? '').includes('Writing the backup into a new copy');
        },
        undefined,
        { timeout: 60_000 },
      );
      results.outcome = await page.evaluate(() => {
        const section = document.querySelector('[data-kd-surface="restore-outcome"]');
        if (!section) return { present: false };
        return {
          present: true,
          text: (section.textContent ?? '').trim().slice(0, 900),
          liveRegion: section.querySelector('[aria-live], [role="status"], [role="alert"]')?.getAttribute('aria-live') ?? null,
          role: section.querySelector('[role="status"], [role="alert"]')?.getAttribute('role') ?? null,
          hasTechnicalDetails: section.querySelector('details') !== null,
        };
      });
      results.outcomeAfterRestore = await page.evaluate(MEASURE);
    }
    await context.close();

    // ── prefers-reduced-motion ──
    const reduced = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    const reducedPage = await reduced.newPage();
    reducedPage.on('pageerror', (error) => results.pageErrors.push(`reduced: ${String(error.message).slice(0, 200)}`));
    await reducedPage.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    try {
      await waitForWelcome(reducedPage);
    } catch (error) {
      // Record what the page actually rendered rather than losing the whole run.
      results.reducedMotionBootFailure = {
        message: String(error.message).slice(0, 200),
        headings: await reducedPage.evaluate(() =>
          Array.from(document.querySelectorAll('h1,h2,h3')).map((element) => `${element.tagName}:${(element.textContent ?? '').trim().slice(0, 40)}`),
        ),
        bodyStart: (await reducedPage.evaluate(() => (document.body.innerText ?? '').slice(0, 400))),
        reducedMotionMatches: await reducedPage.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
      };
      throw error;
    }
    await reducedPage.getByRole('button', { name: 'Open Data Center' }).first().click();
    await reducedPage.locator('[data-kd-surface="data-center"]').waitFor({ timeout: 30_000 });
    results.reducedMotion = await measureAt(reducedPage, results, 'reduced-motion');
    results.reducedMotionMediaMatches = await reducedPage.evaluate(
      () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );

    // ── Every graphics theme the shell declares ──
    results.themes = [];
    for (const graphics of ['rpg', 'cozy', 'classic', 'high-contrast']) {
      await reducedPage.evaluate((value) => {
        document.documentElement.setAttribute('data-graphics', value);
      }, graphics);
      const measured = await reducedPage.evaluate(MEASURE);
      results.themes.push({
        graphics,
        textContrastFailures: measured.contrast.filter((entry) => (entry.ratio ?? 0) < entry.required),
        nonTextFailures: measured.nonText.filter((entry) => entry.ratio < 3),
        targetsUnder44: measured.targets.filter((entry) => !entry.meets44),
        cascade: measured.cascade,
        focusIndicator: measured.focusIndicator,
        overflow: measured.overflow,
      });
    }
    await reduced.close();
  } catch (error) {
    results.fatal = String(error && error.stack ? error.stack : error).slice(0, 800);
  } finally {
    await browser.close();
    server.close();
  }
  report.measurements = results;
  mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
  writeFileSync(join(ROOT, 'artifacts', 'phase5-verifier-a11y.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
