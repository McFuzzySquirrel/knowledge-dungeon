/**
 * The pure measurement arithmetic and the pass/fail verdict for the Phase 22
 * frame-time lane.
 *
 * Split from `pixiPerf.spec.ts` for the same reason `pixi-memory-series.ts` is split
 * from `pixiMemory.spec.ts`: the verdict is a function of numbers, and a pure function
 * is what `tests/e2e/pixi-perf-lane.test.ts` can drive with synthetic inputs to prove
 * the lane is **not vacuous** — that a run which rendered no frames, mounted no world,
 * never acknowledged an interaction, or dropped frames catastrophically is reported as
 * a finding rather than as a green measurement.
 *
 * ## Measurement, not certification
 *
 * Plan section 10.2 states the reference targets — 60 FPS, p95 frame time below 20 ms,
 * interaction acknowledgement under 100 ms — and the Phase 22 scope lock rules that
 * software-WebGL Chromium in CI is a **floor**, not a certification of those targets.
 * This module therefore carries two different numbers for every property:
 *
 * - the **reference target**, recorded in the evidence so a reader can compare the
 *   measurement with what the plan asks for; and
 * - the **CI regression floor**, which is deliberately far looser and exists only to
 *   turn a catastrophic regression — a world that has stopped rendering, or an
 *   interaction that takes a second — into a red run without pretending that a
 *   software rasteriser certified a real-GPU target.
 *
 * A finding is raised only against a floor. The reference targets are reported, never
 * gated, because gating them here would be exactly the false gate the scope lock
 * forbids.
 */

/** The plan's reference target, in milliseconds. Reported, never gated. */
export const REFERENCE_FRAME_TIME_P95_TARGET_MS = 20;
/** The plan's reference target frame rate. Reported, never gated. */
export const REFERENCE_FPS_TARGET = 60;
/** The plan's reference interaction-acknowledgement target, in milliseconds. */
export const REFERENCE_INTERACTION_ACK_TARGET_MS = 100;

/**
 * Animation frames the lane asks for before it stops sampling frame time.
 *
 * Three seconds at 60 Hz. Long enough that a p95 is a tail of a real distribution
 * rather than one slow frame, short enough that three room counts stay inside a
 * browser job's budget.
 */
export const PIXI_PERF_FRAME_SAMPLES = 180;

/**
 * The non-vacuity floor: the fewest frames a run may report and still be read as a
 * measurement.
 *
 * Two seconds at 30 Hz. A world that is actually rendering in a software rasteriser
 * clears this by a wide margin; a world that mounted a canvas and never drew — or a
 * page whose `requestAnimationFrame` loop was starved — does not. Below it the lane
 * reports `too-few-frames` and the run is the finding, rather than a p95 computed over
 * two samples being read as a fast world.
 */
export const PIXI_PERF_MIN_FRAMES = 60;

/**
 * The CI regression floor for p95 frame time, in milliseconds.
 *
 * **Twelve and a half times the reference target.** It is not the 20 ms target: a
 * software rasteriser in a headless container cannot certify a real-GPU number, and a
 * gate at 20 ms would be the false gate the scope lock names. It is set here with a
 * deliberate margin — a container with a software rasteriser has been observed at a
 * p95 near 33 ms, and a two-core CI runner is expected to be several times slower — so
 * that catching a *catastrophic* regression does not become a flake on a slow runner.
 * The measured value is reported beside it on every run.
 */
export const FRAME_TIME_P95_CI_FLOOR_MS = 250;

/**
 * The CI regression floor for mean frame rate.
 *
 * Three frames a second is not "smooth"; it is "not frozen". It exists so a run whose
 * frame *deltas* were all around the p95 floor still cannot pass on a single lucky
 * sample, and it is deliberately far below any healthy software-rendered value.
 */
export const MEAN_FPS_CI_FLOOR = 3;

/**
 * The CI regression floor for interaction acknowledgement, in milliseconds.
 *
 * **Fifteen times the reference target**, for the same reason as the frame-time floor.
 * A click that acknowledges in a tenth of a second is the target; a click that
 * acknowledges in over a second is a regression a person would notice, and the floor is
 * set to catch that rather than to certify the target.
 */
export const INTERACTION_ACK_CI_FLOOR_MS = 1500;

/** How many interaction acknowledgements the lane times, and reports the worst of. */
export const PIXI_PERF_INTERACTION_SAMPLES = 5;

export type PerfFindingCode =
  | 'world-never-presented'
  | 'no-canvas'
  | 'no-frames'
  | 'too-few-frames'
  | 'ticker-did-not-advance'
  | 'fixture-size-mismatch'
  | 'interaction-not-acknowledged'
  | 'frame-time-over-floor'
  | 'mean-fps-under-floor'
  | 'interaction-over-floor';

export interface PerfFinding {
  readonly code: PerfFindingCode;
  readonly message: string;
}

/** The numbers the lane measured, before any verdict is applied. */
export interface PerfMeasurement {
  readonly roomCount: number;
  readonly worldPresented: boolean;
  readonly canvasPresent: boolean;
  /** Every `requestAnimationFrame` delta, in milliseconds, in order. */
  readonly frameDeltasMs: readonly number[];
  /** The live ticker clock delta across the sampling window, or `null`. */
  readonly tickerAdvancedMs: number | null;
  /** The room rows the DOM offered, or `null` when the group was absent. */
  readonly domRoomCount: number | null;
  /** Every interaction acknowledgement latency, in milliseconds, in order. */
  readonly interactionLatenciesMs: readonly number[];
  /** Whether the last interaction changed the status text at all. */
  readonly interactionAcknowledged: boolean;
}

/** The reported summary of a measurement, floor-independent. */
export interface PerfSummary {
  readonly frameCount: number;
  readonly frameP50Ms: number | null;
  readonly frameP95Ms: number | null;
  readonly frameMaxMs: number | null;
  readonly meanFps: number | null;
  readonly tickerAdvancedMs: number | null;
  readonly domRoomCount: number | null;
  readonly interactionCount: number;
  readonly interactionMaxMs: number | null;
  readonly interactionP95Ms: number | null;
}

/**
 * The nearest-rank percentile of a numeric sample, or `null` for an empty one.
 *
 * Nearest-rank rather than interpolated: with a small, discrete sample the value a
 * reader wants is a frame time that actually occurred, not a value between two that
 * did. The sample is copied and sorted, so the caller's order is preserved for the
 * evidence.
 */
export function percentileOf(samples: readonly number[], fraction: number): number | null {
  if (samples.length === 0) return null;
  if (!(fraction >= 0 && fraction <= 1)) {
    throw new Error(`A percentile fraction must be in [0, 1], received ${String(fraction)}.`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank: ceil(p * N), clamped into [1, N], then converted to a 0-based index.
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1] as number;
}

/** The arithmetic mean of a non-empty sample, or `null` for an empty one. */
export function meanOf(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

/** Mean frames per second from frame deltas, or `null` when there is no usable sample. */
export function meanFpsOf(frameDeltasMs: readonly number[]): number | null {
  const positive = frameDeltasMs.filter((value) => Number.isFinite(value) && value > 0);
  const mean = meanOf(positive);
  return mean === null ? null : 1000 / mean;
}

/** Sum of a sample, used for the reported total window duration. */
export function sumOf(samples: readonly number[]): number {
  return samples.reduce((sum, value) => sum + value, 0);
}

/**
 * Reduce a measurement to the numbers the evidence record reports.
 *
 * Pure, so the wiring test can assert the summary of a synthetic run without a
 * browser.
 */
export function summarizePerfRun(measurement: PerfMeasurement): PerfSummary {
  return {
    frameCount: measurement.frameDeltasMs.length,
    frameP50Ms: percentileOf(measurement.frameDeltasMs, 0.5),
    frameP95Ms: percentileOf(measurement.frameDeltasMs, 0.95),
    frameMaxMs: percentileOf(measurement.frameDeltasMs, 1),
    meanFps: meanFpsOf(measurement.frameDeltasMs),
    tickerAdvancedMs: measurement.tickerAdvancedMs,
    domRoomCount: measurement.domRoomCount,
    interactionCount: measurement.interactionLatenciesMs.length,
    interactionMaxMs: percentileOf(measurement.interactionLatenciesMs, 1),
    interactionP95Ms: percentileOf(measurement.interactionLatenciesMs, 0.95),
  };
}

/**
 * Decide a run's findings from its measurement.
 *
 * `floors` is injectable so the wiring test can drive the exact CI thresholds, and the
 * defaults are the exported CI floors — which are deliberately **not** the reference
 * targets. The reference targets are never compared here; see the module header.
 */
export function evaluatePerfRun(
  measurement: PerfMeasurement,
  floors: {
    readonly minFrames?: number;
    readonly frameTimeP95Ms?: number;
    readonly meanFps?: number;
    readonly interactionAckMs?: number;
  } = {},
): readonly PerfFinding[] {
  const minFrames = floors.minFrames ?? PIXI_PERF_MIN_FRAMES;
  const frameP95Floor = floors.frameTimeP95Ms ?? FRAME_TIME_P95_CI_FLOOR_MS;
  const meanFpsFloor = floors.meanFps ?? MEAN_FPS_CI_FLOOR;
  const interactionFloor = floors.interactionAckMs ?? INTERACTION_ACK_CI_FLOOR_MS;

  const findings: PerfFinding[] = [];
  const summary = summarizePerfRun(measurement);

  if (!measurement.worldPresented) {
    findings.push({
      code: 'world-never-presented',
      message:
        `The ${measurement.roomCount}-room world entered the dungeon route but never reached its presented ` +
        'state, so no frame was drawn and no interaction was acknowledged. The run measured nothing.',
    });
  }
  if (!measurement.canvasPresent) {
    findings.push({
      code: 'no-canvas',
      message:
        `The ${measurement.roomCount}-room run found no PixiJS surface canvas in the document, so there was ` +
        'no world to render and this measurement describes no renderer.',
    });
  }
  if (measurement.frameDeltasMs.length === 0) {
    findings.push({
      code: 'no-frames',
      message:
        `The ${measurement.roomCount}-room run recorded zero animation frames. A run with no frames cannot ` +
        'distinguish a fast world from a still one, so this is a failure rather than a fast result.',
    });
  } else if (measurement.frameDeltasMs.length < minFrames) {
    findings.push({
      code: 'too-few-frames',
      message:
        `The ${measurement.roomCount}-room run recorded ${measurement.frameDeltasMs.length} frame(s), below the ` +
        `${minFrames}-frame non-vacuity floor. A p95 over so few samples is not a measurement.`,
    });
  }
  if (measurement.frameDeltasMs.length > 0 && (measurement.tickerAdvancedMs ?? 0) <= 0) {
    findings.push({
      code: 'ticker-did-not-advance',
      message:
        `The ${measurement.roomCount}-room world's PixiJS ticker clock did not advance across the sampling ` +
        'window, so the animation loop was not running even though frames were observed.',
    });
  }
  if (
    measurement.domRoomCount !== null &&
    measurement.domRoomCount !== measurement.roomCount
  ) {
    findings.push({
      code: 'fixture-size-mismatch',
      message:
        `The ${measurement.roomCount}-room fixture rendered ${measurement.domRoomCount} room row(s), so the ` +
        'world that was measured is not the world the fixture asked for.',
    });
  }
  if (!measurement.interactionAcknowledged || measurement.interactionLatenciesMs.length === 0) {
    findings.push({
      code: 'interaction-not-acknowledged',
      message:
        `The ${measurement.roomCount}-room run dispatched a world interaction and the DOM mirror never ` +
        'acknowledged it, so the interaction-latency target is unmeasured rather than met.',
    });
  }
  if (summary.frameP95Ms !== null && summary.frameP95Ms > frameP95Floor) {
    findings.push({
      code: 'frame-time-over-floor',
      message:
        `The ${measurement.roomCount}-room run's p95 frame time is ${summary.frameP95Ms.toFixed(2)} ms, over the ` +
        `${frameP95Floor} ms CI regression floor. This is a catastrophic-regression finding, not a reference-target ` +
        `verdict (the plan's target is ${REFERENCE_FRAME_TIME_P95_TARGET_MS} ms and is not certified here).`,
    });
  }
  if (summary.meanFps !== null && summary.meanFps < meanFpsFloor) {
    findings.push({
      code: 'mean-fps-under-floor',
      message:
        `The ${measurement.roomCount}-room run averaged ${summary.meanFps.toFixed(2)} FPS, under the ${meanFpsFloor} ` +
        'FPS CI regression floor.',
    });
  }
  if (summary.interactionMaxMs !== null && summary.interactionMaxMs > interactionFloor) {
    findings.push({
      code: 'interaction-over-floor',
      message:
        `The ${measurement.roomCount}-room run's slowest interaction acknowledged in ${summary.interactionMaxMs.toFixed(2)} ms, ` +
        `over the ${interactionFloor} ms CI regression floor (the plan's target is ` +
        `${REFERENCE_INTERACTION_ACK_TARGET_MS} ms and is not certified here).`,
    });
  }

  return findings;
}

/** A bounded one-line description of a finding list, for a failure message. */
export function describePerfFindings(findings: readonly PerfFinding[]): string {
  if (findings.length === 0) return '';
  return findings.map((finding) => `[${finding.code}] ${finding.message}`).join('\n');
}
