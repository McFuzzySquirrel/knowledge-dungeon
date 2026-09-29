import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';

import { evidenceRelativePath } from '../../e2e/compat-evidence';

import {
  PHASE10_MEDIA_DEV_ORIGIN,
  PHASE10_MEDIA_LANE,
  PHASE10_MEDIA_PREVIEW_ORIGIN,
  type Phase10MediaLaneDeclaration,
} from '../../e2e/phase10-media-lane';
import { supportEntryForProject } from '../../e2e/support-matrix';

/**
 * The browser-backed evidence for Phase 10's four manual checks and its four exit
 * criteria.
 *
 * ## Why this suite exists at all
 *
 * The Phase 10 unit gates are real, and they are not enough.
 * `tests/unit/audioManager.test.ts` proves the gesture gate against a fake
 * `AudioContext` that jsdom supplies, and `tests/phase10/pixi-asset-runtime.test.ts`
 * proves the procedural fallback against a recording stub whose `canvas` is a
 * writable data property.
 *
 * Between them they missed a defect that made an entire subsystem throw on every
 * call in a real browser: `createFallbackTexture` assigned to
 * `CanvasRenderingContext2D.prototype.canvas`, a getter-only accessor, so the
 * assignment raised
 *
 *     TypeError: Cannot set property canvas of #<CanvasRenderingContext2D>
 *                which has only a getter
 *
 * and the module is an ES module, so it is strict mode and the throw was not
 * swallowed. The fallback exists precisely so a missing asset cannot break a
 * route; it was the thing that broke the route. This suite caught it the first
 * time it ran. `tests/phase10/browser-shape-parity.test.ts` is the regression gate
 * so it cannot come back unnoticed between browser runs.
 *
 * ## Two surfaces, and which is which
 *
 * The built artifact does not export its modules, so a previewed page cannot call
 * `audioManager.playBgm` and cannot construct the PixiJS asset runtime. Without a
 * request there is no gate to fire and no bundle to fail, and both absences would
 * make the corresponding assertion pass for the wrong reason — the exact failure
 * mode this suite exists to prevent.
 *
 * So the checks are split, and each test says which surface it is on:
 *
 * - **The production preview** (`vite preview` of the recorded `dist`): everything
 *   about what the shipped bundle and the real Settings panel do. The gesture
 *   check's *negative* half, the persistence check, the no-remote-request check,
 *   and the accessibility scan.
 * - **A dev server on the same checkout**: the two checks that must *call* the
 *   shipped module. The gesture check's *positive* half, and the forced-missing
 *   asset check. The service, the gate, the recipes, the `AudioContext`, the
 *   PixiJS runtime, and the HTTP requests are all real; the surface is the shipped
 *   source unbundled, which is stated in the lane's `doesNotProve` and repeated in
 *   the report rather than rounded up to "the shipped build".
 *
 * ## What is real, everywhere
 *
 * - **The audio service is never stubbed.** The lane imports the shipped module
 *   and calls its public methods. The only thing installed before the page loads
 *   is a *counter* wrapped around the platform constructor, which replaces no
 *   function the service calls and delegates to the real constructor.
 * - **The asset runtime is the real PixiJS one.** `Assets.loadBundle` performs real
 *   fetches; `unloadBundle` runs the real parser teardown.
 * - **The Settings panel is the real one**, driven with mouse and keyboard.
 *
 * ## Privacy
 *
 * Synthetic tutorial fixtures only. No learner data, no request bodies, no query
 * strings, no external host. Every request to a non-local origin is blocked before
 * the application runs, and every recorded observation carries an origin and a
 * path and nothing else.
 */

const LANE: Phase10MediaLaneDeclaration = PHASE10_MEDIA_LANE;

const REPO_ROOT = process.cwd();

/** The WCAG 2.2 AA tag set the repository already uses in `currentBuild.spec.ts`. */
const WCAG_22_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** How long the game world is given to present before a test gives up on it. */
const WORLD_PRESENT_TIMEOUT_MS = 40_000;

/** The tooltip ids the game HUD shows on first run, seeded as already-seen. */
const HUD_TOOLTIP_IDS = [
  'hud-info',
  'hud-map',
  'hud-teleport',
  'hud-settings',
  'hud-journal',
  'hud-inventory',
] as const;

/** The store's own key, read directly so persistence is asserted on storage too. */
const PREFERENCES_STORAGE_KEY = 'knowledge-dungeon:session:preferences';

/* -------------------------------------------------------------------------- */
/* The audio probe                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What the page observed about the platform audio API, attributed.
 *
 * Installed by {@link installAudioProbe} before any application code runs, so the
 * counts cover the whole session rather than the part after the lane looked.
 */
interface AudioProbeReading {
  /** `AudioContext` (or the webkit-prefixed spelling) constructions, by owner. */
  readonly contextsConstructed: number;
  /** Constructions attributable to the Phase 10 audio service. */
  readonly byAudioService: number;
  /**
   * Constructions attributable to Phaser's own `WebAudioSoundManager`.
   *
   * Recorded rather than subtracted silently, because it is a real and
   * pre-existing fact about the product that the maintainer should see: the
   * Phaser world constructs a context when the game boots, before any gesture.
   * Phaser is not in scope for Phase 10 and its context makes no sound on its own.
   */
  readonly byPhaser: number;
  /** Constructions attributable to neither. Anything here is unexplained. */
  readonly byUnknown: number;
  readonly oscillatorsCreated: number;
  readonly oscillatorsStarted: number;
  readonly bufferSourcesCreated: number;
  readonly bufferSourcesStarted: number;
  /**
   * Source nodes that have been started and not yet stopped or ended.
   *
   * This is the live-node count the release criterion asks for, read from the
   * platform's own objects. It is maintained by wrapping `start`, `stop`, and the
   * `ended` event on **real** nodes; the wrappers call through first, so the
   * scheduling is the platform's and only the arithmetic is the probe's.
   */
  readonly liveSourceNodes: number;
  /**
   * The `state` of the most recently constructed context, read **live**.
   *
   * Read at assert time from the platform's own object rather than snapshotted at
   * construction, because "the context reports itself closed after dispose" is a
   * claim about the object's state at that later moment, and a snapshot taken at
   * construction would say `running` forever.
   */
  readonly lastContextState: string | null;
  readonly platformHasAudio: boolean;
}

/** The live reading the spec reads, including the context's current state. */
interface LiveAudioProbeReading extends AudioProbeReading {
  readonly lastContextState: string | null;
}

/**
 * Count constructions of the *real* platform `AudioContext`, and say who made each one.
 *
 * An observer, not a double, and the difference is load-bearing. It wraps the
 * constructor in a `Proxy` whose `construct` trap counts and then calls
 * `Reflect.construct` on the **original** target, so the object the audio service
 * receives is a genuine `AudioContext` with a genuine audio thread behind it, and
 * `resume()`, `state`, and `close()` behave exactly as they would unobserved. The
 * node factories are wrapped the same way: the wrapper counts a start and then
 * delegates to the real `start`, so a voice is really scheduled. Nothing is
 * replaced on the audio service, on the recipes, or on the graph.
 *
 * ## Why attribution is not optional here
 *
 * A bare "how many contexts exist" count is a **confounded measurement**, and the
 * lane found the confound the first time it ran: the production artifact
 * constructs an `AudioContext` when the Phaser world boots, from
 * `WebAudioSoundManager.createAudioContext`, before any user gesture and before
 * the audio service is ever asked for anything. Counting contexts alone would
 * therefore report "1" for a journey in which the audio service built nothing —
 * a false positive on the phase's most important property.
 *
 * So each construction carries the stack of the call that made it, and the owner
 * is derived from that stack: a frame naming the audio service is that service's, a
 * frame naming Phaser is Phaser's, and anything else is `unknown` and is itself a
 * finding. The stacks are *counts and owners*, never recorded as text, so a
 * minified chunk name cannot become a channel into an artifact.
 *
 * It refuses rather than silently overwriting a hook something else installed,
 * for the reason `pixiMemory.spec.ts` records.
 */
async function installAudioProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    if (typeof scope['__KD_AUDIO_PROBE__'] === 'object' && scope['__KD_AUDIO_PROBE__'] !== null) {
      throw new Error('The audio probe is already installed; refusing to overwrite another hook.');
    }

    const reading = {
      contextsConstructed: 0,
      byAudioService: 0,
      byPhaser: 0,
      byUnknown: 0,
      oscillatorsCreated: 0,
      oscillatorsStarted: 0,
      bufferSourcesCreated: 0,
      bufferSourcesStarted: 0,
      liveSourceNodes: 0,
      lastContextState: null as string | null,
      platformHasAudio: false,
    };
    // The most recently constructed context, held so its state can be read live.
    // This is the page's own object; the probe keeps a reference and never mutates
    // it beyond wrapping the two node factories.
    const live = { context: null as AudioContext | null };
    scope['__KD_AUDIO_PROBE_LIVE__'] = live;
    scope['__KD_AUDIO_PROBE__'] = reading;

    const candidate = (scope['AudioContext'] ?? scope['webkitAudioContext']) as
      | (new () => AudioContext)
      | undefined;
    if (typeof candidate !== 'function') return;
    reading.platformHasAudio = true;

    const observed = new Proxy(candidate, {
      construct(target, args, newTarget): AudioContext {
        const context = Reflect.construct(target, args, newTarget) as AudioContext;
        const stack = String(new Error('kd-audio-probe').stack ?? '');

        // Attribution, by module identity rather than by a frame count. The audio
        // service's own frames name `audioGraph.ts` (where the context is built) or
        // `audioManager.ts` (where the graph factory is called from); Phaser's name
        // its own sound manager. Neither string is recorded — only the verdict.
        const isAudioService = /audioGraph|audioManager/.test(stack);
        const isPhaser = !isAudioService && /[Pp]haser/.test(stack);
        if (isAudioService) reading.byAudioService += 1;
        else if (isPhaser) reading.byPhaser += 1;
        else reading.byUnknown += 1;

        reading.contextsConstructed += 1;
        reading.lastContextState = context.state;
        // Only the audio service's own context is held, so a live state read can
        // never be Phaser's by accident.
        if (isAudioService) live.context = context;

        const createOscillator = context.createOscillator.bind(context);
        context.createOscillator = (): OscillatorNode => {
          reading.oscillatorsCreated += 1;
          const oscillator = createOscillator();
          const start = oscillator.start.bind(oscillator);
          oscillator.start = (when?: number): void => {
            reading.oscillatorsStarted += 1;
            reading.liveSourceNodes += 1;
            start(when);
          };
          const stop = oscillator.stop.bind(oscillator);
          let counted = false;
          const release = (): void => {
            if (counted) return;
            counted = true;
            reading.liveSourceNodes -= 1;
          };
          oscillator.stop = (when?: number): void => {
            release();
            stop(when);
          };
          oscillator.addEventListener('ended', release);
          return oscillator;
        };

        const createBufferSource = context.createBufferSource.bind(context);
        context.createBufferSource = (): AudioBufferSourceNode => {
          reading.bufferSourcesCreated += 1;
          const source = createBufferSource();
          const start = source.start.bind(source);
          source.start = (when?: number, offset?: number, duration?: number): void => {
            reading.bufferSourcesStarted += 1;
            reading.liveSourceNodes += 1;
            start(when, offset, duration);
          };
          const stop = source.stop.bind(source);
          let counted = false;
          const release = (): void => {
            if (counted) return;
            counted = true;
            reading.liveSourceNodes -= 1;
          };
          source.stop = (when?: number): void => {
            release();
            stop(when);
          };
          source.addEventListener('ended', release);
          return source;
        };

        return context;
      },
    });

    scope['AudioContext'] = observed;
    scope['webkitAudioContext'] = observed;
  });
}

async function readAudioProbe(page: Page): Promise<LiveAudioProbeReading> {
  return page.evaluate(() => {
    const probe = (globalThis as unknown as Record<string, unknown>)['__KD_AUDIO_PROBE__'];
    if (typeof probe !== 'object' || probe === null) {
      throw new Error('The audio probe is not installed; every reading would be vacuous.');
    }
    const live = (globalThis as unknown as Record<string, unknown>)['__KD_AUDIO_PROBE_LIVE__'] as
      | { context: AudioContext | null }
      | undefined;
    const reading = probe as LiveAudioProbeReading;
    // Read the state now, from the platform's own object. `close()` is
    // asynchronous, so a snapshot taken at construction would still say `running`
    // however long afterwards the assertion runs.
    return live?.context ? { ...reading, lastContextState: live.context.state } : { ...reading };
  });
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Put a first-run device into the state a returning learner is already in.
 *
 * Both the HUD's teaching tooltips and the gameplay onboarding modal are real
 * product surfaces, and both are *clickable* — and the tooltip is a
 * `position: fixed` overlay that covers the very control the accessibility scan
 * is measuring. Seeding the two "already seen" keys is the same state a returning
 * learner has, and neither touches audio, a subject, or a note.
 */
async function seedReturningLearner(page: Page): Promise<void> {
  await page.addInitScript(
    (args: { tooltips: readonly string[] }) => {
      window.localStorage.setItem('knowledge-dungeon:ui:tooltips:v1', JSON.stringify(args.tooltips));
      // The touch hint. It is a centred, `pointer-events: auto` overlay that a
      // coarse-pointer or narrow viewport raises 1.5 seconds after the world boots,
      // and it sits directly over the Settings control the accessibility scan is
      // trying to measure — so on the two touch-emulated viewports the lane has to
      // put it behind it. Seeding the "already seen" key is the state a returning
      // learner is in, and it carries no audio, subject, or note.
      window.localStorage.setItem('knowledge-dungeon:ui:touch-hint:v1', '1');
    },
    { tooltips: [...HUD_TOOLTIP_IDS] },
  );
}

/** Dismiss the gameplay onboarding modal if it is showing. It carries no audio. */
async function dismissOnboarding(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Gameplay onboarding' });
  if ((await dialog.count()) === 0) return;
  await dialog.getByRole('button').last().click();
  await dialog.waitFor({ state: 'detached' });
}

async function openWelcome(page: Page, origin = PHASE10_MEDIA_PREVIEW_ORIGIN): Promise<void> {
  await page.goto(`${origin}/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
}

/** The tutorial subject, which is the repository's own synthetic fixture. */
async function enterGameWorld(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start Tutorial' }).click();
  await expect(page.locator('.game-canvas-host canvas')).toBeVisible({ timeout: WORLD_PRESENT_TIMEOUT_MS });
  await dismissOnboarding(page);
}

/**
 * A locator that matches the Settings control on either screen.
 *
 * Used only as a *readiness* signal — "some settings control is on screen, so the
 * screen has mounted" — because it matches both names. Anything that has to click
 * the control uses {@link settingsButton}, which resolves which one it is.
 */
function settingsReady(page: Page) {
  return page.getByRole('button', { name: /settings/i }).first();
}

/**
 * The Settings control on whichever screen is mounted.
 *
 * The two screens name it differently and neither name contains the other as a
 * strict match: the game HUD's icon button is `Open settings`, and the village
 * sidebar's reads `⚙ Settings`. The HUD's own name is tried first because the game
 * screen is the one the audio journey spends most of its time on, and the fallback
 * is chosen by *label* rather than by index — an index would break the moment a
 * third screen adds a control whose name happens to contain "settings".
 */
async function settingsButton(page: Page) {
  const hud = page.getByRole('button', { name: 'Open settings' });
  if ((await hud.count()) > 0) return hud.first();
  const candidates = page.getByRole('button', { name: /settings/i });
  const total = await candidates.count();
  for (let index = 0; index < total; index += 1) {
    const candidate = candidates.nth(index);
    const label = ((await candidate.getAttribute('aria-label')) ?? (await candidate.innerText())).trim();
    // A control whose label only *mentions* settings in its title is not the one.
    if (/open settings/i.test(label)) continue;
    return candidate;
  }
  throw new Error('No Settings control is present on this screen.');
}

/**
 * Open the Settings modal and select its Audio tab.
 */
async function openAudioTab(page: Page): Promise<void> {
  await (await settingsButton(page)).click();
  await page.getByRole('tab', { name: 'Audio' }).click();
  await expect(page.locator('.kd-audio-settings')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.kd-audio-settings')).toHaveCount(0);
}

/** The three persisted values, read from the real controls. */
async function readAudioPanel(page: Page): Promise<{ muted: string; music: string; sfx: string }> {
  return {
    muted: (await page.locator('#settings-audio-mute').getAttribute('aria-checked')) ?? '',
    music: await page.locator('#settings-audio-music-volume').inputValue(),
    sfx: await page.locator('#settings-audio-sfx-volume').inputValue(),
  };
}

async function readPersistedPreferences(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key: string) => {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  }, PREFERENCES_STORAGE_KEY);
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
  // Attachments only reach disk when a test fails, so a *passing* lane would leave
  // no evidence for anyone to read. Every reading is therefore also written to the
  // allowlisted `artifacts/compatibility-evidence/` tree — the same root, and the
  // same `evidenceRelativePath` sanitiser, the Pixi memory lane uses, so the CI
  // upload already covers it and nothing new has to be allowlisted.
  const relativePath = evidenceRelativePath({
    runId: process.env.KD_COMPAT_RUN_ID ?? 'phase10-media-local',
    project: LANE.project,
    testTitle: testInfo.title,
  });
  const absolute = path.join(REPO_ROOT, relativePath, '..', `${name.replace(/\.json$/, '')}.json`);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* In-page module loading                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The shapes the lane reads off the shipped modules, in the page.
 *
 * Declared here rather than imported, and that is the whole point: the built
 * artifact does not export its modules, so these checks reach the shipped source
 * through the dev server, where the module specifier is a *runtime string*. Importing
 * the real types would defeat that — TypeScript would then resolve the specifier at
 * compile time and fail to build a path that only exists at run time. So the shapes
 * are declared, and a wrong shape is a wrong reading rather than a wrong build.
 */
interface DevAudioState {
  readonly unlocked: boolean;
  readonly bgmPlaying: boolean;
  readonly currentBgm: string | null;
  readonly activeProvider: string;
  readonly musicVolume: number;
  readonly sfxVolume: number;
  readonly muted: boolean;
}

interface DevAudioManager {
  playBgm(track: string): void;
  playSfx(kind: string): void;
  getState(): DevAudioState;
  dispose(): void;
}

interface DevAudioModule {
  readonly audioManager: DevAudioManager;
}

interface DevAssetReport {
  readonly ok: boolean;
  readonly loaded: readonly string[];
  readonly fellBack: readonly string[];
  readonly failed: readonly string[];
}

interface DevAssetTexture {
  readonly width: number;
  readonly height: number;
  readonly destroyed: boolean;
}

interface DevFailureRecord {
  readonly bundleId: string;
  readonly key: string;
  readonly kind: string;
  readonly count: number;
}

interface DevAssetLoader {
  loadBundle(id: string): Promise<DevAssetReport>;
  unloadBundle(id: string): Promise<void>;
  getTexture(key: string): DevAssetTexture | null;
  dispose(): Promise<void>;
  diagnostics(): { readonly failures: readonly DevFailureRecord[] };
}

interface DevAssetLoaderModule {
  createAssetLoader(options: {
    runtime: unknown;
    onFailure?: (record: DevFailureRecord) => void;
    logger?: (message: string) => void;
  }): DevAssetLoader;
}

interface DevAssetRuntimeModule {
  createPixiAssetRuntime(): unknown;
}

/**
 * The slice of PixiJS the release measurement uses.
 *
 * A real `Application` over a real WebGL2 context, a real `Sprite`, and the
 * renderer's own managed-source hash. Declared rather than imported for the same
 * reason as the modules above: the specifier is resolved at run time, so the
 * compiler must not be asked to know the type.
 */
interface DevPixiModule {
  Application: new () => {
    init(options: Record<string, unknown>): Promise<void>;
    renderer: {
      readonly uid: number;
      render(stage: unknown): void;
      readonly texture: unknown;
    };
    readonly stage: { addChild(node: unknown): void };
    destroy(removeView: boolean, options: Record<string, unknown>): void;
  };
  Sprite: new (texture: unknown) => { destroy(): void };
}

/** The specifiers the dev server serves. Runtime strings, on purpose. */
const AUDIO_MODULE = '/src/services/audioManager.ts';
const ASSET_LOADER_MODULE = '/src/renderers/pixi/assets/AssetLoader.ts';
const ASSET_RUNTIME_MODULE = '/src/renderers/pixi/runtime/createPixiApplication.ts';

/* -------------------------------------------------------------------------- */
/* The artifact under test                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Verify the recorded production identity before anything is measured.
 *
 * A hard failure, never a skip: a lane that measured a stale tree, or none, would
 * report the previous build's behaviour as this build's. The same shape
 * `pixiMemory.spec.ts` uses, and for the same reason.
 */
function verifyRecordedArtifact(): void {
  execFileSync(
    'node',
    [path.join(REPO_ROOT, 'scripts/web-artifact-manifest.mjs'), 'verify', `--manifest=${LANE.manifestPath}`],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
}

/* -------------------------------------------------------------------------- */
/* The spec                                                                     */
/* -------------------------------------------------------------------------- */

test.beforeAll(() => {
  verifyRecordedArtifact();
});

test.beforeEach(async ({ page }) => {
  // Every request to a non-local origin is blocked before the application runs, so
  // a privacy regression is still *observed* by the spy and cannot leave the
  // machine.
  await page.route(
    (url) => (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1',
    async (route) => {
      await route.abort('blockedbyclient');
    },
  );
});

test.describe('the artifact under test', () => {
  test('is the recorded production build, verified rather than assumed', () => {
    expect(LANE.buildScript).toBe('build:web');
    expect(LANE.manifestPath).toBe('artifacts/web-artifact-manifest.json');
    expect(LANE.worldRenderer).toBe('phaser');
  });
});

test.describe('manual check 1, negative half: nothing constructs a context before a gesture', () => {
  test('operating every audio control in the real panel on the production artifact constructs no AudioContext', async ({
    page,
  }, testInfo) => {
    await installAudioProbe(page);
    await seedReturningLearner(page);
    await openWelcome(page);

    const before = await readAudioProbe(page);
    expect(
      before.platformHasAudio,
      'This browser exposes no Web Audio constructor, so every reading below would be vacuous.',
    ).toBe(true);

    await enterGameWorld(page);

    // Every control is operated. Each is a real user interaction, so a service
    // that unlocked on "the settings surface was touched" would show up here
    // rather than being argued about.
    await openAudioTab(page);
    await page.locator('#settings-audio-mute').click();
    await page.locator('#settings-audio-music-volume').fill('17');
    await page.locator('#settings-audio-sfx-volume').fill('83');
    await page.locator('#settings-audio-music').click();
    await page.locator('#settings-audio-sfx').click();
    await closeSettings(page);

    // And a real trusted click, which is the gesture the service is gated on.
    await page.mouse.click(720, 450);
    await page.waitForTimeout(300);

    const after = await readAudioProbe(page);
    await attachJson(testInfo, 'audio-probe-production-panel.json', { before, after });

    // The claim is about *the audio service*, so it is asserted on the attributed
    // count. A bare page-wide count is confounded: the Phaser world constructs its
    // own context when the game boots, which is a real pre-existing fact recorded
    // above and not something Phase 10 introduced.
    expect(
      after.byAudioService,
      'The panel was opened, every control operated, and a real click was made — and the audio service constructed no context.',
    ).toBe(0);
    expect(after.oscillatorsStarted, 'No voice was scheduled before a gesture.').toBe(0);
    expect(after.bufferSourcesStarted, 'No sample was scheduled before a gesture.').toBe(0);
    // Anything built by neither the audio service nor Phaser is unexplained, and
    // unexplained is a finding rather than a pass.
    expect(
      after.byUnknown,
      'A context was constructed by neither the audio service nor Phaser, so the reading is unexplained.',
    ).toBe(0);
  });

  test('records the pre-existing Phaser context rather than hiding it', async ({ page }, testInfo) => {
    // A second test for the confound itself, so the attribution above cannot rot
    // into "always zero". If Phaser stopped constructing a context, or started
    // constructing one the audio service owns, this test is the one that notices.
    await installAudioProbe(page);
    await seedReturningLearner(page);
    await openWelcome(page);

    const atWelcome = await readAudioProbe(page);
    await enterGameWorld(page);
    const afterWorld = await readAudioProbe(page);
    await attachJson(testInfo, 'audio-probe-phaser-attribution.json', { atWelcome, afterWorld });

    expect(atWelcome.byAudioService, 'Welcome constructs no context at all').toBe(0);
    expect(atWelcome.byPhaser, 'Welcome constructs none, so Phaser has not booted yet').toBe(0);
    expect(
      afterWorld.byAudioService,
      'Booting the Phaser world does not make the audio service build a context',
    ).toBe(0);
    // The recorded fact: the world boot costs one Phaser-owned context. Asserted
    // rather than allowed for, so a change in either direction is visible.
    expect(
      afterWorld.byPhaser,
      'The Phaser world constructs its own sound-manager context, which is pre-existing and not Phase 10\'s',
    ).toBe(1);
  });
});

test.describe('manual check 1, positive half: a real gesture does start playback', () => {
  test('requests before a gesture build nothing; a real click builds a context, resumes it, and starts voices', async ({
    page,
  }, testInfo) => {
    await installAudioProbe(page);
    await seedReturningLearner(page);
    // The dev surface, because the built artifact does not export its modules and
    // without a request there is no gate to fire.
    await openWelcome(page, PHASE10_MEDIA_DEV_ORIGIN);
    await enterGameWorld(page);

    // The shipped singleton, called through its own public surface. Not a double:
    // the same module the application imports, the same recipes, the platform's
    // own context.
    const beforeGesture = await page.evaluate(async (specifier) => {
      const module = (await import(/* @vite-ignore */ specifier)) as unknown as DevAudioModule;
      module.audioManager.playBgm('bgm-village');
      module.audioManager.playSfx('ui-click');
      module.audioManager.playSfx('fish-catch');
      return module.audioManager.getState();
    }, AUDIO_MODULE);
    const probeBefore = await readAudioProbe(page);

    await attachJson(testInfo, 'audio-probe-dev-before-gesture.json', {
      state: beforeGesture,
      probe: probeBefore,
    });

    // The negative half, on the surface where a request is possible at all. This
    // is the assertion the whole gesture gate exists for: many requests, and
    // nothing built.
    expect(beforeGesture.unlocked, 'the gate is closed before any gesture').toBe(false);
    expect(beforeGesture.currentBgm, 'a BGM request before the gesture is remembered as intent').toBe('bgm-village');
    expect(beforeGesture.bgmPlaying, 'and nothing is playing yet').toBe(false);
    expect(
      probeBefore.byAudioService,
      'the audio service constructed no context, however many requests it was given',
    ).toBe(0);
    expect(probeBefore.oscillatorsCreated, 'no node was created by the requests').toBe(0);

    // A real trusted click. Playwright dispatches an actual input event, so this
    // is a user activation and not a synthetic dispatchEvent.
    await page.mouse.click(720, 450);
    await page.waitForTimeout(600);

    const afterGesture = await page.evaluate(async (specifier) => {
      const module = (await import(/* @vite-ignore */ specifier)) as unknown as DevAudioModule;
      module.audioManager.playSfx('ui-click');
      return module.audioManager.getState();
    }, AUDIO_MODULE);
    const probeAfter = await readAudioProbe(page);
    await attachJson(testInfo, 'audio-probe-dev-after-gesture.json', {
      state: afterGesture,
      probe: probeAfter,
    });

    // The positive half: exactly one context *by the audio service*, the real one,
    // resumed to running, with the remembered track actually started. The
    // attribution matters — the page also holds Phaser's contexts, and counting
    // them would make "one" mean the wrong thing.
    expect(probeAfter.byAudioService, 'the gesture made the audio service construct exactly one context').toBe(1);
    expect(afterGesture.unlocked, 'the service is unlocked').toBe(true);
    expect(afterGesture.bgmPlaying, 'the remembered BGM started on the gesture').toBe(true);
    expect(afterGesture.activeProvider, 'the procedural provider served it, because no CC0 file is registered').toBe('fallback');
    expect(probeAfter.oscillatorsStarted, 'real oscillators were really scheduled').toBeGreaterThan(0);
    expect(probeAfter.lastContextState, 'the real context reached running').toBe('running');
  });
});

test.describe('exit criterion: audio resources are released', () => {
  test('after dispose the real AudioContext is closed and no live source node remains', async ({
    page,
  }, testInfo) => {
    await installAudioProbe(page);
    await seedReturningLearner(page);
    await openWelcome(page, PHASE10_MEDIA_DEV_ORIGIN);
    await enterGameWorld(page);

    // Play something first, so "dispose released it" is a claim about a graph that
    // had something in it. The music is a looped pad, so its nodes stay live for as
    // long as they are held — which is what makes the live count a real number
    // rather than a race against a one-shot ending on its own.
    const beforeGesture = await page.evaluate(async (specifier) => {
      const module = (await import(/* @vite-ignore */ specifier)) as unknown as DevAudioModule;
      module.audioManager.playBgm('bgm-village');
      (globalThis as unknown as Record<string, unknown>)['__AM__'] = module.audioManager;
      return module.audioManager.getState();
    }, AUDIO_MODULE);
    await page.mouse.click(720, 450);
    await page.waitForTimeout(800);
    await page.evaluate(async (specifier) => {
      const module = (await import(/* @vite-ignore */ specifier)) as unknown as DevAudioModule;
      module.audioManager.playSfx('fish-catch');
    }, AUDIO_MODULE);
    // Let the one-shot effects finish on their own, so the remaining live nodes are
    // the music the service is holding.
    // The state *after* the click, which is the one the non-vacuity control needs:
    // `beforeGesture.unlocked` is false by design, and that is the negative half.
    const unlockedState = await page.evaluate(async (specifier) => {
      const module = (await import(/* @vite-ignore */ specifier)) as unknown as DevAudioModule;
      return module.audioManager.getState();
    }, AUDIO_MODULE);
    await page.waitForTimeout(2_500);

    const whilePlaying = await readAudioProbe(page);
    const disposeState = await page.evaluate(() => {
      const manager = (globalThis as unknown as Record<string, unknown>)['__AM__'] as DevAudioManager;
      manager.dispose();
      return manager.getState();
    });
    await page.waitForTimeout(600);
    const afterDispose = await readAudioProbe(page);

    await attachJson(testInfo, 'audio-dispose-reading.json', {
      beforeGesture,
      unlockedState,
      whilePlaying,
      disposeState,
      afterDispose,
    });

    // NON-VACUITY, twice over. The service really had a context of its own — the
    // attributed count, so Phaser's contexts cannot stand in for it — and the music
    // really was holding live source nodes, so a count that returns to zero is a
    // measurement of the release rather than of an already-empty graph.
    expect(unlockedState.unlocked, 'the graph really was unlocked').toBe(true);
    expect(unlockedState.bgmPlaying, 'and the looped track really was playing').toBe(true);
    expect(whilePlaying.byAudioService, 'the audio service really had a context').toBe(1);
    expect(
      whilePlaying.liveSourceNodes,
      'the looped track really was holding live source nodes before dispose',
    ).toBeGreaterThan(0);

    // The criterion, read from the real page rather than from a double.
    expect(
      afterDispose.lastContextState,
      'the real AudioContext reports itself closed after dispose',
    ).toBe('closed');
    expect(
      afterDispose.liveSourceNodes,
      'the number of live source nodes returns to zero after dispose',
    ).toBe(0);
    expect(disposeState.unlocked, 'the service reports itself locked again').toBe(false);
    expect(disposeState.bgmPlaying, 'and nothing playing').toBe(false);
    expect(disposeState.activeProvider, 'and no provider left active').toBe('none');
  });
});

test.describe('manual check 2: mute and volume persist across routes', () => {
  test('mute and both volumes survive two route changes and a full reload', async ({ page }, testInfo) => {
    await seedReturningLearner(page);
    await openWelcome(page);
    await enterGameWorld(page);

    // Set all three through the real controls.
    await openAudioTab(page);
    await page.locator('#settings-audio-mute').click();
    await page.locator('#settings-audio-music-volume').fill('17');
    await page.locator('#settings-audio-sfx-volume').fill('83');
    const chosen = await readAudioPanel(page);
    expect(chosen).toEqual({ muted: 'true', music: '17', sfx: '83' });
    await closeSettings(page);

    const persisted = await readPersistedPreferences(page);
    await attachJson(testInfo, 'audio-preferences-persisted.json', persisted);
    // The whole payload, not only the audio fields: the audio keys are additive
    // and must not have displaced the pre-existing theme key.
    expect(persisted).toMatchObject({
      musicVolume: 0.17,
      sfxVolume: 0.83,
      muted: true,
      colorTheme: expect.any(String),
    });

    // Route 2: the village, through the product's own control, so the store is
    // re-hydrated by the real bootstrap rather than by the lane.
    await page.getByRole('button', { name: 'Return to subject selection' }).click();
    await expect(settingsReady(page)).toBeVisible({ timeout: 30_000 });
    await openAudioTab(page);
    const onVillage = await readAudioPanel(page);
    await closeSettings(page);
    expect(onVillage, 'the values survived the change of screen').toEqual(chosen);

    // Route 3, and the stronger claim: a full reload. The plan says "across
    // routes"; this proves the stronger one and the report says which was proved.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Knowledge Dungeon' })).toBeVisible();
    await enterGameWorld(page);
    await openAudioTab(page);
    const afterReload = await readAudioPanel(page);
    await closeSettings(page);
    expect(afterReload, 'the values survived a full reload and a fresh bootstrap').toEqual(chosen);
  });
});

test.describe('manual check 3: no remote media request occurs', () => {
  test('every request the whole journey makes is same-origin', async ({ page }, testInfo) => {
    const observations: Array<{
      origin: string;
      path: string;
      resourceType: string;
      method: string;
    }> = [];
    page.on('request', (request: Request) => {
      const url = new URL(request.url());
      // Origin and path only. No query, no fragment, no headers, no body: a
      // privacy artifact must not be able to carry a subject name.
      observations.push({
        origin: url.origin,
        path: url.pathname,
        resourceType: request.resourceType(),
        method: request.method(),
      });
    });

    await installAudioProbe(page);
    await seedReturningLearner(page);
    await openWelcome(page);
    await enterGameWorld(page);
    await openAudioTab(page);
    await page.locator('#settings-audio-mute').click();
    await page.locator('#settings-audio-music-volume').fill('17');
    await closeSettings(page);
    await page.getByRole('button', { name: 'Return to subject selection' }).click();
    await expect(settingsReady(page)).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    const offOrigin = observations.filter(
      (entry) => entry.origin !== 'null' && entry.origin !== PHASE10_MEDIA_PREVIEW_ORIGIN,
    );
    const fonts = observations.filter((entry) => entry.resourceType === 'font');
    const media = observations.filter((entry) => entry.resourceType === 'media');

    await attachJson(testInfo, 'network-observations.json', {
      totalRequests: observations.length,
      resourceTypes: [...new Set(observations.map((entry) => entry.resourceType))].sort(),
      offOrigin,
      fonts,
      media,
    });

    expect(offOrigin, `Off-origin requests: ${JSON.stringify(offOrigin)}`).toEqual([]);
    // NON-VACUITY: a journey that made no requests would also pass the line above.
    expect(observations.length, 'the journey really made requests').toBeGreaterThan(5);
    expect(
      observations.some((entry) => entry.path.startsWith('/assets/')),
      'the journey really requested static assets, so the same-origin check saw them',
    ).toBe(true);
    expect(fonts, 'Phase 8 removed the remote font import; a web-font request would be a regression.').toEqual([]);
    expect(media, 'Phase 10 loads no media file; a media request would be a regression.').toEqual([]);
  });
});

test.describe('manual check 4: optional missing art does not break a route', () => {
  test('a forced-missing bundle asset is attempted, falls back, and leaves the route rendered', async ({
    page,
  }, testInfo) => {
    const attempted: string[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
    });
    page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

    // Every Cozy placeholder is made to fail.
    await page.route('**/assets/cozy/*.svg', async (route) => {
      attempted.push(new globalThis.URL(route.request().url()).pathname);
      await route.abort('failed');
    });

    await seedReturningLearner(page);
    await openWelcome(page, PHASE10_MEDIA_DEV_ORIGIN);
    await enterGameWorld(page);

    const result = await page.evaluate(async (specifiers) => {
      const loaderModule = (await import(/* @vite-ignore */ specifiers.loader)) as unknown as DevAssetLoaderModule;
      const runtimeModule = (await import(/* @vite-ignore */ specifiers.runtime)) as unknown as DevAssetRuntimeModule;

      const runtime = runtimeModule.createPixiAssetRuntime();
      const failures: string[] = [];
      const loader = loaderModule.createAssetLoader({
        runtime,
        onFailure: (record: DevFailureRecord) =>
          failures.push(`${record.bundleId}|${record.key}|${record.kind}`),
        logger: () => {},
      });

      const report = await loader.loadBundle('pixi-default');
      const texture = loader.getTexture('cozy-berry-bush');
      const observation = {
        ok: report.ok,
        loaded: [...report.loaded],
        fellBack: [...report.fellBack],
        failed: [...report.failed],
        failures,
        diagnostics: loader.diagnostics(),
        fallbackWidth: texture === null ? 0 : texture.width,
        fallbackHeight: texture === null ? 0 : texture.height,
      };
      await loader.dispose();
      return observation;
    }, { loader: ASSET_LOADER_MODULE, runtime: ASSET_RUNTIME_MODULE });

    await attachJson(testInfo, 'forced-missing-bundle.json', {
      attemptedCount: attempted.length,
      ...result,
    });

    // NON-VACUITY FIRST. Without the request, nothing below means anything.
    expect(
      attempted.length,
      'the bundle members were really requested, so the failure below is a real one',
    ).toBeGreaterThan(0);

    // The route is still rendered, in the same page, after the failures.
    await expect(page.locator('.game-canvas-host canvas')).toBeVisible();

    // Every member failed, every member fell back, and the loader resolved rather
    // than rejecting — the property the whole no-reject policy exists for.
    expect(result.fellBack.length, 'every member fell back').toBe(6);
    expect(result.failed.length, 'every member is reported as failed').toBe(6);
    expect(result.loaded, 'nothing loaded').toEqual([]);
    expect(result.fallbackWidth, 'the fallback is a real texture of the recipe size').toBeGreaterThan(0);
    expect(result.fallbackHeight).toBeGreaterThan(0);
    expect(result.failures.length, 'each failure is recorded once, with a bounded signature').toBe(6);

    // A diagnostic record carries no path, no URL, and no caught message.
    for (const record of result.diagnostics.failures) {
      expect(Object.keys(record).sort()).toEqual(['bundleId', 'count', 'key', 'kind']);
      expect(String(record.bundleId)).not.toContain('/');
      expect(String(record.key)).not.toContain('/');
    }

    // Nothing reached the page as an unhandled error. The browser's own console
    // lines for a failed subresource are expected and are separated out, because
    // "no console errors at all" would assert that the network never failed.
    expect(pageErrors, `Unhandled page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    const unexpectedConsole = consoleErrors.filter((line) => !/Failed to load resource/i.test(line));
    expect(unexpectedConsole, `Unexpected console errors: ${unexpectedConsole.join(' | ')}`).toEqual([]);
  });
});

test.describe('exit criterion: Pixi textures are released', () => {
  /**
   * Twenty load/render/release cycles against a real WebGL context.
   *
   * ## Why this is a GPU measurement and not a node count
   *
   * The unit gates in `tests/phase10/asset-loader.test.ts` assert reference counts
   * and a double's `destroyTexture` calls. That is instrumentation, not a
   * measurement of anything the browser did, and it is labelled as such there.
   * This test answers a different question: **after the bundle is released, does
   * the renderer's texture system still hold the GPU resources?**
   *
   * Three things make it a real measurement rather than a restatement of the unit
   * gate:
   *
   * 1. **A real `Application` over a real WebGL2 context** is created, and a sprite
   *    is built from every loaded texture and rendered, so each one is genuinely
   *    uploaded to the GPU. A texture that was never rendered never occupied
   *    video memory and its release would be vacuous.
   * 2. **The counted set is the renderer's own managed-source hash**, read from the
   *    live `TextureSystem` and filtered to entries that still hold a GL handle for
   *    this renderer. Pixi nulls a hash entry on release rather than deleting it —
   *    counting raw entries would report growth that is not there, which is exactly
   *    the mistake a first attempt at this measurement made.
   * 3. **A non-vacuity control runs first**: six bundles are loaded and rendered and
   *    deliberately *not* released, and the live count must rise. A counter that
   *    cannot see growth cannot be trusted to report its absence.
   *
   * What it still is not: a figure in bytes. No browser API reports texture memory,
   * so the claim is a count of live GPU-backed sources, which is the release-side
   * fact a byte figure would stand in for.
   */
  test('twenty load/render/release cycles leave no monotonic growth of live GPU textures', async ({
    page,
  }, testInfo) => {
    await seedReturningLearner(page);
    await openWelcome(page, PHASE10_MEDIA_DEV_ORIGIN);
    await enterGameWorld(page);

    const series = await page.evaluate(async (input: { cycles: number; loader: string; runtime: string }) => {
      const cycles = input.cycles;
      const loaderModule = (await import(/* @vite-ignore */ input.loader)) as unknown as DevAssetLoaderModule;
      const runtimeModule = (await import(/* @vite-ignore */ input.runtime)) as unknown as DevAssetRuntimeModule;
      // The same module the runtime binding resolved, reached the way the binding
      // reaches it: read the transformed source and import what it named. That is
      // the one `pixi.js` instance in the page, not a second copy.
      const source = await fetch(input.runtime);
      const pixiUrl = /from\s*"([^"]*pixi[^"]*)"/.exec(await source.text())?.[1];
      if (pixiUrl === undefined) throw new Error('The runtime binding no longer names pixi.js.');
      const pixi = (await import(/* @vite-ignore */ pixiUrl)) as unknown as DevPixiModule;

      const application = new pixi.Application();
      await application.init({ width: 128, height: 128, preference: 'webgl', background: 0x000000 });
      const renderer = application.renderer;
      const keys = [
        'cozy-berry-bush',
        'cozy-moss-grass',
        'cozy-ink-panel',
        'cozy-parchment-floor',
        'cozy-ink-signpost',
        'cozy-firelight-torch',
      ];

      /** Sources that still hold a GL handle for this renderer. */
      const liveSources = (): number =>
        Object.values((renderer.texture as unknown as Record<string, Record<string, unknown>>)['_managedTextures'].items as Record<string, unknown>)
          .filter(
            (source): source is NonNullable<typeof source> =>
              source !== null &&
              typeof source === 'object' &&
              (source as { _gpuData?: Record<string, unknown> })._gpuData?.[renderer.uid] !== undefined,
          ).length;

      const renderAll = (loader: DevAssetLoader): void => {
        for (const key of keys) {
          const sprite = new pixi.Sprite(loader.getTexture(key));
          application.stage.addChild(sprite);
          renderer.render(application.stage);
          sprite.destroy();
        }
      };

      const runtime = runtimeModule.createPixiAssetRuntime();
      const baseline = liveSources();

      // NON-VACUITY: six bundles rendered and deliberately not released.
      const leaky = loaderModule.createAssetLoader({ runtime, logger: () => {} });
      for (let index = 0; index < 6; index += 1) await leaky.loadBundle('pixi-default');
      renderAll(leaky);
      const whileHeld = liveSources();
      await leaky.unloadBundle('pixi-default');
      await leaky.dispose();
      const afterRelease = liveSources();

      const samples: Array<{ live: number; destroyed: boolean; heapKB: number }> = [];
      for (let index = 0; index < cycles; index += 1) {
        const loader = loaderModule.createAssetLoader({ runtime, logger: () => {} });
        await loader.loadBundle('pixi-default');
        renderAll(loader);
        const held = loader.getTexture('cozy-berry-bush');
        await loader.unloadBundle('pixi-default');
        await loader.dispose();
        samples.push({
          live: liveSources(),
          destroyed: held !== null && held.destroyed,
          heapKB: Math.round(
            (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1024,
          ),
        });
      }

      application.destroy(true, { removeView: true });
      return { baseline, whileHeld, afterRelease, samples };
    }, { cycles: 20, loader: ASSET_LOADER_MODULE, runtime: ASSET_RUNTIME_MODULE });

    const first = series.samples[0];
    const last = series.samples[series.samples.length - 1];
    await attachJson(testInfo, 'pixi-texture-release-series.json', {
      baseline: series.baseline,
      whileHeld: series.whileHeld,
      afterRelease: series.afterRelease,
      cycles: series.samples.length,
      first,
      last,
      liveCounts: series.samples.map((sample) => sample.live),
    });

    // NON-VACUITY: the counter really can see GPU-backed sources accumulate.
    expect(series.whileHeld, 'held bundles really did put sources on the GPU').toBeGreaterThan(
      series.baseline,
    );
    // And the release really did take them away again, outside the loop.
    expect(series.afterRelease, 'releasing the held bundles returned the count to baseline').toBe(
      series.baseline,
    );
    // Every cycle released what it loaded.
    expect(
      series.samples.every((sample) => sample.destroyed),
      'every handed-out texture is destroyed after its release',
    ).toBe(true);
    // The gate: no monotonic growth across twenty cycles.
    expect(
      series.samples.every((sample) => sample.live === series.baseline),
      `live GPU sources after each cycle: ${series.samples.map((sample) => sample.live).join(',')}`,
    ).toBe(true);
    // The heap is recorded, and gated only on "the last cycle is no worse than the
    // first". A linear leak and a bounded cache are indistinguishable in an estimate
    // that moves by hundreds of kilobytes between samples, so a trend gate on it
    // would be a coin flip; the direction is recorded either way.
    expect(
      last.heapKB,
      `heap after the last cycle (${last.heapKB} KiB) is no worse than after the first (${first.heapKB} KiB)`,
    ).toBeLessThanOrEqual(first.heapKB + 2_048);
  });
});

test.describe('the Audio settings panel is keyboard and screen-reader accessible', () => {
  for (const project of LANE.a11yProjects) {
    // The viewport comes from the support matrix and is applied with `test.use`, so
    // these tests use the ordinary `page` fixture rather than a second browser
    // context. That matters for more than tidiness: a second context left the
    // narrowest viewport running two contexts at once and blew the test timeout on
    // a run that is four seconds of work in isolation. It also means the
    // `beforeEach` egress blocker applies to the accessibility runs, so a scan
    // cannot quietly make an off-origin request.
    const entry = supportEntryForProject(project);
    test.describe(`at ${project}`, () => {
      test.use({ viewport: { ...entry.viewport }, hasTouch: entry.hasTouch });

      test('adds no new serious or critical violation and meets the touch target', async ({
        page,
      }, testInfo) => {
        await seedReturningLearner(page);
        await openWelcome(page);
        await enterGameWorld(page);
        await openAudioTab(page);

        // Scoped to the panel: the claim is about what Phase 10 added.
        const panel = await new AxeBuilder({ page })
          .include('.kd-audio-settings')
          .withTags([...WCAG_22_AA_TAGS])
          .analyze();
        const panelBlocking = panel.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .flatMap((violation) =>
            violation.nodes.map((node) => `${violation.id}|${violation.impact}|${node.target.join(' ')}`),
          );

        // Whole-page, so a pre-existing violation elsewhere is recorded separately
        // from anything the panel introduced.
        const wholePage = await new AxeBuilder({ page }).withTags([...WCAG_22_AA_TAGS]).analyze();
        const wholePageBlocking = wholePage.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .flatMap((violation) =>
            violation.nodes.map((node) => `${violation.id}|${violation.impact}|${node.target.join(' ')}`),
          );
        const known = (LANE.knownBlockingSignatures as readonly string[]).includes.bind(
          LANE.knownBlockingSignatures as readonly string[],
        );
        const knownBlocking = wholePageBlocking.filter((signature) => known(signature));
        const unexpectedBlocking = wholePageBlocking.filter((signature) => !known(signature));

        // The touch target measurement, scoped to the panel. The selector is the
        // repository's own: native controls plus the ARIA roles this panel uses.
        const targets = await page.evaluate((minimum: number) => {
          const audioPanel = document.querySelector('.kd-audio-settings');
          if (audioPanel === null) throw new Error('The audio panel is not mounted.');
          const selector =
            'a[href], button, input, select, textarea, summary, [role="tab"], [role="button"], [role="switch"]';
          const shortfalls: Array<{ selector: string; width: number; height: number }> = [];
          let measured = 0;
          for (const element of audioPanel.querySelectorAll(selector)) {
            if (element.hasAttribute('hidden') || element.closest('[hidden]')) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            measured += 1;
            if (rect.width >= minimum && rect.height >= minimum) continue;
            const tag = element.tagName.toLowerCase();
            shortfalls.push({
              selector: element.id ? `${tag}#${element.id}` : tag,
              width: Math.round(rect.width * 100) / 100,
              height: Math.round(rect.height * 100) / 100,
            });
          }
          return { measured, shortfalls };
        }, LANE.minimumTouchTargetPx);

        await attachJson(testInfo, `audio-panel-axe-${project}.json`, {
          project,
          viewport: entry.viewport,
          panelBlocking,
          knownBlocking,
          unexpectedBlocking,
          touchTargets: targets,
          minimumTouchTargetPx: LANE.minimumTouchTargetPx,
        });

        // The panel itself introduces nothing.
        expect(panelBlocking, `Blocking violations inside the audio panel: ${panelBlocking.join(' | ')}`).toEqual([]);
        // Anything elsewhere that is not the recorded exception still fails, so the
        // exception cannot widen by silence.
        expect(
          unexpectedBlocking,
          `Unexpected serious or critical violations elsewhere: ${unexpectedBlocking.join(' | ')}`,
        ).toEqual([]);
        // NON-VACUITY on the touch sweep: five controls were really measured.
        expect(targets.measured, 'the sweep really inspected the panel controls').toBeGreaterThanOrEqual(5);
        expect(
          targets.shortfalls,
          `Controls below ${LANE.minimumTouchTargetPx}px: ${JSON.stringify(targets.shortfalls)}`,
        ).toEqual([]);
      });
    });
  }

  test('every control is reachable and operable from the keyboard alone', async ({ page }) => {
    await seedReturningLearner(page);
    await openWelcome(page);
    await enterGameWorld(page);
    await openAudioTab(page);

    // The three switches are buttons, so Enter and Space work with no key handler
    // in the panel at all.
    const mute = page.locator('#settings-audio-mute');
    await expect(mute).toHaveAttribute('aria-checked', 'false');
    await mute.focus();
    await page.keyboard.press('Enter');
    await expect(mute, 'Enter activates the switch').toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Space');
    await expect(mute, 'Space activates the switch back').toHaveAttribute('aria-checked', 'false');

    // The sliders take arrow keys and Home/End from the platform, so the state
    // word, the value, and the stored preference move together.
    const music = page.locator('#settings-audio-music-volume');
    await music.focus();
    const start = Number(await music.inputValue());
    await page.keyboard.press('ArrowRight');
    await expect(music).toHaveValue(String(start + 1));
    await page.keyboard.press('End');
    await expect(music, 'Home/End is the platform behaviour, not a reimplementation').toHaveValue('100');
    await page.keyboard.press('Home');
    await expect(music).toHaveValue('0');

    // The name, the state, and the value are all exposed as text, not only colour.
    await expect(mute).toHaveAccessibleName('Mute all sound');
    await expect(music).toHaveAccessibleName('Music volume');
    await expect(music).toHaveAttribute('aria-valuetext', '0%');
    await expect(mute).toHaveAttribute('aria-describedby', 'settings-audio-mute-help');
  });
});
