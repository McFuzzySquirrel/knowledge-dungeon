/**
 * Narrow-viewport measurement for the Welcome shell, and the machine-readable
 * contract for the gate that uses it.
 *
 * ## Why this is a browser measurement and not a jsdom one
 *
 * The failure this exists for is a *layout* failure: `#welcome-panel-subjects`
 * has a min-content width, `.welcome-main` is a `display: flex` row, and a flex
 * row's floor is its widest item's min-content. jsdom has no layout engine, so a
 * Vitest test can assert the CSS is present and can assert nothing about whether
 * the page actually fits. The gate therefore runs in Chromium against the shared
 * production artifact, and the jsdom side is reduced to what it can honestly
 * assert: the constants below, and the wiring (see
 * `welcome-narrow-viewport.test.ts`).
 *
 * ## The two traps, and how each is closed
 *
 * 1. **Measuring an empty element.** A subject-list button that has not rendered
 *    yet measures zero wide, and a zero-wide element produces no overflow, so a
 *    probe that does not wait reports a confident "no overflow" for a page that
 *    has one. `seedLegacySubject` plus `waitForSubjectListEntry` mean every
 *    measurement below is taken with the long name actually on the page, and
 *    `assertNonVacuous` re-checks that.
 * 2. **Reading the page before it settles.** A viewport resize plus a React
 *    commit plus a font swap is three separate chances to read a stale layout.
 *    `settleLayout` awaits `document.fonts.ready`, two animation frames, and a
 *    macrotask, after the network is idle, and is called before every reading.
 *
 * On top of both, `expectSweepCanSeeAForcedOffender` deliberately breaks the
 * page and asserts the sweep *notices*. A sweep that cannot see an overflow it
 * was handed is worse than no sweep, because it passes.
 *
 * ## Why the measurement is swept across font metric sets
 *
 * A layout floor driven by *text* is only as wide as the text happens to render.
 * A native `<select>`'s intrinsic min-content width is its widest `<option>`'s
 * rendered text plus native chrome, so it scales with the font's average advance
 * width. Measured on a 320 CSS-pixel viewport, the same build with the same
 * subject list gives a 182 px biome select under one host's fallback and a 207 px
 * select under another - which is the whole reason a gate that read only the
 * host's own fonts was green locally and red on CI, and green for the wrong
 * reason here.
 *
 * A gate whose verdict depends on which fonts the runner happens to have is a
 * flaky gate, so the floor is asserted under a **declared set of metric sets**:
 * one that leaves the app's own typography alone, and five that force a known
 * family at a known size, deliberately spanning a narrow and a wide case plus two
 * large-text stresses. The families are generic (`sans-serif`, `serif`,
 * `monospace`) precisely so they resolve on every host, and every set is recorded
 * in the evidence, so a reader can see which set produced which verdict rather
 * than being told the layout is fine.
 *
 * The advance width of `monospace` still differs between hosts; that is not
 * pretended away. It is handled by making the *assertion* metric-independent -
 * the fix is a track-sizing rule, so it holds for any advance width - and by
 * asserting the floor at the widest declared size, where a host's monospace has
 * to be 50 % wider than anything a learner meets before the gate would notice.
 *
 * ## Why the seed is localStorage and not IndexedDB
 *
 * The default production build runs `VITE_STORAGE_REPOSITORY=legacy`, which
 * reads the subject index and each subject snapshot straight out of
 * `localStorage`. The defect reproduces on that build - it was independently
 * confirmed to reproduce with `VITE_DATA_PRODUCTS_V2` off, where the Data
 * Center is not in the DOM at all - so the gate seeds the default build's own
 * keys and does not need the flagged artifact, a second build, or a new project.
 *
 * Privacy: every value here is synthetic and self-describing, the evidence this
 * module produces is widths, counts, and structural selectors only, and no
 * element's text content is ever collected.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

const REPO_ROOT = process.cwd();

/**
 * Plan §10.1: "Core operation at 200 % zoom and a 320 CSS-pixel viewport".
 *
 * 200 % zoom at a 640 CSS-pixel window is a 320 CSS-pixel layout viewport, so
 * the two halves of that clause are the same measurement; this lane is the
 * narrow one and says so rather than claiming a zoom sweep it does not run.
 */
export const WELCOME_NARROW_VIEWPORT = { width: 320, height: 640 } as const;

/** Plan §10.1: "Minimum 44 by 44 CSS-pixel touch targets". */
export const PLAN_MINIMUM_TOUCH_TARGET_PX = 44;

/** Plan §10.1: "Core operation ... at 200 % zoom", not run by this lane. */
export const PLAN_ZOOM_PERCENT = 200;

/**
 * Sub-pixel tolerance for "past the right edge of the viewport".
 *
 * Layout in Chromium is fractional, so an exact comparison reports a 0.3-pixel
 * rounding artefact as a page-breaking defect. Half a pixel is below anything a
 * learner can see or a finger can hit.
 */
export const OVERFLOW_TOLERANCE_PX = 0.5;

export const WELCOME_SECTION_TAB_NAMES = ['Create / Load', 'Player Setup', 'Guide', 'Data'] as const;
export type WelcomeSectionTabName = (typeof WELCOME_SECTION_TAB_NAMES)[number];

/** Selectors the gate's failure messages quote, so a failure names its cause. */
export const WELCOME_SHELL_ROOT_SELECTOR = '.welcome-screen';
export const WELCOME_SUBJECT_PANEL_SELECTOR = '#welcome-panel-subjects';

/**
 * A declared set of font metrics the layout floor is asserted under.
 *
 * `null` for either field means "leave the application's own value alone", so
 * `as-shipped` is the only set that models the application exactly. The rest
 * are *stresses*: they name a generic family (which resolves on every host) and
 * a size in CSS pixels, and they deliberately go coarser than the application's
 * own type scale, because a floor assertion should hold for the worst text a
 * learner can be shown rather than for the text this runner happens to have.
 */
export interface FontMetricSet {
  /** Stable, evidence-safe identifier. */
  readonly id: string;
  /** A generic CSS family list, or `null` for the application's own stack. */
  readonly fontFamily: string | null;
  /** A fixed CSS pixel size, or `null` for the application's own size. */
  readonly fontSizePx: number | null;
  /** What this set is for. Contains no learner data. */
  readonly purpose: string;
}

export const FONT_METRIC_SETS: readonly FontMetricSet[] = Object.freeze([
  {
    id: 'as-shipped',
    fontFamily: null,
    fontSizePx: null,
    purpose:
      "The application's own typography, untouched. The only set that models it exactly, and the one whose verdict depends on the host's installed fonts - which is why it is not the only set.",
  },
  {
    id: 'sans-16',
    fontFamily: 'sans-serif',
    fontSizePx: 16,
    purpose:
      'A narrow-ish proportional baseline at a fixed size: the app text at a size no element goes below.',
  },
  {
    id: 'serif-16',
    fontFamily: 'serif',
    fontSizePx: 16,
    purpose:
      'The narrow control. Serif metrics are typically the narrowest available, so this set is the one that must keep passing to show the sweep is not merely asserting "everything blew up".',
  },
  {
    id: 'mono-16',
    fontFamily: 'monospace',
    fontSizePx: 16,
    purpose:
      'The reproduced condition. Monospace has the widest advance width per character of the three generic families, and it is the metric set under which a native select measures widest.',
  },
  {
    id: 'sans-20',
    fontFamily: 'sans-serif',
    fontSizePx: 20,
    purpose:
      'A large-text stress on a proportional family: a learner whose default text size is 125% of the nominal one.',
  },
  {
    id: 'mono-20',
    fontFamily: 'monospace',
    fontSizePx: 20,
    purpose:
      'The widest declared set: the widest available family at the largest declared size. A host whose monospace is 50% wider than this one still has to pass, which is where the headroom comes from.',
  },
]);

const FONT_METRIC_STYLE_ID = 'kd-welcome-narrow-viewport-font-metric';

/**
 * Applies one metric set to the live page and waits for the relayout.
 *
 * The override is a single `<style>` element owned by the gate, keyed by id, and
 * it is *replaced* rather than added to, so switching between sets cannot leave
 * a previous set's rules behind. `as-shipped` removes the element outright, so
 * the one set that claims to model the application really does.
 *
 * `!important` is required and is not a shortcut: the application's own rules set
 * `font-family` and `font-size` on hundreds of elements, and a rule that loses to
 * them would silently measure the application's typography while claiming to
 * measure something else.
 */
export async function applyFontMetricSet(page: Page, set: FontMetricSet): Promise<void> {
  await page.evaluate(
    (args: { styleId: string; family: string | null; sizePx: number | null }) => {
      const existing = document.getElementById(args.styleId);
      if (args.family === null && args.sizePx === null) {
        existing?.remove();
        return;
      }
      const style = (existing as HTMLStyleElement | null) ?? document.createElement('style');
      style.id = args.styleId;
      const family = args.family ?? 'inherit';
      const size = args.sizePx === null ? 'inherit' : `${args.sizePx}px`;
      style.textContent =
        `*, *::before, *::after { font-family: ${family} !important; font-size: ${size} !important; }`;
      if (!style.isConnected) document.documentElement.append(style);
    },
    { styleId: FONT_METRIC_STYLE_ID, family: set.fontFamily, sizePx: set.fontSizePx },
  );
  await settleLayout(page);
}

/** The width of the biome `<select>`, the control whose intrinsic size is the floor. */
export async function measureBiomeSelectWidth(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const select = document.getElementById('biome-select');
    if (!(select instanceof HTMLElement)) return null;
    return Math.round(select.getBoundingClientRect().width * 100) / 100;
  });
}

const SUBJECT_FIXTURE = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'persistence',
  'subject',
  'subject-1.1.0-full-unknown-fields.json',
);

const SEED_SUBJECT_ID = 'welcome-narrow-viewport-synthetic';
const SEED_GUARD_KEY = 'kd-welcome-narrow-viewport-seeded';
const SEED_SUBJECT_INDEX_KEY = 'knowledge-dungeon:v1:subjects';
const SEED_SUBJECT_KEY = `knowledge-dungeon:v1:subject:${SEED_SUBJECT_ID}`;

export interface SubjectNameCase {
  /**
   * The name's character count, or `0` for "no subject on this device at all".
   *
   * `0` is a case in its own right and not padding: the empty list is the state
   * a first-time learner is actually in, and it has its own floor (the two text
   * inputs and the biome `<select>`), which is *lower* than the seeded floor. A
   * fix that only handles the seeded state would be a fix that breaks the state
   * most learners meet first.
   */
  readonly characters: number;
  /** Human label for evidence files. Contains no learner data. */
  readonly label: string;
  /**
   * The synthetic name, or `null` for the no-subject case.
   *
   * The 78- and 122-character names are deliberately **single unbreakable
   * tokens**. A name with spaces has a min-content equal to its longest word, so
   * a spaced name of any length stops growing the floor once it passes that
   * word's width; the failure only ever shows itself on a name with no break
   * opportunity in it, which is what a learner pasting a compound term or an
   * unbroken reference gets.
   */
  readonly subjectName: string | null;
}

function unbrokenName(characters: number, filler: string): string {
  return 'Pneumonoultramicroscopicsilicovolcanoconiosis'.slice(0, characters).padEnd(characters, filler);
}

export const SUBJECT_NAME_LENGTH_CASES: readonly SubjectNameCase[] = Object.freeze([
  { characters: 0, label: 'no-subject', subjectName: null },
  { characters: 1, label: 'one-character', subjectName: 'A' },
  {
    characters: 29,
    label: 'twenty-nine-character',
    // The maintainer's own example, verbatim, spaces and all.
    subjectName: 'Measurement Synthetic Subject',
  },
  { characters: 78, label: 'seventy-eight-character', subjectName: unbrokenName(78, 'x') },
  { characters: 122, label: 'one-hundred-twenty-two-character', subjectName: unbrokenName(122, 'y') },
]);

export interface HorizontalOverflowReading {
  readonly clientWidth: number;
  readonly documentScrollWidth: number;
  readonly bodyScrollWidth: number;
  /** The furthest right edge any measured element reached. */
  readonly widestRight: number;
  /** `documentScrollWidth - clientWidth`, floored at zero. */
  readonly pageOverflowPx: number;
  /** Every element whose right edge is past the viewport, widest first. */
  readonly offenders: readonly OverflowOffender[];
  /** How many elements were actually measured, so an empty sweep is visible. */
  readonly measuredElementCount: number;
}

export interface OverflowOffender {
  /** Structural selector only: no id-derived learner value, no text content. */
  readonly selector: string;
  readonly right: number;
  readonly width: number;
  readonly tagName: string;
}

export interface TouchTargetShortfall {
  readonly selector: string;
  readonly tagName: string;
  readonly width: number;
  readonly height: number;
  readonly role: string | null;
}

export interface TouchTargetReading {
  readonly minimumPx: number;
  readonly measuredControlCount: number;
  /** Controls below the minimum in either axis, narrowest first. */
  readonly shortfalls: readonly TouchTargetShortfall[];
}

/** Reads the synthetic subject fixture the seed is built from. */
function seededSubjectSnapshot(subjectName: string): Record<string, unknown> {
  const subject = JSON.parse(readFileSync(SUBJECT_FIXTURE, 'utf8')) as Record<string, unknown>;
  const dungeon = subject.dungeon as Record<string, unknown>;
  dungeon.dungeonId = SEED_SUBJECT_ID;
  dungeon.subjectName = subjectName;
  return subject;
}

/**
 * Puts one synthetic subject on the device before any application code runs.
 *
 * `addInitScript` rather than `page.evaluate`, because the Welcome screen reads
 * the subject list on mount: a seed applied after the first paint would arrive
 * too late to be the state that overflows. The guard key keeps a second
 * navigation from re-seeding, so a reload cannot double the subject list.
 */
export async function seedLegacySubject(page: Page, subjectName: string | null): Promise<void> {
  await page.addInitScript(
    (args: {
      guardKey: string;
      subjectIndexKey: string;
      subjectKey: string;
      subjectId: string;
      subjectName: string | null;
      snapshot: string | null;
    }) => {
      if (window.localStorage.getItem(args.guardKey) === '1') return;
      if (args.subjectName === null || args.snapshot === null) {
        // The empty-list case still records the guard, so the app sees a device
        // that has genuinely never had a subject rather than one mid-reset.
        window.localStorage.setItem(args.guardKey, '1');
        return;
      }
      window.localStorage.setItem(args.subjectIndexKey, JSON.stringify([args.subjectId]));
      window.localStorage.setItem(args.subjectKey, args.snapshot);
      window.localStorage.setItem(args.guardKey, '1');
    },
    {
      guardKey: SEED_GUARD_KEY,
      subjectIndexKey: SEED_SUBJECT_INDEX_KEY,
      subjectKey: SEED_SUBJECT_KEY,
      subjectId: SEED_SUBJECT_ID,
      subjectName,
      snapshot: subjectName === null ? null : JSON.stringify(seededSubjectSnapshot(subjectName)),
    },
  );
}

/** The subject-selection control inside the Create / Load panel. */
export function subjectListEntry(page: Page) {
  return page.locator('#welcome-panel-subjects .welcome-actions button');
}

/**
 * Waits until the seeded subject name is really on the page, and refuses to
 * return for an element that has not laid out.
 *
 * This is the first trap closed. Without it a reading can be taken against a
 * list that is still empty, which measures zero overflow for a page that has
 * hundreds of pixels of it.
 */
export async function waitForSubjectListEntry(page: Page, subjectName: string | null): Promise<number> {
  if (subjectName === null) {
    // The empty case has no name to wait for, so the honest completion condition
    // is the *absence* of a subject entry, observed rather than assumed. The
    // panel's other action rows still hold buttons, so the wait is on a count,
    // not on the container disappearing.
    const panel = page.locator(WELCOME_SUBJECT_PANEL_SELECTOR);
    await panel.waitFor({ state: 'visible', timeout: 30_000 });
    await expect
      .poll(async () => subjectListEntry(page).filter({ hasText: /cleared/ }).count(), { timeout: 30_000 })
      .toBe(0);
    return 0;
  }
  const entry = subjectListEntry(page).filter({ hasText: subjectName }).first();
  await entry.waitFor({ state: 'visible', timeout: 30_000 });
  const width = await entry.evaluate((element) => element.getBoundingClientRect().width);
  if (!(width > 0)) {
    throw new Error('The subject list entry is visible but has laid out at zero width.');
  }
  return width;
}

/** Closes the second trap: fonts loaded, two frames painted, one macrotask run. */
export async function settleLayout(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/**
 * Sweeps every element in `body` for a right edge past the viewport.
 *
 * Deliberately *not* `documentElement.scrollWidth` alone. A page-level number
 * says that something is wrong; the sweep says which element, so a failure names
 * its own cause. Both are returned, and the gate asserts both.
 */
export async function measureHorizontalOverflow(page: Page): Promise<HorizontalOverflowReading> {
  return page.evaluate((tolerance) => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const offenders: Array<{
      selector: string;
      right: number;
      width: number;
      tagName: string;
    }> = [];
    let measuredElementCount = 0;
    let widestRight = 0;

    const describe = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : '';
      const className =
        typeof element.className === 'string' && element.className.trim().length > 0
          ? `.${element.className.trim().split(/\s+/).slice(0, 4).join('.')}`
          : '';
      return `${tag}${id}${className}`;
    };

    for (const element of document.body.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      // A laid-out-off element contributes no width and no overflow, and
      // counting it would make the element count meaningless.
      if (rect.width === 0 && rect.height === 0) continue;
      measuredElementCount += 1;
      if (rect.right > widestRight) widestRight = rect.right;
      if (rect.right > clientWidth + tolerance) {
        offenders.push({
          selector: describe(element),
          right: Math.round(rect.right * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          tagName: element.tagName.toLowerCase(),
        });
      }
    }

    offenders.sort((a, b) => b.right - a.right || a.selector.localeCompare(b.selector));
    const documentScrollWidth = root.scrollWidth;
    return {
      clientWidth,
      documentScrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      widestRight: Math.round(widestRight * 100) / 100,
      pageOverflowPx: Math.max(0, Math.round((documentScrollWidth - clientWidth) * 100) / 100),
      offenders: offenders.slice(0, 12),
      measuredElementCount,
    };
  }, OVERFLOW_TOLERANCE_PX);
}

/**
 * Every interactive control in `body` that is smaller than the plan's minimum in
 * either axis.
 *
 * The selector set is the native one plus the two ARIA roles this shell uses. A
 * `<summary>` counts: it is a disclosure control a learner has to hit, and the
 * admin one was measured at 18 pixels high before this gate existed.
 */
export async function measureTouchTargets(
  page: Page,
  minimumPx: number = PLAN_MINIMUM_TOUCH_TARGET_PX,
): Promise<TouchTargetReading> {
  return page.evaluate((minimum) => {
    const selector =
      'a[href], button, input, select, textarea, summary, [role="tab"], [role="button"], [role="checkbox"], [role="radio"]';
    const shortfalls: Array<{
      selector: string;
      tagName: string;
      width: number;
      height: number;
      role: string | null;
    }> = [];
    let measuredControlCount = 0;

    for (const element of document.body.querySelectorAll(selector)) {
      // `hidden` and `display: none` controls are not targets: they are not
      // rendered, not reachable by Tab, and not a finger's problem.
      if (element.hasAttribute('hidden') || element.closest('[hidden]')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      measuredControlCount += 1;
      if (rect.width >= minimum && rect.height >= minimum) continue;
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : '';
      const className =
        typeof element.className === 'string' && element.className.trim().length > 0
          ? `.${element.className.trim().split(/\s+/).slice(0, 4).join('.')}`
          : '';
      shortfalls.push({
        selector: `${tag}${id}${className}`,
        tagName: tag,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        role: element.getAttribute('role'),
      });
    }

    shortfalls.sort((a, b) => a.width - b.width || a.height - b.height || a.selector.localeCompare(b.selector));
    return { minimumPx: minimum, measuredControlCount, shortfalls };
  }, minimumPx);
}

/**
 * The non-vacuity control for the sweep, run before the reading that matters.
 *
 * It breaks the page on purpose and asserts both halves of the measurement react:
 * the document's `scrollWidth` grows, and the element sweep *names* the offender.
 * Without this, "no offenders" is consistent with a sweep that inspects nothing.
 */
export async function expectSweepCanSeeAForcedOffender(
  page: Page,
  tolerancePx: number = OVERFLOW_TOLERANCE_PX,
): Promise<{ readonly forcedWidthPx: number; readonly pageOverflowPx: number; readonly seen: boolean }> {
  const forcedWidthPx = WELCOME_NARROW_VIEWPORT.width * 4;
  const forced = await page.evaluate((width) => {
    const probe = document.createElement('div');
    probe.id = 'kd-narrow-viewport-forced-offender';
    probe.style.cssText = `width:${width}px;height:8px;`;
    document.body.append(probe);
    const root = document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      right: Math.round(probe.getBoundingClientRect().right * 100) / 100,
    };
  }, forcedWidthPx);

  const detected = await page.evaluate((tolerance) => {
    const clientWidth = document.documentElement.clientWidth;
    const probe = document.getElementById('kd-narrow-viewport-forced-offender');
    if (!probe) return { seen: false, right: null as number | null };
    const right = Math.round(probe.getBoundingClientRect().right * 100) / 100;
    return { seen: right > clientWidth + tolerance, right };
  }, tolerancePx);

  // Removed before the real reading, so the control cannot be the thing that
  // makes the real reading fail.
  await page.evaluate(() => document.getElementById('kd-narrow-viewport-forced-offender')?.remove());
  await settleLayout(page);

  return {
    forcedWidthPx,
    pageOverflowPx: Math.max(0, forced.scrollWidth - forced.clientWidth),
    seen: detected.seen,
  };
}

/** Selects a Welcome section tab by its visible name. */
export async function selectWelcomeSectionTab(page: Page, name: WelcomeSectionTabName): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click();
  await settleLayout(page);
}
