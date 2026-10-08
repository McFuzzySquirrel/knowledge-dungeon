/**
 * The Phase 9 Pixi world-host memory measurement, as pure data.
 *
 * ## Why this module exists
 *
 * `pixiMemory.spec.ts` drives a browser. This module decides what the numbers it
 * read mean, and it imports nothing - no Playwright, no filesystem, no network, no
 * globals. That split is deliberate and it is what makes the *decision* testable:
 * the interesting question about a memory gate is not "what did the browser say"
 * but "which shapes of series does this gate fail on", and a browser cannot be
 * asked to produce a leaking series on demand. `tests/phase9/pixi-memory-series.test.ts`
 * feeds this module synthetic series - a linear leak, a bounded cache, a run that
 * was never measured - and asserts the verdicts, so the gate's teeth are known
 * before it is ever pointed at a product.
 *
 * ## Trend or threshold, and why it is mostly threshold
 *
 * Plan section 10.2 asks for "no material canvas or GPU memory growth over 20
 * world mount and unmount cycles". A linear leak and a bounded cache both produce
 * a rising number over 20 cycles, so a test that only watched for a rising number
 * could not tell them apart, and would have to either accept a slow leak forever
 * or fail a healthy cache. The way out is to notice that *most* of the quantities
 * here are not "how much" but "how many", and the correct answer to "how many
 * canvases from earlier cycles are still in the document" is **zero** - not a
 * small number, not a plateau.
 *
 * So the gate is:
 *
 * - a **threshold** wherever the correct value is a known constant, because that is
 *   a strictly stronger statement than a trend and needs no tolerance: exactly
 *   `baseline + 1` canvas in the document while a world is mounted, exactly zero
 *   canvases retained from any earlier cycle, exactly one PixiJS `Application` alive
 *   (the one that is mounted), and every one of the 20 released renderers with its
 *   WebGL context explicitly lost;
 * - a **tail trend** only where a correct run legitimately has a transient: the
 *   live canvas's backing-store size. A first mount can resize once as the surface
 *   settles, so comparing sample 0 with sample 20 would be comparing a transient
 *   with a steady state. The question there is not "did it ever rise" but "is it
 *   *still* rising at the end", and {@link tailSlope} answers exactly that over the
 *   final third of the run. A linear leak cannot flatten; a bounded cache does,
 *   which is the whole of the distinction the plan's wording leaves open.
 *
 * The recorded-only counters (JavaScript heap, Chromium's own `Nodes` and
 * `JSEventListeners` estimates) are shaped by the same ambiguity and are therefore
 * measured, reported, and deliberately **not** gated. See `doesNotProve` in
 * `pixi-memory-lane.ts`.
 */

/**
 * How far apart the two readings of a mounted world's surface are, in animation
 * frames. Named here because the `surface-not-settled` finding quotes it, and a
 * finding that quoted a number its reader could not look up would be a worse
 * finding than one that named the test instead.
 */
export const SETTLED_FRAMES_NOTE = 8;

/**
 * Plan section 10.2's cycle count, and the number `scripts/check-memory.mjs`
 * prints as the runtime measurement it cannot make. The two are pinned against
 * each other by `tests/e2e/pixi-memory-lane.test.ts`, because a lane that quietly
 * used a different count would answer a question nobody asked.
 */
export const PIXI_MEMORY_CYCLES = 20;

/**
 * The final fraction of the run the tail trend is computed over.
 *
 * A third, not a half: a window of 7 samples out of 21 is enough for a +1-per-cycle
 * leak to be unambiguously positive (its least-squares slope is 3/28 ≈ 0.107) while
 * still leaving the first two thirds to absorb a mount transient. A window of two
 * samples would be a coin flip on noise; a window of the whole run is the thing the
 * plan's wording already rules out.
 */
export const TAIL_WINDOW_FRACTION = 1 / 3;

/** The smallest tail this analysis will judge. Below it, a verdict would be noise. */
export const MINIMUM_TAIL_SAMPLES = 3;

/** Which rendering context the mounted world actually obtained. */
export type RendererContextKind = 'webgl2' | 'webgl' | 'canvas2d' | 'none';

/** What the previous cycle's canvas looks like now that its world has been torn down. */
export interface PreviousCanvasReading {
  /** Still attached to the document. Must be `false` after teardown. */
  readonly connected: boolean;
  /** The context kind the previous cycle's renderer had obtained. */
  readonly contextKind: RendererContextKind;
  /**
   * `WebGLRenderingContext.isContextLost()` for the previous cycle's context.
   *
   * `null` when there was no WebGL context to ask, which is recorded rather than
   * treated as a pass: a run whose renderer never obtained WebGL has not measured
   * the GPU release this gate is about.
   */
  readonly contextLost: boolean | null;
}

/** One sample: the state of the world and the document after a mount settled. */
export interface PixiMemorySample {
  /** `0` is the first mount, reached by entering the world. `1..N` are the cycles. */
  readonly cycle: number;
  /** `<canvas>` elements attached to the document at the sample instant. */
  readonly liveCanvasCount: number;
  /** `sum(canvas.width * canvas.height * 4)` over the document's canvases. */
  readonly liveCanvasBackingBytes: number;
  /** PixiJS `Application` objects the page has been told about, cumulatively. */
  readonly applicationsCreated: number;
  /** Of those, how many have had `renderer` and `stage` nulled by their own destroy. */
  readonly applicationsReleased: number;
  /** `created - released`. Exactly one while a world is mounted, if teardown is total. */
  readonly applicationsRetained: number;
  /** The context kind of the currently mounted world's canvas. */
  readonly liveRendererContext: RendererContextKind;
  /**
   * Whether this cycle's world reached the presented state.
   *
   * `false` is a finding, not a wait. A host that leaks a renderer per cycle
   * eventually exhausts the browser's contexts, and a lane that waits politely for a
   * world that can no longer start reports a timeout - which says nothing about the
   * leak that caused it. The measurement decides, and this is how it says so.
   */
  readonly worldPresented: boolean | null;
  /** `Ticker.elapsedMS` of the mounted application, to prove frames were presented. */
  readonly liveTickerElapsedMs: number | null;
  /** The previous cycle's canvas, or `null` on the first sample. */
  readonly previousCanvas: PreviousCanvasReading | null;
  /**
   * Whether the mounted canvas is a different element from the previous sample's.
   *
   * The lane's non-vacuity control: a cycle that did not actually remount would
   * leave this `false`, and every other reading on that sample would be about the
   * same world rather than a new one.
   */
  readonly liveCanvasIsNew: boolean | null;
  /** The PixiJS version string, from PixiJS's own init hook. */
  readonly pixiVersion: string | null;
  /** The unmasked WebGL renderer string, recorded once. */
  readonly unmaskedRenderer: string | null;
  /**
   * Whether the live canvas's backing store was the same size at two readings a
   * fixed number of frames apart, both after the world had presented.
   *
   * This is the sample's own measurability, and it is what decides whether the
   * backing-store trend below is a verdict or a reading of the harness. A world
   * whose surface is still resizing has not reached a size, so the byte count
   * sampled on it is a snapshot of a transient whose extent depends on how many
   * observer deliveries the browser happened to make in a fixed dwell. Trend
   * arithmetic over that is a measurement of the harness, not of the product, and
   * `evaluatePixiMemoryRun` says so by reporting `surface-not-settled` instead.
   */
  readonly surfaceSettledAtSample: boolean | null;
  /** `performance.memory.usedJSHeapSize`, recorded only, never gated. */
  readonly heapUsedBytes: number | null;
  /** Chromium's `Performance.getMetrics` `Nodes` estimate. Recorded only. */
  readonly domNodes: number | null;
  /** Chromium's `Performance.getMetrics` `JSEventListeners` estimate. Recorded only. */
  readonly jsEventListeners: number | null;
}

export interface PixiMemoryFinding {
  /** A bounded, machine-comparable code. Never a sentence a learner could be shown. */
  readonly code: string;
  /** The cycle the finding belongs to, or `null` for a whole-run finding. */
  readonly cycle: number | null;
  readonly message: string;
}

export interface PixiMemoryRunInput {
  /** Live canvases in the document before the world is ever entered. */
  readonly baselineCanvasCount: number;
  /** The cycle count the run was asked to perform. */
  readonly cycles: number;
  /** One sample per mount: the first mount, then one per cycle. */
  readonly samples: readonly PixiMemorySample[];
}

/* -------------------------------------------------------------------------- */
/* Trend arithmetic                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The least-squares slope of a series against its own index.
 *
 * Closed form, no fitting library, and defined for a single sample as `0` rather
 * than as `NaN`: a one-sample tail has no slope, and reporting a number for it
 * would be a way of reporting nothing.
 */
export function leastSquaresSlope(series: readonly number[]): number {
  const n = series.length;
  if (n < 2) return 0;
  const meanIndex = (n - 1) / 2;
  const mean = series.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    const offset = index - meanIndex;
    numerator += offset * (series[index] - mean);
    denominator += offset * offset;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** The final `Math.ceil(series.length * fraction)` samples of a series. */
export function tailOf(
  series: readonly number[],
  fraction: number = TAIL_WINDOW_FRACTION,
): number[] {
  const size = Math.max(1, Math.ceil(series.length * fraction));
  return series.slice(series.length - size);
}

/** The slope of the final third of a series: is it *still* rising at the end? */
export function tailSlope(
  series: readonly number[],
  fraction: number = TAIL_WINDOW_FRACTION,
): number {
  return leastSquaresSlope(tailOf(series, fraction));
}

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                    */
/* -------------------------------------------------------------------------- */

function finding(code: string, cycle: number | null, message: string): PixiMemoryFinding {
  return { code, cycle, message };
}

/**
 * Everything wrong with a run, as a list. Empty means the run passed.
 *
 * Ordered so the first finding a failing run reports is the most structural one:
 * an unmeasured run, a run that never remounted, a retained resource, and only then
 * a trending counter. A gate that reports "the backing store grew" when the real
 * problem is that the world never mounted has put the reader in the wrong place.
 */
export function evaluatePixiMemoryRun(input: PixiMemoryRunInput): PixiMemoryFinding[] {
  const findings: PixiMemoryFinding[] = [];
  const { baselineCanvasCount, cycles, samples } = input;
  const expectedSamples = cycles + 1;

  if (samples.length !== expectedSamples) {
    findings.push(
      finding(
        'unmeasured-run',
        null,
        `The run produced ${samples.length} sample(s) for ${cycles} cycles; ${expectedSamples} are required, ` +
          'so the criterion is unmeasured rather than met.',
      ),
    );
    return findings;
  }

  for (const sample of samples) {
    const where = `cycle ${sample.cycle}`;

    if (sample.liveCanvasIsNew === false) {
      findings.push(
        finding(
          'cycle-did-not-remount',
          sample.cycle,
          `${where}: the world host did not create a new canvas, so this cycle is the same world measured ` +
            'twice and proves nothing about a mount or an unmount.',
        ),
      );
    }

    if (sample.worldPresented === false) {
      findings.push(
        finding(
          'world-not-presented',
          sample.cycle,
          `${where}: the world never presented after this cycle, and the document holds ` +
            `${sample.liveCanvasCount} canvas(s) with ${sample.applicationsRetained} application(s) alive. A host ` +
            'that releases its renderer per cycle cannot run out of contexts, so this is the end state of the ' +
            'retained resources reported above rather than a separate problem.',
        ),
      );
    }

    if (sample.liveRendererContext === 'none') {
      findings.push(
        finding(
          'no-renderer-context',
          sample.cycle,
          `${where}: the world canvas has no drawing context at all, so no renderer was exercised.`,
        ),
      );
    }

    if (sample.liveCanvasCount !== baselineCanvasCount + 1) {
      findings.push(
        finding(
          'live-canvas-count',
          sample.cycle,
          `${where}: the document holds ${sample.liveCanvasCount} canvas element(s) while one world is mounted; ` +
            `the baseline is ${baselineCanvasCount} and a mounted world adds exactly one.`,
        ),
      );
    }

    if (sample.applicationsCreated !== sample.cycle + 1) {
      findings.push(
        finding(
          'application-created-count',
          sample.cycle,
          `${where}: PixiJS reports ${sample.applicationsCreated} application(s) created; a mount per cycle ` +
            `requires ${sample.cycle + 1}.`,
        ),
      );
    }

    if (sample.applicationsRetained !== 1) {
      findings.push(
        finding(
          'retained-application',
          sample.cycle,
          `${where}: ${sample.applicationsRetained} PixiJS application(s) are still alive ` +
            `(created ${sample.applicationsCreated}, released ${sample.applicationsReleased}). One is mounted; ` +
            'every earlier one must have released its renderer and its stage.',
        ),
      );
    }

    if (sample.surfaceSettledAtSample === false) {
      findings.push(
        finding(
          'surface-not-settled',
          sample.cycle,
          `${where}: the live canvas's backing store was still changing ${SETTLED_FRAMES_NOTE} frames after the ` +
            'world presented, so this cycle is measured mid-transient. The world surface is resizing itself while ' +
            'nothing about the page changes; the per-cycle byte count below is therefore recorded, not judged.',
        ),
      );
    }

    const previous = sample.previousCanvas;
    if (previous === null) {
      if (sample.cycle > 0) {
        findings.push(
          finding('previous-canvas-unread', sample.cycle, `${where}: the previous cycle's canvas was not read.`),
        );
      }
      continue;
    }

    if (previous.connected) {
      findings.push(
        finding(
          'retained-canvas',
          sample.cycle,
          `${where}: the previous cycle's canvas is still attached to the document after its world was torn down.`,
        ),
      );
    }

    if (previous.contextLost === false) {
      findings.push(
        finding(
          'retained-webgl-context',
          sample.cycle,
          `${where}: the previous cycle's WebGL context is still live after its renderer was destroyed.`,
        ),
      );
    }
    if (previous.contextLost === null && (previous.contextKind === 'webgl2' || previous.contextKind === 'webgl')) {
      findings.push(
        finding(
          'unmeasurable-webgl-context',
          sample.cycle,
          `${where}: the previous cycle's WebGL context could not be read after teardown, so its release is ` +
            'unmeasured rather than observed.',
        ),
      );
    }
  }

  // The one counter with a legitimate mount transient, judged on whether it is
  // *still* rising. It is only judged at all when every sample's surface settled:
  // a trend over a series taken mid-transient describes the browser's observer
  // timing, and a gate that fired on it would be a coin flip dressed as a verdict.
  const backingBytes = samples.map((sample) => sample.liveCanvasBackingBytes);
  const everySampleSettled = samples.every((sample) => sample.surfaceSettledAtSample !== false);
  if (
    everySampleSettled &&
    tailOf(backingBytes).length >= MINIMUM_TAIL_SAMPLES &&
    tailSlope(backingBytes) > 0
  ) {
    findings.push(
      finding(
        'backing-store-trending-up',
        null,
        `The live canvas's backing store is still growing at the end of the run: ` +
          `${backingBytes[0]} -> ${backingBytes[backingBytes.length - 1]} bytes over ${cycles} cycles, with a ` +
          `positive slope across the final ${tailOf(backingBytes).length} samples. A surface that settles and a ` +
          'surface that leaks are indistinguishable by their first reading; only the tail tells them apart.',
      ),
    );
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Idle growth                                                                 */
/* -------------------------------------------------------------------------- */

export interface IdleGrowthInput {
  /** The mounted world's canvas backing-store bytes after it settled. */
  readonly bytesBefore: number;
  /** The same reading after the world was left alone for the dwell. */
  readonly bytesAfter: number;
  /** Animation frames the world was left alone for. */
  readonly dwellFrames: number;
  /** The mounted canvas's CSS height before and after, for the message. */
  readonly cssHeightBefore: number;
  readonly cssHeightAfter: number;
  /**
   * How far the mounted renderer's ticker clock advanced during the dwell, in
   * milliseconds, or `null` when it could not be read.
   *
   * This is the non-vacuity control, and it is a clock rather than a frame count
   * because a `Ticker` in PixiJS 8 exposes no cumulative frame counter: it exposes
   * `lastTime`, the `performance.now()` of its most recent tick, which advances only
   * while it is actually ticking. A dwell in which that clock did not move is a
   * dwell in which the engine drew nothing, and a growing surface in it would not
   * have been observed.
   */
  readonly tickerTimeAdvancedMs: number | null;
}

/**
 * Verdicts on a world that was mounted, presented, and then left alone.
 *
 * A separate verdict because it is a different defect with a different blast
 * radius: nothing is *retained* here, so a 20-cycle retention series reads clean,
 * while the surface the world draws into grows without bound for as long as the
 * world stays open. A gate that only ever sampled across cycles would never see
 * it, because each cycle starts from a fresh surface.
 */
export function evaluateIdleGrowth(input: IdleGrowthInput): PixiMemoryFinding[] {
  const findings: PixiMemoryFinding[] = [];
  const { bytesBefore, bytesAfter, dwellFrames, tickerTimeAdvancedMs } = input;

  if (dwellFrames < 1) {
    findings.push(
      finding('empty-dwell', null, 'The idle dwell was zero frames, so nothing was measured.'),
    );
    return findings;
  }
  if (tickerTimeAdvancedMs !== null && tickerTimeAdvancedMs < 1) {
    findings.push(
      finding(
        'idle-did-not-render',
        null,
        `The mounted renderer's ticker clock did not advance during a ${dwellFrames}-frame dwell, so the engine ` +
          'presented nothing and a growing surface would not have been observed. The byte readings below prove ' +
          'nothing on their own.',
      ),
    );
  }

  if (bytesAfter > bytesBefore) {
    findings.push(
      finding(
        'idle-surface-growth',
        null,
        `A world that was already presented grew its drawing surface while nothing changed: ` +
          `${bytesBefore} -> ${bytesAfter} bytes (${input.cssHeightBefore} -> ${input.cssHeightAfter} CSS pixels ` +
          `tall) across ${dwellFrames} idle frames. A renderer resizes when the element it draws into resizes, ` +
          'so this is the element and the measurement disagreeing with each other, not the world animating.',
      ),
    );
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Route-transition memory                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What one mount/unmount cycle *within the same component* cannot see.
 *
 * The twenty-cycle verdict above turns a `prefers-reduced-motion` flip into twenty
 * host rebuilds. That is a real teardown, but it is a teardown *and immediately a
 * mount of the same world in the same route*: every sample sees exactly one live
 * canvas and exactly one retained application, and the document never holds a
 * different world's renderer. A learner navigating from the village into the
 * dungeon, or from the village into the fishing pond, exercises a different edge -
 * React unmounts one screen's host, the next screen mounts its own - and the defect
 * that edge admits is a canvas, a WebGL context, or an `Application` that outlives
 * the route it belonged to. Nothing in the twenty-cycle verdict can fail on it.
 *
 * So this is a second verdict, over a second sample shape, for a second question.
 * It is deliberately *not* a generalisation of {@link evaluatePixiMemoryRun}: that
 * function's `applicationsCreated === cycle + 1` invariant is true of a series where
 * every sample mounts exactly one renderer, and a route walk includes samples where
 * no renderer is created at all.
 */

/** The world a route left, as it looks after the route changed. */
export interface RouteWorldRelease {
  /** A short identifier for the world that was left, for the finding message. */
  readonly world: string;
  /** Its `<canvas>` is still attached to the document. Must be `false`. */
  readonly canvasConnected: boolean;
  /** The context kind its renderer had obtained. */
  readonly contextKind: RendererContextKind;
  /** `isContextLost()` for its context, or `null` when there was none to ask. */
  readonly contextLost: boolean | null;
}

/**
 * One sample: a world that is mounted right now, and the world the route replaced.
 *
 * `expectedLiveCanvasCount` is the number of canvases the document is allowed to
 * hold at this instant - the non-world canvases plus, for each Pixi world mounted in
 * the route, exactly one. It is a parameter rather than a constant because the Phaser
 * village draws a canvas of its own and the Pixi fishing pond is an *overlay* over
 * the village rather than a replacement for it, so "return to baseline" is 1 after
 * the dungeon and 1 again after the pond, but 2 while the pond is open.
 */
export interface RouteMemorySample {
  readonly step: number;
  /** The world mounted at this sample. */
  readonly world: string;
  readonly worldPresented: boolean;
  readonly liveCanvasCount: number;
  readonly expectedLiveCanvasCount: number;
  readonly applicationsCreated: number;
  readonly applicationsReleased: number;
  readonly applicationsRetained: number;
  /**
   * Whether a PixiJS world is mounted at this sample.
   *
   * `false` for the village sample that follows the dungeon on this lane's artifact,
   * where the village is the Phaser one and holds no PixiJS application. The
   * "one application retained" assertion only applies to a sample that claims a Pixi
   * world; a route that legitimately holds none must not be failed for holding none.
   */
  readonly expectsPixiApplication: boolean;
  /** Whether the mounted canvas is a different element from the previous sample's. */
  readonly liveCanvasIsNew: boolean | null;
  /** The world the route replaced, or `null` for the first sample. */
  readonly previous: RouteWorldRelease | null;
}

/**
 * Everything wrong with a route walk, as a list. Empty means the walk passed.
 *
 * The assertions are per transition and independent: a world that was left with its
 * canvas still attached and a world that was left with its context still live are
 * two findings, because they are two different owners (the DOM and the GPU) and a
 * fix for one need not touch the other.
 */
export function evaluateRouteMemoryRun(samples: readonly RouteMemorySample[]): PixiMemoryFinding[] {
  const findings: PixiMemoryFinding[] = [];
  if (samples.length === 0) {
    findings.push(
      finding(
        'unmeasured-route-run',
        null,
        'The route walk produced no samples, so no transition was measured and this criterion is ' +
          'unmeasured rather than met.',
      ),
    );
    return findings;
  }

  for (const sample of samples) {
    const where = `step ${sample.step} (${sample.world})`;

    if (sample.liveCanvasIsNew === false) {
      findings.push(
        finding(
          'route-did-not-remount',
          sample.step,
          `${where}: the route did not create a new canvas, so this sample is the previous world ` +
            'measured again and proves nothing about a route change.',
        ),
      );
    }
    if (!sample.worldPresented) {
      findings.push(
        finding(
          'world-not-presented',
          sample.step,
          `${where}: the world the route reached never presented, so this transition was not observed ` +
            'from a live world.',
        ),
      );
    }
    if (sample.liveCanvasCount !== sample.expectedLiveCanvasCount) {
      findings.push(
        finding(
          'canvas-count-mismatch',
          sample.step,
          `${where}: the document holds ${sample.liveCanvasCount} canvas(es); the route expects ` +
            `${sample.expectedLiveCanvasCount}. A quantity retained by a world the route left is the ` +
            'usual cause.',
        ),
      );
    }
    if (sample.expectsPixiApplication && sample.applicationsRetained < 1) {
      findings.push(
        finding(
          'no-application-retained',
          sample.step,
          `${where}: no PixiJS application is alive while a Pixi world is mounted, so the renderer this ` +
            'sample is about was never measured.',
        ),
      );
    }
    if (sample.applicationsReleased > sample.applicationsCreated) {
      findings.push(
        finding(
          'release-count-exceeds-creation',
          sample.step,
          `${where}: ${sample.applicationsReleased} application(s) were released of ` +
            `${sample.applicationsCreated} created, which cannot both be true.`,
        ),
      );
    }

    const previous = sample.previous;
    // `null` is a normal value: a route can arrive at a Pixi world from a screen that
    // held no Pixi world at all (the Phaser village, on this lane's artifact), and
    // that transition has no Pixi release to assert.
    if (previous === null) continue;

    if (previous.canvasConnected) {
      findings.push(
        finding(
          'retained-canvas',
          sample.step,
          `${where}: the world the route left (${previous.world}) still has its canvas attached to the ` +
            'document.',
        ),
      );
    }
    if (previous.contextLost === false) {
      findings.push(
        finding(
          'retained-webgl-context',
          sample.step,
          `${where}: the world the route left (${previous.world}) still has a live WebGL context after ` +
            'its renderer was destroyed.',
        ),
      );
    }
    if (
      previous.contextLost === null &&
      (previous.contextKind === 'webgl2' || previous.contextKind === 'webgl')
    ) {
      findings.push(
        finding(
          'unmeasurable-webgl-context',
          sample.step,
          `${where}: the context of the world the route left (${previous.world}) could not be read after ` +
            'teardown, so its release is unmeasured rather than observed.',
        ),
      );
    }
  }

  return findings;
}
