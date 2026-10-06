import AxeBuilder from '@axe-core/playwright';
import type { Result as AxeResult } from 'axe-core';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

import {
  A11Y_KNOWN_BLOCKING_SIGNATURES,
  A11Y_MINIMUM_TOUCH_TARGET_PX,
  A11Y_SCANNED_SURFACES,
  A11Y_SURFACE_TITLE_SEPARATOR,
  A11Y_WCAG_TAGS,
  a11ySurfaceFromTestTitle,
  type A11ySurfaceId,
} from './a11y-matrix';

/**
 * The Phase 21 automated accessibility suite: an axe scan plus the DOM, keyboard and touch
 * checks that no automated analysis performs.
 *
 * ## What this suite is, and what it is not
 *
 * It is: a WCAG 2.2 A/AA automated scan of three named surfaces, a reachability-and-activation
 * pass over the controls on those surfaces with the keyboard and, on touch-emulated cells, with a
 * tap, and a measured touch-target floor.
 *
 * It is **not** a conformance claim, and the difference is not a formality. axe analyses the
 * accessibility tree and the CSS it can see; it cannot tell that a focus trap is wrong, that a
 * live region fires on every render, that a control is reachable in a sensible order, that a
 * dialog restores focus to the control that opened it, or that a screen reader announces anything
 * at all. The Phase 21 manual gates - ChromeVox, a physical Chromebook, a touch-platform screen
 * reader - are in `PHYSICAL_DEVICE_GATES` and are unreachable from this container. Every claim
 * this file makes is scoped to what it measured, and the runner that invokes it names the cells
 * that ran.
 *
 * ## Why three surfaces and not ten
 *
 * Phase 21's scope names ten. The per-surface assertions belong to the owners of those surfaces;
 * this file is the *runner* and the shared scan, and its claim is exactly the surfaces it lists in
 * {@link A11Y_SCANNED_SURFACES}. Naming the surfaces as data means the coverage block in the
 * runner's report can say what was scanned without this file being edited, and
 * `tests/phase21/infraA11ySuite.test.ts` asserts the unscanned list is non-empty while the phase is
 * in progress - so an incomplete audit cannot be mistaken for a complete one.
 *
 * ## The known-exception list
 *
 * `.hud-stat-subtle` is a Phase 1 contrast exception on the game HUD, already recorded by
 * `tests/e2e/phase10-media-lane.ts`. It is attached to "no *new* serious or critical violation" so
 * the allowance has a name, and the wiring gate asserts the list is non-empty: a suite that
 * tolerates nothing cannot prove it is measuring, and a suite that tolerates everything proves less
 * than it appears to.
 *
 * ## Privacy
 *
 * The application's own tutorial route, which mints its own subject. No learner data, no request
 * body, no header, no query, and no external host. Every recorded value is a count, a bounded
 * category, or a boolean.
 */

/** One axe violation, reduced to what a reader needs and nothing that could carry data. */
interface AxeFinding {
  readonly id: string;
  readonly impact: string;
  readonly help: string;
  /** A `role:name` description for up to three nodes, so a failure names what to look at. */
  readonly targets: readonly string[];
}

/** One measured control. No text, no ids that could be learner-shaped: roles and names only. */
interface ControlReading {
  readonly role: string;
  readonly accessibleName: string;
  readonly reachableByKeyboard: boolean;
  readonly activatedWithKeyboard: boolean;
  readonly width: number;
  readonly height: number;
  readonly touchTargetMet: boolean;
}

/**
 * Reduce one axe violation to a recordable shape.
 *
 * `target` is axe-resolved and can be a long CSS chain, so it is bounded. `html` is deliberately
 * **not** recorded: axe can echo text content there, and text content is the one thing in an
 * accessibility report that could carry learner data out of a device.
 */
function toFinding(violation: AxeResult): AxeFinding {
  return {
    id: violation.id,
    impact: violation.impact ?? 'unknown',
    help: violation.help,
    targets: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
  };
}

function isKnownBlocking(finding: AxeFinding): boolean {
  return A11Y_KNOWN_BLOCKING_SIGNATURES.some((signature) => {
    const [id, impact, selector] = signature.split('|');
    return finding.id === id && finding.impact === impact && finding.targets.some((target) => target.includes(selector));
  });
}

/**
 * Analyse and assert in one place, so all three surfaces are scanned the same way.
 *
 * `toHaveCount(0)`-style assertions are used deliberately: an assertion like
 * `expect(newFindings).toEqual([])` prints the whole array, which on a real page means printing
 * selector chains for a dozen nodes. Names and impacts are what a reader acts on, and the count is
 * what a gate needs.
 *
 * The **rule counts** come back with the assertion rather than being logged, because "no new serious
 * or critical violations" is also what a scan of an *empty document* reports. Every caller asserts
 * that the analysis actually ran, which is the non-vacuity half of an accessibility gate that the
 * violation list alone cannot carry.
 */
async function assertNoNewBlockingViolations(page: Page, surfaceId: string, testInfo: TestInfo): Promise<RuleCounts> {
  const results = await new AxeBuilder({ page }).withTags([...A11Y_WCAG_TAGS]).analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(toFinding);
  const newFindings = blocking.filter((finding) => !isKnownBlocking(finding));
  const counts: RuleCounts = {
    violations: results.violations.length,
    passes: results.passes.length,
    incomplete: results.incomplete.length,
  };

  await testInfo.attach(`${surfaceId}-axe.json`, {
    body: JSON.stringify(
      {
        surface: surfaceId,
        tags: A11Y_WCAG_TAGS,
        ...counts,
        seriousOrCritical: blocking,
        knownBlockingSignatures: A11Y_KNOWN_BLOCKING_SIGNATURES,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });

  expect(
    newFindings.map(
      (finding) =>
        `${finding.impact}:${finding.id} on ${finding.targets.join(' | ') || '(no target reported)'} - ${finding.help}`,
    ),
    `${surfaceId} has serious or critical automated accessibility violations the suite does not ` +
      `tolerate. Known tolerated signatures: ${A11Y_KNOWN_BLOCKING_SIGNATURES.join(', ')}. ` +
      'Targets are in the attached axe.json.',
  ).toEqual([]);
  return counts;
}

/** What one axe analysis found, in counts, so a caller can refuse a scan that measured nothing. */
interface RuleCounts {
  readonly violations: number;
  readonly passes: number;
  readonly incomplete: number;
}

/**
 * Assert that an analysis actually analysed something.
 *
 * `violations + passes + incomplete` is the number of rules axe resolved against this document. Zero
 * of them is the shape of a scan that never ran: injection refused, navigation to a shell that never
 * hydrated, or a `withTags` set that matched nothing. Any of those reports "zero serious or critical
 * violations" and is indistinguishable from a clean page, which is why the count has to be asserted
 * rather than inferred from the absence of a failure.
 */
function assertAnalysisRan(surfaceId: string, counts: RuleCounts): void {
  const resolved = counts.violations + counts.passes + counts.incomplete;
  expect(
    resolved,
    `the ${surfaceId} analysis resolved no rules at all, so "no serious or critical violations" is a ` +
      'measurement of nothing rather than a measurement of a clean surface',
  ).toBeGreaterThan(0);
}

/** Fonts loaded, two frames painted, one macrotask run. The same settle `currentBuild.spec.ts` uses. */
async function settle(page: Page): Promise<void> {
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
 * Whether this cell emulates touch, read from the page rather than from the matrix.
 *
 * Read the same way the tap check below reads it, so the two cannot disagree about the same cell.
 * The matrix is the authority on *what this cell is*; this is the authority on *what the browser is
 * doing*, and a tap needs the second.
 */
async function hasEmulatedTouch(page: Page): Promise<boolean> {
  return page.evaluate(() => 'ontouchstart' in window || navigator.maxTouchPoints > 0);
}

/** The drawer toggle, named by its stable test hook rather than by its label. */
const HUD_DRAWER_TOGGLE = '[data-village-touch-target="hud-toggle"]';
/** The nearby action list, which lives inside the HUD column and nowhere else. */
const VILLAGE_NEARBY = '[data-village-nearby="true"]';

/** What `openVillage` had to do to put the HUD in the state a learner on this device would. */
interface VillageHudState {
  /** Whether the HUD is a collapsed bottom sheet on this cell, and was opened by pressing its toggle. */
  readonly drawerOpened: boolean;
}

/**
 * Open the village through the tutorial route, and leave the HUD in the state a learner on this
 * device would have it in.
 *
 * The product's own route, deliberately: a seeded subject would make the audit describe a state a
 * learner cannot produce, and this suite's claim is about the application as shipped.
 *
 * ## Why the drawer is pressed rather than worked around
 *
 * On the two touch cells the village HUD is a bottom sheet that is **closed and unmounted by
 * default**: `useVillageSurfaceMode` returns `sheet` for a coarse or hoverless pointer, and
 * `VillageHud` then renders only the toggle and unmounts the whole column - the nearby action list
 * and the Settings launcher included - until the toggle is pressed. This suite's first version waited
 * for `[data-village-nearby="true"]` to be visible, which on those two cells is a wait for an element
 * the product never renders in that state. Both touch cells timed out at 60 seconds, which is why the
 * Phase 21 audit reported ten findings instead of one: six of them were two surfaces going unscanned
 * on two form factors, reported as failures rather than as the coverage gap they were.
 *
 * The fix is to press the toggle, and the ground for pressing it rather than skipping the surfaces
 * is that **the drawer is how a touch learner reaches them**. There is no second route: the only
 * caller of the village's Settings opener is the HUD column, and `data-village-nearby` is rendered in
 * one place, inside that same column. A coverage note saying "the village and Settings are unscanned
 * on tablet" would have been true about the probe and false about the product, and this file's whole
 * argument is that a report about the probe is not evidence about the product.
 *
 * The branch is on **whether the toggle is present**, not on the cell's form factor. That is
 * deliberate: the product decides the shape through three media queries plus `navigator.maxTouchPoints`,
 * and a narrow-but-not-touch viewport gets the same sheet. Following the product rather than
 * re-deriving its rule means a future cell cannot be scanned in a shape it does not have.
 */
async function openVillage(page: Page): Promise<VillageHudState> {
  await page.goto('/');
  await page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }).waitFor({ timeout: 30_000 });
  await settle(page);
  await page.getByRole('button', { name: 'Start Tutorial' }).click();
  await page.getByRole('button', { name: 'Go to Village' }).click({ timeout: 60_000 });
  await page.locator('[data-world]').waitFor({ timeout: 60_000 });

  const drawerToggle = page.locator(HUD_DRAWER_TOGGLE);
  const drawerOpened = (await drawerToggle.count()) > 0;
  if (drawerOpened) {
    // `tap` on a touch cell and `click` elsewhere, so the interaction is the one this device's
    // learner would perform. A `click` on a `hasTouch` cell synthesises a mouse event the product
    // never receives, which would make the audit describe a device nobody uses.
    const touch = await hasEmulatedTouch(page);
    if (touch) await drawerToggle.tap({ timeout: 30_000 });
    else await drawerToggle.click({ timeout: 30_000 });
  }

  await page.locator(VILLAGE_NEARBY).waitFor({ timeout: 60_000 });
  await settle(page);
  return { drawerOpened };
}

/**
 * One pass over every control in the document, partitioned into **rendered** and **not rendered**.
 *
 * ## Why one `evaluate` and not a locator per control
 *
 * Two reasons, and both were found by measurement rather than by reading. First, a locator
 * re-evaluated once per control on a page that re-renders means index drift: `nth(15)` on the second
 * pass is not the element `nth(15)` named on the first. Second, and the reason this file's first
 * draft produced eighteen false reds - **`<link>` elements in `<head>` match `[href]`**, so a
 * document-wide `[href]` sweep enumerates seven stylesheet links that are not controls at all, have
 * `tabIndex === -1`, and measure `0x0`.
 *
 * The second partition is equally load-bearing and equally measured. Six `.phase-card` buttons,
 * three `.class-card` buttons, the two JSON import/export controls and one input live in
 * **inactive tabpanels**: they are in the accessibility tree's document but laid out at `0x0`, and
 * a touch-target measurement of a `0x0` element is a measurement of nothing. They are reported as
 * `notRendered` and asserted on only when their tab is selected.
 *
 * ## What `accessibleName` is, and what it is not
 *
 * A diagnostic label: `aria-label`, then `aria-labelledby`, then an associated `<label>`, then the
 * element's own text. That is **not** the full accessible-name computation, and it is not asserted
 * on - reimplementing that algorithm is how a suite ends up reporting a name the platform does not
 * compute. axe is the authority on naming, and this suite reports enough for a reader to identify a
 * control by eye.
 */
async function readControls(page: Page): Promise<{
  rendered: readonly ControlReading[];
  notRendered: readonly { role: string; accessibleName: string; width: number; height: number }[];
}> {
  return page.evaluate(
    (minimum) => {
      const selector =
        'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="radio"], [tabindex]';
      const controls = [...document.querySelectorAll<HTMLElement>(selector)];
      const nameOf = (element: HTMLElement): string => {
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel !== null && ariaLabel.trim().length > 0) return ariaLabel;
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy !== null) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ');
          if (text.trim().length > 0) return text;
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
          const labels = [...(element.labels ?? [])].map((label) => label.textContent ?? '');
          const fromLabels = labels.join(' ').replace(/\s+/g, ' ').trim();
          if (fromLabels.length > 0) return fromLabels;
        }
        return ((element.innerText ?? '') + ' ' + (element.textContent ?? ''))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80);
      };
      const describe = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return {
          role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
          accessibleName: nameOf(element),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          reachableByKeyboard: element.tabIndex >= 0,
          touchTargetMet: rect.width >= minimum && rect.height >= minimum,
        };
      };
      const rendered = [];
      const notRendered = [];
      for (const element of controls) {
        const reading = describe(element);
        // `offsetParent` is null for a `display:none` subtree and non-null for a laid-out element,
        // which is the platform's own answer to "is this rendered" and needs no layout arithmetic.
        if (element.offsetParent === null || reading.width === 0 || reading.height === 0) {
          notRendered.push({
            role: reading.role,
            accessibleName: reading.accessibleName,
            width: reading.width,
            height: reading.height,
          });
          continue;
        }
        rendered.push({ ...reading, activatedWithKeyboard: false });
      }
      return { rendered, notRendered };
    },
    A11Y_MINIMUM_TOUCH_TARGET_PX,
  );
}

/**
 * Drive one named control with the keyboard and assert that the **product** changed.
 *
 * Activation is checked against a real state change rather than against "a key was sent". A press
 * that a control ignores, or that lands on nothing, is indistinguishable from a press that worked
 * if the only evidence is that the key was dispatched - and that is the failure the Phase 9 record
 * found in a different form, where a synthetic emitter call never entered the engine's event system.
 */
async function activateWithKeyboard(
  page: Page,
  tabName: string,
): Promise<{ before: string | null; after: string | null }> {
  const tabs = page.getByRole('tablist', { name: 'Welcome screen sections' });
  const tab = tabs.getByRole('tab', { name: tabName });
  await tab.waitFor({ state: 'visible', timeout: 15_000 });
  await tab.focus();
  await page.keyboard.press('Enter');
  await expect(tab, `the keyboard did not activate the "${tabName}" tab`).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 15_000 },
  );
  return {
    before: null,
    after: await tab.getAttribute('aria-selected'),
  };
}

/**
 * Every test that scans one declared surface, registered as it is defined.
 *
 * The registry is what lets `scripts/run-a11y-audit.mjs` compute **per-cell surface coverage** from
 * the JSON report it already reads: a test title beginning `"<surface id>: "` claims that surface, and
 * a cell with no passing test claiming a surface did not scan it. Before this, the runner printed a
 * single flat `surfaces scanned: welcome, village, settings` line above six cells, and every cell read
 * as having scanned all three - which is exactly how a partial matrix reads as a complete one.
 *
 * Registration happens while the file is being collected, so the registry is complete before the first
 * test runs and the self-check below does not depend on ordering.
 */
const surfaceTests: { readonly surface: A11ySurfaceId; readonly title: string }[] = [];

function surfaceTest(
  surface: A11ySurfaceId,
  title: string,
  body: (fixtures: { page: Page; browserName: string }, testInfo: TestInfo) => Promise<void>,
): void {
  const fullTitle = `${surface}${A11Y_SURFACE_TITLE_SEPARATOR}${title}`;
  surfaceTests.push({ surface, title: fullTitle });
  test(fullTitle, body);
}

test.describe('the Phase 21 automated accessibility suite', () => {
  test('the scanned surfaces are exactly the ones this suite declares', () => {
    // A self-check, and the first test so it cannot be the thing that fails last and be missed.
    // The list is read from the declaration the runner reports from, so a surface added to the
    // declaration without a scan here is visible in the log rather than only in a diff.
    expect(A11Y_SCANNED_SURFACES.map((surface) => surface.id)).toEqual(['welcome', 'village', 'settings']);
  });

  test('every declared surface has a scanning test, and every scanning test names its surface', () => {
    /*
     * The self-check for the mechanism the runner's per-cell coverage reads.
     *
     * Two directions, because the failure that matters is the one a reader cannot see: a declared
     * surface with no scanning test would leave that cell silently uncovered, and a scanning test
     * whose title lost its prefix would drop its cell out of the coverage block while the scan itself
     * went on passing. The registry is asserted against the declaration in both directions.
     */
    expect(surfaceTests.length, 'no scanning test declared a surface, so per-cell coverage is unreachable').toBeGreaterThanOrEqual(
      A11Y_SCANNED_SURFACES.length,
    );
    expect([...new Set(surfaceTests.map((entry) => entry.surface))].sort()).toEqual(
      A11Y_SCANNED_SURFACES.map((surface) => surface.id).sort(),
    );
    for (const entry of surfaceTests) {
      expect(a11ySurfaceFromTestTitle(entry.title), `"${entry.title}" is not resolvable to a declared surface`).toBe(
        entry.surface,
      );
    }
  });

  surfaceTest('welcome', 'introduces no new serious or critical automated accessibility violation', async (
    { page },
    testInfo,
  ) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
    ).toBeVisible({ timeout: 30_000 });
    await settle(page);
    const counts = await assertNoNewBlockingViolations(page, 'welcome', testInfo);
    assertAnalysisRan('welcome', counts);
    // And the surface under test is the entry route, stated positively. This assertion replaced one
    // that read `data-world` off `document.body`: that attribute exists only on the village screen
    // root and is never set on `body`, so the probe **could not pass on any cell** - an
    // expected-red dressed as a finding, which is worse than no probe at all because it looks like
    // evidence. The heading wait above is what establishes the entry route, and `assertAnalysisRan`
    // is what establishes that the scan saw a rendered document.
  });

  surfaceTest('village', 'introduces no new serious or critical automated accessibility violation', async (
    { page },
    testInfo,
  ) => {
    const hud = await openVillage(page);
    await testInfo.attach('village-hud-shape.json', {
      body: JSON.stringify({ surface: 'village', hudDrawerOpened: hud.drawerOpened }, null, 2),
      contentType: 'application/json',
    });
    const counts = await assertNoNewBlockingViolations(page, 'village', testInfo);
    assertAnalysisRan('village', counts);
  });

  surfaceTest(
    'settings',
    'introduces no new violation, and Escape closes it and restores focus',
    async ({ page }, testInfo) => {
      await openVillage(page);
      const settings = page.getByRole('button', { name: 'Settings' }).first();
      await settings.waitFor({ state: 'visible', timeout: 30_000 });
      await settings.click();
      /*
       * By accessible name, not by role alone.
       *
       * `getByRole('dialog')` on a touch cell does **not** resolve to this test's dialog. The HUD
       * bottom sheet is itself `role="dialog"` with `aria-label="Village status and controls"`, and
       * on `tablet` and `tablet-landscape` it is mounted *before* Settings, so it is DOM index 0.
       * `.first()` therefore named the drawer, and `toHaveCount(0)` on it asserted that **no dialog
       * at all** remained - a claim this test has no standing to make, about a surface it never
       * opened.
       *
       * That locator was also green for the wrong reason before `useModalFocus` became a stack: one
       * Escape closed the drawer *and* Settings, so "no dialog remains" happened to hold, and the
       * real defect surfaced one assertion later as a focus-restoration failure. After the fix the
       * drawer correctly survives and the count is 1, so the over-broad assertion went red on a
       * correct product. Naming the dialog is what makes this assertion say what it means: Escape
       * dismissed **this** dialog, and nothing about what it was stacked on top of.
       *
       * Measured, not assumed - on `tablet` with Settings open the document holds
       * `["Village status and controls", "Settings"]` in that order, and after Escape it holds
       * `["Village status and controls"]` with focus on the Settings launcher. `getByRole('dialog')`
       * goes 2 -> 1 and its `.first()` never moves off the drawer; `getByRole('dialog',
       * { name: 'Settings' })` goes 1 -> 0 on every cell, touch and non-touch alike.
       */
      const dialog = page.getByRole('dialog', { name: 'Settings' });
      await dialog.waitFor({ state: 'visible', timeout: 15_000 });
      await settle(page);
      const counts = await assertNoNewBlockingViolations(page, 'settings', testInfo);
      assertAnalysisRan('settings', counts);

      // Escape closes it, and focus returns to the control that opened it. Both halves, because a
      // dialog that closes on Escape and drops focus into the document body is the defect plan
      // section 10.1's focus-restoration requirement is about, and a scan cannot see either half.
      //
      // The count is 0 **for this dialog**. Whether the surface it was stacked on top of survives
      // is the product's business - one Escape dismisses one scope, and `useModalFocus`'s stack is
      // what decides that - and it is deliberately not asserted here, because this test never opened
      // the drawer and a failure in the composition around it is a different finding that this
      // assertion must not absorb. See the locator note above.
      await page.keyboard.press('Escape');
      await expect(dialog, 'Escape did not close the Settings dialog').toHaveCount(0, { timeout: 15_000 });
      // What focus actually landed on is reported, because "focus was not restored" on its own sends
      // a reader looking for a bug *inside* the dialog when the interesting cases are all outside
      // it: a launcher that unmounted with the surface beneath it, a focus trap that pulled focus
      // back into itself, or a scope behind the dialog that claimed the key first. Naming the
      // element focus is actually on turns each of those into a finding a reader can act on.
      const afterEscape = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return { tag: 'none', name: '', insideDialog: false };
        return {
          tag: active.tagName.toLowerCase(),
          name:
            active.getAttribute('aria-label') ?? (active.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
          insideDialog: active.closest('[role="dialog"]') !== null,
        };
      });
      const restored =
        afterEscape.name === 'Settings' ||
        (await page.evaluate(
          (label) =>
            document.activeElement?.getAttribute('aria-label') === label ||
            document.activeElement?.textContent?.trim() === label,
          'Settings',
        ));
      expect(
        restored,
        'focus was not restored to the control that opened the Settings dialog; after Escape it is on ' +
          `<${afterEscape.tag}> "${afterEscape.name}"${afterEscape.insideDialog ? ', still inside a dialog' : ''}`,
      ).toBe(true);
    },
  );

  test('every control on the entry route is keyboard reachable and meets the touch-target floor', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
    ).toBeVisible({ timeout: 30_000 });
    await settle(page);

    const { rendered, notRendered } = await readControls(page);
    await testInfo.attach('welcome-controls.json', {
      body: JSON.stringify(
        {
          surface: 'welcome',
          renderedControlCount: rendered.length,
          notRenderedControlCount: notRendered.length,
          rendered,
          notRendered,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });

    // Non-vacuity, in the order the rest of the assertions depend on it: a sweep that found no
    // controls would report "nothing is unreachable" and "nothing is too small", which is the shape
    // of a gate that passes because it measured nothing.
    expect(
      rendered.length,
      'the entry route rendered no measurable controls, so the reachability and touch-target ' +
        'assertions below measured nothing',
    ).toBeGreaterThan(5);

    const unreachable = rendered
      .filter((reading) => !reading.reachableByKeyboard)
      .map((reading) => `${reading.role} "${reading.accessibleName}"`);
    expect(
      unreachable,
      'rendered controls on the entry route that cannot receive keyboard focus',
    ).toEqual([]);

    const tooSmall = rendered
      .filter((reading) => !reading.touchTargetMet)
      .map(
        (reading) =>
          `${reading.role} "${reading.accessibleName}" is ${reading.width}x${reading.height} CSS pixels`,
      );
    expect(
      tooSmall,
      `rendered controls below the plan section 10.1 floor of ${A11Y_MINIMUM_TOUCH_TARGET_PX} by ${A11Y_MINIMUM_TOUCH_TARGET_PX} CSS pixels`,
    ).toEqual([]);

    // The not-rendered set is **reported, not asserted on**, and its existence is asserted. Those
    // controls live in inactive tabpanels; a learner reaches them by selecting their tab, and this
    // cell cannot measure them, so reporting the count is the honest statement. A sweep that
    // silently dropped them would under-report the surface it covered.
    expect(
      notRendered.length,
      'the entry route has no controls in inactive tabpanels, so the reported notRendered count is ' +
        'stale and the surface this cell covered is larger than the readings above',
    ).toBeGreaterThan(0);
  });

  test('a keyboard activates a section tab, and the panel it selected is the one that renders', async ({
    page,
  }) => {
    // The keyboard half, checked against a real state change. "A key was dispatched" would be
    // satisfied by a control that ignores it, and that is the Phase 9 failure in a different form:
    // a synthetic call that never entered the event system.
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
    ).toBeVisible({ timeout: 30_000 });
    await settle(page);

    const selectedBefore = await page
      .getByRole('tablist', { name: 'Welcome screen sections' })
      .getByRole('tab', { selected: true })
      .innerText();
    expect(selectedBefore.trim(), 'the entry route did not open on the Create / Load panel').toBe(
      'Create / Load',
    );

    await activateWithKeyboard(page, 'Guide');
    // And the panel actually swapped, which is the observable a learner would use. A tab that sets
    // `aria-selected` without changing the panel is a real defect, and this is where it shows.
    await expect(
      page.getByRole('tab', { name: 'Guide' }),
    ).toHaveAttribute('aria-selected', 'true');

    /*
     * By panel name, in both directions, rather than `getByRole('tabpanel')` at count 1.
     *
     * Measured on the built artifact: the role-only count is **1 before the swap and 1 after it**.
     * The three inactive panels carry `hidden`, so they leave the accessibility tree and exactly one
     * `tabpanel` is exposed either way - which means that assertion was **green whether or not the
     * view swapped**, and green is all it could ever be. It read like evidence about the swap and
     * measured nothing about it. This is the same defect as the Settings dialog locator in the
     * opposite direction: there, a role shared with another surface made a correct product look
     * broken; here, a role alone made a broken product look correct.
     *
     * The two named assertions change across the interaction - `Guide` goes 0 -> 1 and
     * `Create or load subject` goes 1 -> 0 - so each can fail, and together they cover strictly more
     * than "one panel is exposed": a tab that swapped to nothing fails the first, a tab that
     * revealed both panels fails the second, and only a real swap passes both.
     */
    await expect(
      page.getByRole('tabpanel', { name: 'Guide' }),
      'the Guide tabpanel is not the rendered panel, so the tab set aria-selected without swapping the view',
    ).toHaveCount(1);
    await expect(
      page.getByRole('tabpanel', { name: 'Create or load subject' }),
      'the Create / Load tabpanel is still rendered alongside the Guide panel, so the tab revealed both',
    ).toHaveCount(0);
  });

  test('a touch-emulated cell activates a control with a tap, and not with a hover', async ({
    page,
    browserName,
  }) => {
    // The tap half is skipped when the cell has no emulated touch, and the skip is **stated**
    // rather than silent: `test.skip()` carries the condition in its message and in the run's
    // reported count, so a report that says "tap check passed" for a keyboard-only cell is not
    // possible - the run's counts say the test did not run.
    const touch = await hasEmulatedTouch(page);
    test.skip(
      !touch,
      `${browserName} cell has no emulated touch, so there is nothing for a tap to reach. ` +
        'Emulated touch is form-factor evidence, never physical-device evidence.',
    );

    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }),
    ).toBeVisible({ timeout: 30_000 });
    await settle(page);

    /*
     * A tab, and only a tab.
     *
     * Deliberately not a nearby-action row in the village: this is a check that **touch activation
     * works at all** on this cell, and a tab publishes `aria-selected`, which is a state a test can
     * read. A nearby row's effect is "something changed somewhere", which is exactly the kind of
     * assertion that passes whether or not the tap landed - and this suite's first draft had one.
     */
    const tabs = page.getByRole('tablist', { name: 'Welcome screen sections' });
    const target = tabs.getByRole('tab', { name: 'Player Setup' });
    await target.waitFor({ state: 'visible', timeout: 15_000 });

    // No hover, no mouse, no pointer scroll: `tap()` alone.
    await target.tap({ timeout: 15_000 });
    await expect(
      target,
      'a tap did not activate the section tab, so touch use depends on something a tap does not do',
    ).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  });
});
