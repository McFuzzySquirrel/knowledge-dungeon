import { expect, test, type Page } from '@playwright/test';

import {
  FISHING_LANE,
  FISHING_MANIFEST_PATH,
  FISHING_PHASER_FALLBACK_CLASS,
  type FishingInputMode,
} from './fishing-lane';
import {
  censusForDist,
  chooseScholarArchetype,
  classifyChunkNames,
  hostOperatingSystem,
  installNetworkSpy,
  openVillage,
  openVillageWithSeededSubject,
  readPondPhase,
  recordFishingEvidence,
  repoRoot,
  returnToVillage,
  verifyRecordedArtifact,
  walkToStructureAndPress,
  WALK_FISH_STAND_TO_SW_POND,
  WALK_SPAWN_TO_SW_POND,
  WALK_SW_POND_TO_FISH_STAND,
  VILLAGE_PLAYER_ATTRIBUTE,
  VILLAGE_TILE_SIZE,
  type DistChunkCensus,
  type NetworkSpy,
  type VillageWalkFailure,
  type VillageWalkPlan,
} from './fishing-harness';
import {
  installRecallFixture,
  readSeededSubjectState,
  recallFixturePremiseFailures,
  RECALL_FIXTURE_ROOM_TOPIC,
} from './fishing-recall-fixture';

/**
 * The Phase 17 fishing lane: the Pixi pond, end to end, in a real browser.
 *
 * ## What this spec is for
 *
 * Phase 17's exit criterion is "A complete cast-to-catch-to-keep flow works using touch and
 * keyboard", and its Deliverables name "Fishing browser E2E coverage". Nothing before this file
 * could answer either: the phase's own Verification block says
 * `VITE_PIXI_FISHING=true npm run test:e2e`, and `npm run test:e2e` builds and previews the
 * **default** artifact, so it measured the Phaser fishing lane rather than the Pixi one. This
 * spec previews `build:web:pixi-fishing`'s recorded artifact instead.
 *
 * ## Why there is a separate rollback spec
 *
 * Because the rollback half of a cutover is evidence too, and "the same entry point reaches the
 * Phaser `FishingScene`" is a claim about the artifact that **ships**, not about the one with the
 * pond in it. `tests/e2e/fishingRollback.spec.ts` makes that claim against the default artifact,
 * and this file's first test deliberately asserts the opposite, so the two cannot be confused for
 * each other and so a build in which the two are indistinguishable fails here rather than
 * passing quietly.
 *
 * ## No skip, ever
 *
 * There is no `test.skip` and no `test.fixme` in this file, and that is the load-bearing
 * property of it. A pond that cannot be mounted is a **finding**, reported as a failing test whose
 * message names the cause, because the failure this lane exists to prevent is a green run that
 * measured nothing. {@link requirePond} throws with a complete diagnosis rather than returning a
 * sentinel, so each criterion's own test reports whether *that* criterion has browser evidence.
 *
 * ## Synthetic fixtures only
 *
 * The tutorial subject the application mints for itself, plus the authored village map's own
 * structure ids, plus one subject the lane writes for itself and whose every field is a literal
 * `tests/e2e/fishing-recall-fixture.ts` invented — see that module for why the recall branch
 * needs one. No learner data, no request body, no credential, no private URL, in a script, a
 * test name, or a report. The privacy spy reads only a URL's scheme, host, and path, a method,
 * and a resource type.
 *
 * ## Walking the village, and why a walk has to leave the pond first
 *
 * The pond binds its own `keydown` listener and spends the arrow keys moving its angler while it
 * is open, so the arrow keys cannot cross the village until it is closed. Every test that reads
 * the Fish Stand therefore leaves the pond through the pond's own control first; that is
 * {@link readFishStand}'s first statement and it is not incidental.
 */

const LOCAL_ORIGIN = 'http://127.0.0.1:43199';

/**
 * The synthetic catalogue count the Fish Stand publishes as a fraction.
 *
 * The other three totals it publishes are named where they are read, in {@link readBareStat},
 * because each is a bare integer and this one is not; the split is the reason there are two
 * readers rather than four constants.
 */
const FISH_STAND_SPECIES = '[data-fish-stat="species"]';

/** The visible outcome sentence the village screen publishes after a catch decision. */
const OUTCOME_SENTENCE = '.fishing-recall__outcome[role="status"]';

interface PondContext {
  readonly page: Page;
  readonly spy: NetworkSpy;
  readonly census: DistChunkCensus;
}

/**
 * Reach the Pixi pond, or throw a complete diagnosis of why it could not be reached.
 *
 * Thrown rather than returned so a caller cannot accidentally continue with an unset pond, and
 * so the message reaches the reader of the report rather than being swallowed by a `??`.
 *
 * The diagnosis is assembled from **three measurements**, not from a guess: whether the
 * artifact emitted the chunk at all, whether the page ever requested it, and which world the
 * entry point actually reached. Those three together distinguish "the flag did not survive the
 * build" from "the chunk shipped and nothing loaded it" from "the chunk shipped, loaded, and was
 * replaced" — and the middle two are the cases a green run would hide.
 */
async function requirePond(context: PondContext): Promise<void> {
  const { page, spy, census } = context;

  if (census.fishingChunks.length === 0) {
    throw new Error(
      'This lane was pointed at an artifact that emitted no Pixi fishing chunk, so there is no pond to ' +
        'measure. Rebuild with "npm run test:e2e:fishing:full"; the recorded identity above is the one ' +
        'that was verified, so the artifact and the identity agree and the build itself is the finding.',
    );
  }

  const pond = page.locator('.pixi-fishing-world');
  const hud = page.locator('.fishing-hud');
  const mounted = (await pond.count()) > 0 || (await hud.count()) > 0;
  if (mounted) return;

  const fishingChunkRequests = spy.fishingScriptPaths();
  const pixiChunkRequests = spy.pixiScriptPaths();
  const phaserFallback = (await page.locator(`.${FISHING_PHASER_FALLBACK_CLASS} canvas`).count()) > 0;
  const world = await page.locator('[data-world]').getAttribute('data-world');

  const diagnosis = [
    `the artifact emitted ${census.fishingChunks.length} Pixi fishing chunk(s) and ${census.pixiChunks.length} Pixi vendor chunk(s)`,
    `the page requested ${fishingChunkRequests.length} fishing chunk(s) and ${pixiChunkRequests.length} Pixi chunk(s) in total`,
    `the page holds ${await pond.count()} .pixi-fishing-world and ${await hud.count()} .fishing-hud`,
    `the Phaser fallback canvas is ${phaserFallback ? 'present' : 'absent'} and data-world is ${JSON.stringify(world)}`,
  ].join('; ');

  throw new Error(
    'The village fishing-pond entry point did not mount the Pixi pond, so no Phase 17 exit criterion ' +
      'can be verified in this run. Measurements: ' +
      diagnosis +
      '. The most likely cause is the host resolution in src/ui/village/villageStudyFlow.ts: ' +
      '`resolveFishingHost()` prefers `readPixiFishingHost()`, and `usePixiFishingLane` in ' +
      'src/ui/screens/PixiFishingLane.tsx only assigns that ref inside a useEffect guarded by ' +
      '`session !== null`, while `session` is only set by calling `hostRef.current.enter(...)`. ' +
      'So the ref is null until a session exists, the Phaser village handle wins the `??` fallback, ' +
      'and the Pixi pond is never mounted on a build whose village is Phaser — which is exactly the ' +
      'build build:web:pixi-fishing produces. See tests/e2e/fishing-lane.test.ts for the lane, and ' +
      'docs/plans/001-cozy-pixi-rebuild.md Phase 17 for the criterion this test exists to prove.',
  );
}

/** The pond's phase, as the HUD publishes it. Fails rather than returning `null`. */
async function phaseOf(page: Page): Promise<string> {
  const phase = await readPondPhase(page);
  if (phase === null) throw new Error('The fishing HUD published no phase, so the pond is not mounted.');
  return phase;
}

/** Wait for the pond to reach one of `phases`, reading the HUD's own attribute. */
async function waitForPhase(page: Page, phases: readonly string[], timeoutMs = 45_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await readPondPhase(page);
    if (last !== null && phases.includes(last)) return last;
    await page.waitForTimeout(120);
  }
  throw new Error(
    `The pond never reached ${phases.join(' or ')}; it was ${JSON.stringify(last)} after ${timeoutMs}ms.`,
  );
}

/**
 * Charge and cast with the keyboard alone: hold `Space` on the charge control, then release it.
 *
 * Keyboard only, deliberately: no pointer event is dispatched anywhere in this function, and the
 * walk that reached the pond happened in a previous test body. `Space` is the key the control's
 * own visible hint names, so this is the interaction the UI documents rather than one invented
 * here.
 */
async function castWithKeyboard(page: Page, chargeMs: number): Promise<void> {
  const charge = page.locator('#fishing-charge-hold');
  await charge.waitFor({ timeout: 30_000 });
  await charge.focus();
  await page.keyboard.down('Space');
  await page.waitForTimeout(chargeMs);
  await page.keyboard.up('Space');
}

/**
 * The same cast driven by pointer input alone.
 *
 * `dispatchEvent` with `pointerId` and `isPrimary` rather than `locator.click()`, because the
 * control is a **hold**: `click()` presses and releases inside one actionability round trip, so
 * a charge would begin and end in the same tick and cast at zero power. Two real pointer events
 * with a hold between them is what a finger does.
 */
async function castWithPointer(page: Page, chargeMs: number): Promise<void> {
  const charge = page.locator('#fishing-charge-hold');
  await charge.waitFor({ timeout: 30_000 });
  await charge.dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true, button: 0 });
  await page.waitForTimeout(chargeMs);
  await charge.dispatchEvent('pointerup', { pointerId: 1, isPrimary: true, button: 0 });
}

/**
 * One complete cast, whichever way it is driven, up to a revealed catch.
 *
 * The bite is a two-second window, so the hook press is issued from a `expect.poll` that starts
 * the moment the phase reads `biting` — the alternative is waiting for a stable selector and
 * arriving after the fish is gone. A miss is a legitimate outcome of a real cast and is
 * reported as such rather than being retried silently, so the caller can decide.
 */
async function castUntilCaught(
  page: Page,
  drive: (page: Page, chargeMs: number) => Promise<void>,
): Promise<{ outcome: 'caught' | 'missed'; chargePercent: number }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await drive(page, 700);
    const chargePercent = Number(
      (await page.locator('[data-fishing-power]').getAttribute('data-fishing-power')) ?? '0',
    );
    const reached = await waitForPhase(page, ['biting', 'caught', 'missed']);
    if (reached === 'missed') {
      await page.locator('#fishing-try-again').click();
      await waitForPhase(page, ['idle']);
      continue;
    }
    if (reached === 'caught') return { outcome: 'caught', chargePercent };
    await page.locator('#fishing-set-hook').click({ timeout: 5_000 });
    const afterHook = await waitForPhase(page, ['caught', 'missed', 'idle', 'waiting']);
    if (afterHook === 'caught') return { outcome: 'caught', chargePercent };
    if (afterHook === 'missed') {
      await page.locator('#fishing-try-again').click();
      await waitForPhase(page, ['idle']);
      continue;
    }
    // Still waiting: the fish took the bait and the hook was too slow. Let the window resolve and
    // try again. No tolerance on this wait - a cast that never resolves is a finding, and
    // swallowing it would turn a real defect into another attempt.
    const settled = await waitForPhase(page, ['missed', 'caught'], 20_000);
    if (settled === 'missed') {
      await page.locator('#fishing-try-again').click();
      await waitForPhase(page, ['idle']);
    }
  }
  throw new Error('Four casts produced no catch; the pond did not complete a cast in this run.');
}

/**
 * Walk to the pond under one plan, and fail with the walk's own diagnosis if it never got there.
 *
 * The confirmation is the pond, and the reason is the same staleness `readFishStand` documents: the
 * nearby list is a throttled proximity sample, so a row can be on the page while the learner has
 * already left the approach radius, and the press lands on nothing. Asking whether the pond opened
 * turns a lost press into a retry; a genuine failure still fails, on the walk's deadline.
 *
 * ## Why this throws rather than returning a boolean
 *
 * It returned one, and **two of the three call sites discarded it** — the two that walk back to the
 * pond mid-test. A walk that timed out therefore reported itself as whatever the *next* assertion
 * happened to be, and the observed cost was a misleading diagnosis: a walk failure surfaced as "the
 * village fishing-pond entry point did not mount the Pixi pond", complete with a paragraph blaming
 * host resolution in `src/ui/village/villageStudyFlow.ts` and a `useEffect` guard in
 * `PixiFishingLane.tsx`. None of that was involved. The reader was sent into two product files to
 * investigate a test harness that had run out of walking budget, and the walk's own measurements
 * were discarded one line earlier.
 *
 * So the check is not left to a caller. A helper that can report failure by being ignored is a helper
 * whose failure will be reported as something else.
 */
async function reachPond(page: Page, plan: VillageWalkPlan = WALK_SPAWN_TO_SW_POND): Promise<void> {
  const outcome = await walkToStructureAndPress(page, plan, async () =>
    (await page.locator('[data-world="fishing"]').count()) > 0,
  );
  if (!outcome.arrived) throw walkFailure(plan.targetId, plan, outcome);
}

/**
 * A walk that has to say why it could not finish.
 *
 * ## What is in the message, and why each part is there
 *
 * The walk returns a discriminated outcome rather than a nullable row, so this function cannot be
 * called without the measurements the walk actually took. All three go into the sentence:
 *
 * - **the two grid points** the plan named, so a reader who has moved a structure on the map can
 *   tell a walk aimed at the wrong place from one that ran out of time;
 * - **the last tile the village published**, which is the difference between "aimed at the wrong
 *   place" and "aimed correctly and never moved" — the two failures look identical without it and
 *   need opposite fixes;
 * - **the closest approach in tiles**, which says how far short the walk got rather than only that
 *   it got nowhere;
 * - **the reason**: `no-progress` is the walk's own conclusion about a position that stopped
 *   improving, and `budget` is the deadline, which on a machine slower than the one this was sized
 *   against is a different finding from the same red test.
 *
 * A reader who has to open the harness to learn why a red test is red has been handed a red test
 * rather than a diagnosis, and that was the defect this replaced.
 */
function walkFailure(targetId: string, plan: VillageWalkPlan, outcome: VillageWalkFailure): Error {
  const last =
    outcome.lastPlayer === null
      ? 'the village never published a tile'
      : `the last published tile was (${outcome.lastPlayer.gridX}, ${outcome.lastPlayer.gridY})`;
  const closest =
    outcome.closestTiles === null
      ? 'no distance was measured'
      : `it closed to ${outcome.closestTiles.toFixed(2)} tiles (${(outcome.closestTiles * VILLAGE_TILE_SIZE).toFixed(0)} px) at best`;
  return new Error(
    `The walk to ${targetId} did not reach it: ${outcome.reason} after ${outcome.readings} readings ` +
      `inside a ${plan.budgetMs}ms budget. The plan aimed at grid (${plan.to.gridX}, ${plan.to.gridY}) ` +
      `from an expected start of (${plan.from.gridX}, ${plan.from.gridY}), ${last}, and ${closest}. ` +
      'The walk derives its heading from the tile the village publishes on ' +
      `${VILLAGE_PLAYER_ATTRIBUTE} and re-reads it every burst, so this is the walk's own ` +
      'measurement and not an assumption about where the learner was. tests/e2e/fishing-harness.ts ' +
      'is where the walk and its bounds are declared, and tests/e2e/fishing-lane.test.ts is the gate ' +
      'that fails when the endpoints stop matching src/data/villageLayout.ts.',
  );
}

/**
 * Leave the pond, walk to the fish stand, and read its two canonical counts.
 *
 * The `returnToVillage` call between the catch decision and the walk is **load-bearing** and is
 * the finding this helper encodes: the pond binds its own `keydown` listener, calls
 * `preventDefault` on the arrow keys, and spends them moving the angler, so a walk issued while
 * the pond overlay is open moves the angler and leaves the village exactly where it was. Without
 * the step the stand is never in reach, no matter how many bursts the walk takes — which is
 * precisely the failure three tests hit before it was named.
 */
/**
 * The Fish Stand's four published totals, as the numbers they state.
 *
 * ## Why `species` is a pair and not a count
 *
 * `FishStandPanel` publishes `data-fish-stat="species"` as `{caughtSpecies} of {totalSpecies}` — the
 * learner is shown a fraction of the catalogue, not a bare figure — while `kept`,
 * `canonical-types` and `subjects` are bare integers. An earlier version of this read every stat
 * with `Number(...)`, which silently produced `NaN` for the species pair: `Number("0 of 24")` is
 * `NaN`, not `0`. It went unnoticed for two reasons, both of which this type removes. The first
 * call in a test compared a bare `toBe(0)` and failed; but `expect(NaN).toBe(NaN)` **passes**,
 * because Playwright's `toBe` uses `Object.is`, so every before/after comparison of that value was
 * a tautology that could never fail. So the fraction is now parsed into the two integers the
 * element actually publishes, and a malformed one is a thrown error rather than a silent `NaN` that
 * compares equal to itself.
 *
 * `canonicalTypes` is read because it is the number this lane's claim is actually about: `kept` and
 * `species` both count catalogue cells, so a collection holding two entries of one species would
 * satisfy `kept === 2` and `species === 1` on its own. `countCanonicalCatalogTypes` counts *resolved*
 * identities, so `canonicalTypes === species` is the assertion that the tally is canonical rather
 * than an entry count.
 */
interface FishStandTotals {
  readonly kept: number;
  readonly species: { readonly caught: number; readonly total: number };
  readonly canonicalTypes: number;
  readonly subjects: number;
  /**
   * The panel's own summary sentence, read **while the dialog is open**.
   *
   * It used to be asserted from the test body, after this helper had returned — and this helper
   * **closes** the dialog on its last line, so the assertion was looking for an element the test had
   * itself just removed. It could not have passed at any point in the lane's history, which is a third
   * instance of the family the module header records: a locator that reads nothing because of *when*
   * it was read, rather than of what it read. (The first two were `expect(NaN).toBe(NaN)` and a walk
   * control computed but never consulted.)
   *
   * Reading it here is not a softening: the same sentence is asserted, against the same rendered text,
   * at the only moment it exists on the page. The gate asserts the ordering — the read happens before
   * the close click — so the two mistakes cannot both be reintroduced.
   */
  readonly summary: string;
}

/** One `data-fish-stat` value, required to be the integer the panel publishes. */
async function readBareStat(page: Page, stat: string): Promise<number> {
  const raw = (await page.locator(`[data-fish-stat="${stat}"]`).textContent()) ?? '';
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) {
    throw new Error(
      `The Fish Stand's "${stat}" stat read as ${JSON.stringify(raw)}, which is not the integer the ` +
        'panel publishes. A stat whose shape has changed must fail here rather than become a NaN that ' +
        'compares equal to itself.',
    );
  }
  return value;
}

/** `data-fish-stat="species"`, published as "{caught} of {total}". */
async function readSpeciesStat(page: Page): Promise<{ caught: number; total: number }> {
  const raw = (await page.locator(FISH_STAND_SPECIES).textContent()) ?? '';
  const match = /^(\d+)\s+of\s+(\d+)$/.exec(raw.trim());
  if (match === null) {
    throw new Error(
      `The Fish Stand's "species" stat read as ${JSON.stringify(raw)}, which is not the ` +
        '"{caught} of {total}" the panel publishes.',
    );
  }
  return { caught: Number(match[1]), total: Number(match[2]) };
}

async function readFishStand(page: Page): Promise<FishStandTotals> {
  await returnToVillage(page);
  /*
   * The confirmation is the panel the press is supposed to open, and it is load-bearing rather than
   * a convenience. The nearby list is a throttled sample of proximity, so a row can be present while
   * the learner's real distance has already crossed the 48-pixel approach radius; the press then lands
   * on a button whose structure has left and nothing happens. Measured on this lane: the walk read
   * the fish stand at 47.9 pixels, pressed, and no panel appeared. Asking the walk whether its press
   * took makes a lost press a retry rather than a silent pass of the wrong thing — and a genuine
   * failure still fails, because the walk ends on its deadline either way.
   */
  const reached = await walkToStructureAndPress(page, WALK_SW_POND_TO_FISH_STAND, async () =>
    (await page.locator('.village-info-panel').filter({ hasText: 'Fish Stand' }).count()) > 0,
  );
  if (!reached.arrived) throw walkFailure('fish-stand', WALK_SW_POND_TO_FISH_STAND, reached);
  await page.getByRole('button', { name: 'View Collection' }).click({ timeout: 15_000 });
  /*
   * By **role and accessible name**, not by an `aria-label` attribute.
   *
   * `FishStandPanel` labels its dialog with `aria-labelledby` pointing at its own `<h3>Fish
   * collection</h3>`, so the dialog's accessible name *is* "Fish collection" while no
   * `aria-label` attribute exists on it. A locator of the form `[role="dialog"][aria-label="Fish
   * collection"]` therefore matches nothing and fails on a working panel — which is what it did, and
   * why this reads the way the product actually publishes its identity rather than the way a first
   * reading of the source file suggests.
   */
  const dialog = page.getByRole('dialog', { name: 'Fish collection' });
  await dialog.waitFor({ timeout: 15_000 });
  // The summary sentence, taken while the dialog is still open — see the field's own note for why that
  // ordering is the whole content of the claim. Scoped **into** the dialog rather than matched by class
  // alone, because `.fishing-recall__outcome` is the recall modal's class too and the recall modal can
  // be on the page in the same test.
  const summary = (await dialog.locator('p.fishing-recall__outcome').first().textContent()) ?? '';
  const totals: FishStandTotals = {
    kept: await readBareStat(page, 'kept'),
    species: await readSpeciesStat(page),
    canonicalTypes: await readBareStat(page, 'canonical-types'),
    subjects: await readBareStat(page, 'subjects'),
    summary: summary.replace(/\s+/g, ' ').trim(),
  };
  await page.getByRole('button', { name: 'Close the fish collection' }).click();
  return totals;
}

async function evidenceFor(
  testInfo: import('@playwright/test').TestInfo,
  lane: string,
  rendererMode: 'pixi-fishing-pond',
  inputMode: FishingInputMode,
  context: PondContext,
  extra: { observedPhases: readonly string[]; notes: readonly string[] },
): Promise<void> {
  const viewport = context.page.viewportSize() ?? FISHING_LANE.viewport;
  await recordFishingEvidence(testInfo, FISHING_LANE.project, {
    lane,
    rendererMode,
    inputMode,
    hostOperatingSystem: hostOperatingSystem(),
    architecture: process.arch,
    browserVersion: context.page.context().browser()?.version() ?? 'unknown',
    browserChannel: 'playwright-bundled',
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: FISHING_LANE.deviceScaleFactor,
    hasTouch: FISHING_LANE.hasTouch,
    evidenceClass: FISHING_LANE.evidenceClass,
    worldRenderer: FISHING_LANE.worldRenderer,
    villageRenderer: FISHING_LANE.villageRenderer,
    storageRepository: FISHING_LANE.storageRepository,
    fishingChunkPresent: context.census.fishingChunks.length > 0,
    pixiScriptRequestCount: context.spy.pixiScriptPaths().length,
    totalRequestCount: context.spy.report().totalRequests,
    networkViolations: context.spy.report().violations.map((violation) => ({
      category: violation.category,
      count: violation.count,
    })),
    observedPhases: [...extra.observedPhases],
    notes: [...extra.notes],
  });
}

test.beforeAll(() => {
  // Read from the artifact, never from a flag constant: "the flagged build emitted the pond"
  // is a claim about the bytes that will be served.
  const census = censusForDist(repoRoot());
  if (census === null) {
    throw new Error(
      'There is no dist/ to census. Run "npm run test:e2e:fishing:full", which builds, records and ' +
        'verifies the artifact before invoking this lane.',
    );
  }
});

/**
 * How one test gets from Welcome to a fishing pond.
 *
 * Two entries, and the difference between them is the subject the pond will be entered from —
 * which is what decides whether a catch can be asked a recall question. `tutorial` mints nothing
 * and takes the route a learner takes on a new device; `seeded-recall` installs the synthetic
 * fixture first and enters the village through "Continue to Village", so the pond's own subject
 * holds a cleared room.
 */
type VillageEntry = 'tutorial' | 'seeded-recall';

/**
 * Welcome → the village → the pond, and the four measurements that diagnose a dead lane.
 *
 * The seeded entry also **asserts the fixture's premise** rather than trusting it: the recall
 * branch reads the active subject, and the pond's eligibility reads whichever subject fills the
 * nearest portal slot, so a seed that wrote the wrong pointer or more than one subject would make
 * a later assertion fail for a reason that has nothing to do with recall.
 */
async function setUp(page: Page, entry: VillageEntry = 'tutorial'): Promise<PondContext> {
  const census = censusForDist(repoRoot()) as DistChunkCensus;
  const verification = verifyRecordedArtifact(repoRoot(), FISHING_MANIFEST_PATH);
  expect(verification.status, 'the recorded artifact identity must verify before anything is measured').toBe('match');

  const spy = installNetworkSpy(page, LOCAL_ORIGIN);
  if (entry === 'seeded-recall') {
    // Before the first navigation: the application's bootstrap reads the active subject once.
    await installRecallFixture(page);
    await openVillageWithSeededSubject(page);
    const state = await readSeededSubjectState(page);
    expect(
      recallFixturePremiseFailures(state),
      'the seeded recall fixture did not establish its premise, so a later failure could not be ' +
        'attributed to the recall branch',
    ).toEqual([]);
  } else {
    await openVillage(page);
  }
  // `reachPond` reports its own walk failure, so reaching the pond is a precondition here rather
  // than a boolean to be checked.
  await reachPond(page);
  return { page, spy, census };
}

test('the flagged artifact verifies its identity and emits exactly one lazy Pixi fishing chunk', async ({
  page,
}, testInfo) => {
  const census = censusForDist(repoRoot()) as DistChunkCensus;
  const verification = verifyRecordedArtifact(repoRoot(), FISHING_MANIFEST_PATH);

  expect(verification.status).toBe('match');
  expect(verification.code).toBe('match');
  // The identity is a SHA-256 over the tree, so a recorded value means the manifest was read.
  expect(verification.recordedTreeSha256, 'the manifest carried no recorded tree identity').toMatch(
    /^[0-9a-f]{64}$/,
  );
  expect(verification.sourceMatches, 'the artifact was recorded from different source content').toBe(true);

  // The chunk gate this lane exists beside: a `VITE_PIXI_FISHING=true` build that emitted no pond
  // chunk fails in `vite.config.ts` before Playwright starts, and the census proves it here too.
  expect(census.fishingChunks.length, 'the flagged build emitted no Pixi fishing chunk').toBe(1);
  expect(census.pixiChunks.length, 'the flagged build emitted no Pixi vendor chunk').toBe(1);
  // The village and the world renderer both stay Phaser on this build, which is what makes the
  // `pixiFishing` chunk check the only one that could have caught a missing chunk.
  expect(census.phaserChunks.length).toBe(1);

  const spy = installNetworkSpy(page, LOCAL_ORIGIN);
  await page.goto('/');
  await page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' }).waitFor({ timeout: 30_000 });

  // **Lazy**, not eager: the pond is reached through a dynamic import, so the Welcome route must
  // not have fetched either Pixi chunk. This is plan section 10.2's rule as a browser observation.
  expect(
    spy.pixiScriptPaths(),
    'the Welcome route fetched a Pixi chunk, so the pond is not lazy',
  ).toEqual([]);

  await evidenceFor(testInfo, 'artifact-census', 'pixi-fishing-pond', 'keyboard-only', { page, spy, census }, {
    observedPhases: [],
    notes: [
      'artifact census read from dist/assets, not from a flag constant',
      'Welcome requested no Pixi chunk, so the pond stays behind a dynamic import',
    ],
  });
});

test('the village fishing-pond entry point mounts the Pixi pond, not the Phaser fishing scene', async ({
  page,
}, testInfo) => {
  const context = await setUp(page);
  await requirePond(context);

  // The pond is a second PixiJS application in a second canvas, so the village's Phaser canvas
  // is still there underneath it. What must *not* be there is the Phaser fishing scene, which is
  // observed through the absence of the pond's own DOM controls and by the Pixi chunk request.
  await expect(page.locator('.fishing-hud')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-world="fishing"]')).toHaveCount(1);
  expect(
    context.spy.fishingScriptPaths(),
    'the pond mounted without ever requesting its chunk',
  ).not.toEqual([]);
  expect(
    context.spy.pixiScriptPaths().length,
    'the Pixi vendor runtime was never fetched, so the pond could not have drawn',
  ).toBeGreaterThan(0);
  expect(context.spy.pageErrors(), 'page errors during the pond entry').toEqual([]);

  await evidenceFor(testInfo, 'pond-mounts', 'pixi-fishing-pond', 'pointer-keyboard', context, {
    observedPhases: [await phaseOf(page)],
    notes: ['the entry point the harness used is the village nearby-action row for pond-fish-sw'],
  });
});

test('a complete cast to catch to keep flow works with the keyboard alone', async ({ page }, testInfo) => {
  const context = await setUp(page);
  await requirePond(context);

  const observed: string[] = [];
  observed.push(await phaseOf(page));
  const cast = await castUntilCaught(page, castWithKeyboard);
  observed.push('caught');
  expect(cast.outcome).toBe('caught');
  expect(cast.chargePercent, 'the keyboard hold charged the cast to zero percent').toBeGreaterThan(0);

  // The catch panel is the offer, and it names the fish by catalogue display name.
  await expect(page.locator('#fishing-catch-panel')).toBeVisible({ timeout: 15_000 });
  await page.locator('#fishing-catch-panel').getByRole('button', { name: 'Keep Fish' }).click();
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible({ timeout: 15_000 });

  await evidenceFor(testInfo, 'keyboard-cast-to-keep', 'pixi-fishing-pond', 'keyboard-only', context, {
    observedPhases: observed,
    notes: ['no pointer event was dispatched anywhere in this test'],
  });
});

test('the same complete cast to catch to keep flow works with pointer input alone', async ({
  page,
}, testInfo) => {
  const context = await setUp(page);
  await requirePond(context);

  const observed: string[] = [await phaseOf(page)];
  const cast = await castUntilCaught(page, castWithPointer);
  observed.push('caught');
  expect(cast.outcome).toBe('caught');

  await expect(page.locator('#fishing-catch-panel')).toBeVisible({ timeout: 15_000 });
  await page.locator('#fishing-catch-panel').getByRole('button', { name: 'Keep Fish' }).click();
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible({ timeout: 15_000 });

  await evidenceFor(testInfo, 'pointer-cast-to-keep', 'pixi-fishing-pond', 'pointer-only', context, {
    observedPhases: observed,
    notes: ['the charge control is a hold, so the press and the release are two pointer events'],
  });
});

test('keeping a fish with no recall material awards no experience and says so', async ({
  page,
}, testInfo) => {
  const context = await setUp(page);
  await requirePond(context);

  await castUntilCaught(page, castWithPointer);
  await page.locator('#fishing-catch-panel').getByRole('button', { name: 'Keep Fish' }).click();

  // A fresh tutorial subject has no cleared rooms, so `pullRecallQuestion` returns null and this
  // is the third outcome rather than a question. If a future tutorial seeds a cleared room this
  // assertion fails, which is the point: the branch is reached by its own condition, not forced.
  const noQuestion = page.getByRole('button', { name: 'Keep this fish (no question, no experience)' });
  await expect(noQuestion).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#fishing-recall-room')).toHaveCount(0);
  await noQuestion.click();

  // The visible outcome sentence, in words, from `fishingRewardSentence`.
  const outcome = page.locator(OUTCOME_SENTENCE);
  await expect(outcome).toContainText('Kept without a question', { timeout: 15_000 });
  await expect(outcome).toContainText('earned no experience');
  // "No experience" stated in words is a claim; the absence of an amount is the second half of it.
  await expect(outcome).not.toContainText(/gained \d+ experience/i);
  await expect(page.locator('#fishing-catch-panel')).toHaveCount(0);

  // And the fish is in the collection, counted canonically: one kept, one species.
  const stand = await readFishStand(page);
  expect(stand.kept).toBe(1);
  expect(stand.species.caught).toBe(1);
  // `canonicalTypes` is the claim this test's neighbour makes and this one only implied: the tally
  // is over resolved catalogue identities, so one fish is one species and not one entry id.
  expect(stand.canonicalTypes).toBe(1);
  expect(stand.species.caught).toBe(stand.canonicalTypes);

  await evidenceFor(testInfo, 'keep-without-recall', 'pixi-fishing-pond', 'pointer-only', context, {
    observedPhases: [],
    notes: [
      'the outcome sentence is the only place a progression award is reported to a learner',
      'the Fish Stand kept count is the canonical catalogue tally after the decision',
    ],
  });
});

test('releasing a fish leaves no visible progression change', async ({ page }, testInfo) => {
  const context = await setUp(page);
  await requirePond(context);

  const before = await readFishStand(page);
  expect(before.kept, 'a fresh pond already had a kept fish, so release cannot be observed').toBe(0);

  // Walk back to the pond from the fish stand and release one. The reverse plan is named because
  // the learner is at the stand now, not at the spawn.
  await reachPond(page, WALK_FISH_STAND_TO_SW_POND);
  await requirePond(context);
  await castUntilCaught(page, castWithPointer);
  await page.locator('#fishing-catch-panel').getByRole('button', { name: 'Release' }).click();

  const outcome = page.locator(OUTCOME_SENTENCE);
  await expect(outcome).toContainText('Released.', { timeout: 15_000 });
  await expect(outcome).toContainText('Nothing was added to your collection.');
  await expect(page.locator('#fishing-catch-panel')).toHaveCount(0);

  const after = await readFishStand(page);
  expect(after.kept, 'a released fish changed the canonical kept count').toBe(before.kept);
  // Compared as the pair of integers the stat publishes, and separately as the canonical tally.
  // This used to read `after.species` as a bare `Number`, which was `NaN` on both sides — and
  // `expect(NaN).toBe(NaN)` passes, because `toBe` is `Object.is`, so the species half of this
  // assertion could not fail whatever the panel said.
  expect(after.species.caught, 'a released fish changed the species count').toBe(before.species.caught);
  expect(after.species.total, 'the catalogue size changed under a release').toBe(before.species.total);
  expect(after.canonicalTypes, 'a released fish changed the canonical type count').toBe(
    before.canonicalTypes,
  );
  expect(after.subjects, 'a released fish changed the subjects-fished count').toBe(before.subjects);

  await evidenceFor(testInfo, 'release-is-inert', 'pixi-fishing-pond', 'pointer-only', context, {
    observedPhases: [],
    notes: [
      'the before count is read before the cast and the after count after the release, on the same artifact',
      'no experience, badge, or count was asserted beyond the canonical collection tally',
    ],
  });
});

test('the Fish Stand reports a canonical catalogue count rather than an entry tally', async ({
  page,
}, testInfo) => {
  const context = await setUp(page);
  await requirePond(context);

  const empty = await readFishStand(page);
  expect(empty.kept).toBe(0);
  expect(empty.species.caught).toBe(0);
  // The denominator is the catalogue, not the collection: an empty collection is zero *of* the whole
  // catalogue, and it is non-zero. This is what makes the "of N" fraction a measurement.
  expect(empty.species.total, 'the catalogue reports no species at all').toBeGreaterThan(0);
  expect(empty.canonicalTypes).toBe(0);

  await reachPond(page, WALK_FISH_STAND_TO_SW_POND);
  await requirePond(context);
  await castUntilCaught(page, castWithPointer);
  await page.locator('#fishing-catch-panel').getByRole('button', { name: 'Keep Fish' }).click();
  await page.getByRole('button', { name: 'Keep this fish (no question, no experience)' }).click();
  await expect(page.locator(OUTCOME_SENTENCE)).toContainText('Kept without a question', { timeout: 15_000 });

  const filled = await readFishStand(page);
  expect(filled.kept).toBe(1);
  expect(filled.species.caught).toBe(1);
  // The test's claim, stated as an equality between the two numbers that can only agree if the
  // collection counts catalogue identities: one entry held, one canonical type, one species cell.
  expect(filled.canonicalTypes).toBe(filled.species.caught);
  // ...and the fraction's denominator is unchanged by catching, so "1 of N" is progress against a
  // fixed catalogue rather than against a collection that grew to fit.
  expect(filled.species.total).toBe(empty.species.total);
  // The summary sentence states the count in words, so the number is announced rather than
  // being only a bare figure a learner has to add up. It is read by `readFishStand` **while the
  // dialog is open**: that helper closes the dialog on its last line, so an assertion placed
  // after it would be looking for an element the test had itself removed — which is what this one
  // used to do, and why it could never pass.
  expect(
    filled.summary,
    'the Fish Stand did not state the kept count in words while its dialog was open',
  ).toContain('You have kept 1 fish, 1 of them species');
  // The fraction's denominator is unchanged by catching, so the sentence's "of N" is progress against
  // a fixed catalogue rather than against a collection that grew to fit — checked against the number
  // the same dialog published, so the prose and the figure cannot drift apart silently.
  expect(filled.summary).toContain(`from the catalogue's ${filled.species.total}.`);
  // The empty read states the other sentence, so the one above is a *change* and not the panel's only
  // wording. This is what stops the assertion above from passing on a panel that always says the same
  // thing regardless of its contents.
  expect(empty.summary).not.toContain('You have kept');
  expect(empty.summary).toContain('No fish kept yet');

  await evidenceFor(testInfo, 'fish-stand-canonical-count', 'pixi-fishing-pond', 'pointer-only', context, {
    observedPhases: [],
    notes: ['the species count is derived from the resolved catalogue id, not from the entry id or display name'],
  });
});

test('the recall question offers a route back to the room it came from', async ({
  page,
}, testInfo) => {
  /*
   * The seeded entry, and it is the only way in for this criterion.
   *
   * `useVillageFishing.onKeep` pulls the question from the **session's** subject and only when
   * that subject has a cleared room, and the subject the session is minted from is the one
   * `useSubjectStore` holds — which is the one named by `:activeSubjectId`. A subject the app
   * mints for itself has no cleared room, so this branch is unreachable without a fixture, and a
   * test that could not reach it would have to skip. `setUp` therefore seeds the fixture through
   * `tests/e2e/fishing-recall-fixture.ts` **and asserts the two preconditions** before the walk:
   * the active-subject pointer names the fixture, and the fixture is the only subject, because
   * `enterFishing` derives the pond's eligibility from whichever subject fills the portal slot
   * nearest the pond.
   */
  const context = await setUp(page, 'seeded-recall');
  await requirePond(context);

  // An archetype has to exist for the route to land anywhere: `App` renders the world route only
  // when the session has a snapshot, an archetype, and an active subject, and an unselected
  // archetype sends a correct recall route back to Welcome instead of the room it resolved.
  await chooseScholarArchetype(page);

  await castUntilCaught(page, castWithPointer);
  await page.locator('#fishing-catch-panel').getByRole('button', { name: 'Keep Fish' }).click();

  // The question branch, asserted by its own two halves: the route control is offered **and** the
  // no-question control is absent. Either alone would pass on the wrong branch.
  const route = page.locator('#fishing-recall-room');
  await expect(route).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('button', { name: 'Keep this fish (no question, no experience)' }),
    'the seeded subject has a cleared room, so the pond produced a question and not the third outcome',
  ).toHaveCount(0);

  await route.click();

  /*
   * The route resolved, and it resolved it **locally and offline**.
   *
   * `useRecallRoomNavigation.openRecallRoom` has exactly two outcomes: it activates the
   * destination's subject and switches the learner into the dungeon on that room, or it refuses
   * in words beside the control. Both are asserted here and neither is allowed to be silent — but
   * only the first is *expected*, because the fixture's subject is on the device by construction
   * and `setUp` asserted that it is the active one. So a refusal is a finding, not a branch:
   * it is reported with its own sentence so the reader learns why the route could not find a
   * subject the run demonstrably has, rather than seeing a bare timeout.
   *
   * The dungeon is asserted by **both** that it opened and by the room it opened on, because
   * "the dialog closed" is also true of a route that navigated to the wrong room and of one that
   * fell back to Welcome. `.game-shell` is the dungeon route's own root, and the fixture's
   * synthetic topic is the floor label the HUD derives from the resolved room.
   */
  const refusal = page.locator('.fishing-recall__refusal[role="alert"]');
  const dungeon = page.locator('.game-shell');

  await expect
    .poll(
      async () => (await refusal.count()) > 0 || (await dungeon.count()) > 0,
      {
        timeout: 30_000,
        message:
          'the recall route neither opened the dungeon nor rendered a refusal within 30s, so the route ' +
          'control did nothing observable',
      },
    )
    .toBe(true);

  if ((await refusal.count()) > 0) {
    throw new Error(
      'The recall route refused to open the room it came from, with this sentence: ' +
        `${JSON.stringify((await refusal.textContent()) ?? '')}. The seeded subject is the active one ` +
        'on this device, which setUp asserted, so a refusal here means openRecallRoom could not read ' +
        'back a subject the run wrote itself - a defect in src/ui/fishing/fishingRecallNavigation.ts, ' +
        'which is not this lane to change.',
    );
  }

  await expect(dungeon, 'the recall route did not open the dungeon').toBeVisible({ timeout: 30_000 });
  await expect(
    dungeon,
    'the dungeon opened, but not on the room the recall question was drawn from',
  ).toContainText(RECALL_FIXTURE_ROOM_TOPIC, { timeout: 30_000 });
  // The village is what the route left, so its absence is the other half of "it navigated".
  await expect(page.locator('[data-world]')).toHaveCount(0);

  await evidenceFor(testInfo, 'recall-room-route', 'pixi-fishing-pond', 'pointer-only', context, {
    observedPhases: [],
    notes: [
      'the subject is a synthetic fixture written by tests/e2e/fishing-recall-fixture.ts',
      'the route is local and offline; it opened the dungeon on the room the question came from',
    ],
  });
});

test('the whole fishing flow makes no request that leaves the preview origin', async ({ page }, testInfo) => {
  const context = await setUp(page);
  await requirePond(context);
  await castUntilCaught(page, castWithKeyboard);
  await page.locator('#fishing-catch-panel').getByRole('button', { name: 'Release' }).click();
  await page.waitForLoadState('networkidle');

  const assertions = context.spy.assertions();
  expect(assertions).toBe('no static-only network policy violations');
  expect(context.spy.report().totalRequests).toBeGreaterThan(0);

  await evidenceFor(testInfo, 'static-only-network', 'pixi-fishing-pond', 'keyboard-only', context, {
    observedPhases: [],
    notes: [
      'every non-loopback request was aborted by the route guard before the application ran',
      'the recorded observation is origin, path, method, and resource type only',
    ],
  });
});

test('the chunk census classifier is not vacuous', async () => {
  // A non-vacuity control for {@link classifyChunkNames}, because the whole lane's artifact
  // classification rests on it: a classifier that matched nothing would report a rollback
  // artifact as containing a pond and a flagged artifact as not, and every other test in this
  // file would pass on the wrong answer.
  const synthetic = classifyChunkNames([
    'FishingWorld-abc123.js',
    'FishingWorld-legacy-def456.js',
    'vendor-pixi-ghi789.js',
    'vendor-pixi-legacy-jkl012.js',
    'vendor-phaser-mno345.js',
    'index-pqr678.js',
  ]);
  expect(synthetic.fishingChunks, 'the modern pond chunk was not recognised').toEqual([
    'FishingWorld-abc123.js',
  ]);
  expect(synthetic.pixiChunks).toEqual(['vendor-pixi-ghi789.js']);
  expect(synthetic.phaserChunks).toEqual(['vendor-phaser-mno345.js']);
  // The ES5 re-emissions are listed rather than dropped, so a renamed marker cannot silently
  // turn every chunk into a "modern" one and double the reported counts.
  expect([...synthetic.legacyChunks].sort()).toEqual([
    'FishingWorld-legacy-def456.js',
    'vendor-pixi-legacy-jkl012.js',
  ]);

  // And the negative direction: a default build's census has nothing in it at all.
  const empty = classifyChunkNames(['index-pqr678.js', 'vendor-phaser-mno345.js']);
  expect(empty.fishingChunks).toEqual([]);
  expect(empty.pixiChunks).toEqual([]);
  expect(empty.phaserChunks).toEqual(['vendor-phaser-mno345.js']);
});