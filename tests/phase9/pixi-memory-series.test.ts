/**
 * The Pixi world-host memory lane's decision logic, tested without a browser.
 *
 * ## Why this file exists
 *
 * The browser lane's interesting property is not what it reads - it is *which
 * shapes of series it fails on*. A gate that has only ever been pointed at a
 * healthy product has never been shown to notice an unhealthy one, and a browser
 * cannot be asked to produce a leaking run on demand: making one would mean
 * breaking the product. So the decision half of the lane
 * (`tests/e2e/pixi-memory-series.ts`, which imports nothing) is fed synthetic
 * series here, and the gate's teeth are known before it is pointed at anything.
 *
 * The four shapes below are the whole argument the lane makes:
 *
 * | Series                                   | Verdict | Why it is the interesting case |
 * |------------------------------------------|---------|-------------------------------|
 * | healthy: everything zero, everything one | pass    | the product as measured        |
 * | linear leak: one more of everything, k   | fail    | the defect class the plan names|
 * | bounded cache: rises, then flattens      | pass    | what a threshold alone would wrongly fail |
 * | rising again at the very end             | fail    | what a whole-run trend alone would wrongly pass |
 *
 * The last two are the pair the design question is about, and the third row is the
 * one a naive "did the number go up?" test gets wrong.
 *
 * This file is a NEW `tests/phase9/` test, owned by the QA change that added the
 * browser lane. It reads no product module, no fixture, and no build output, and it
 * runs in jsdom because none of it needs a DOM.
 */

import { describe, expect, it } from 'vitest';

import {
  MINIMUM_TAIL_SAMPLES,
  PIXI_MEMORY_CYCLES,
  SETTLED_FRAMES_NOTE,
  TAIL_WINDOW_FRACTION,
  evaluateIdleGrowth,
  evaluatePixiMemoryRun,
  leastSquaresSlope,
  tailOf,
  tailSlope,
  type PixiMemorySample,
} from '../e2e/pixi-memory-series';

/** One sample of a healthy run: one canvas, one application, everything released. */
function healthySample(cycle: number, overrides: Partial<PixiMemorySample> = {}): PixiMemorySample {
  return {
    cycle,
    liveCanvasCount: 1,
    liveCanvasBackingBytes: 1_622_016,
    applicationsCreated: cycle + 1,
    applicationsReleased: cycle,
    applicationsRetained: 1,
    liveRendererContext: 'webgl2',
    worldPresented: true,
    liveTickerElapsedMs: 1000 + cycle * 16,
    previousCanvas:
      cycle === 0
        ? null
        : { connected: false, contextKind: 'webgl2', contextLost: true },
    liveCanvasIsNew: cycle === 0 ? null : true,
    pixiVersion: '8.21.0',
    unmaskedRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
    surfaceSettledAtSample: true,
    heapUsedBytes: 10_000_000,
    domNodes: 96,
    jsEventListeners: 200,
    ...overrides,
  };
}

function runOf(sampleCount: number, build: (cycle: number) => PixiMemorySample) {
  return {
    baselineCanvasCount: 0,
    cycles: PIXI_MEMORY_CYCLES,
    samples: Array.from({ length: sampleCount }, (_unused, cycle) => build(cycle)),
  };
}

/** The 21 samples of a run that did exactly what it was asked. */
function healthyRun(): PixiMemorySample[] {
  return Array.from({ length: PIXI_MEMORY_CYCLES + 1 }, (_unused, cycle) => healthySample(cycle));
}

function codesOf(findings: ReadonlyArray<{ code: string }>): string[] {
  return findings.map((finding) => finding.code);
}

describe('the trend arithmetic', () => {
  it('reads the slope of a series against its own index', () => {
    expect(leastSquaresSlope([0, 1, 2, 3, 4])).toBeCloseTo(1, 10);
    expect(leastSquaresSlope([4, 3, 2, 1, 0])).toBeCloseTo(-1, 10);
    expect(leastSquaresSlope([7, 7, 7, 7])).toBeCloseTo(0, 10);
    // A single sample has no slope. Reporting a number for it would be a way of
    // reporting nothing, so it is 0 and the caller decides whether that is enough.
    expect(leastSquaresSlope([5])).toBe(0);
    expect(leastSquaresSlope([])).toBe(0);
  });

  it('takes the final third, which is the window a leak cannot flatten out of', () => {
    const series = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(series).toHaveLength(21);
    expect(tailOf(series)).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(tailOf(series)).toHaveLength(Math.ceil(21 * TAIL_WINDOW_FRACTION));
    // A leak that starts late: flat for nine cycles, then +1 per cycle. The
    // whole-run slope dilutes that to 0.64, while the tail slope recovers the
    // leak's actual rate of 1. That is the whole argument for judging the tail
    // rather than the run: the run's slope depends on when the leak started, and
    // a bounded cache's tail is flat whatever it did first.
    expect(tailSlope(series)).toBeCloseTo(1, 10);
    expect(leastSquaresSlope(series)).toBeCloseTo(0.64156, 5);
    expect(leastSquaresSlope(series)).toBeLessThan(tailSlope(series));
  });

  it('keeps a window big enough to decide something with', () => {
    expect(MINIMUM_TAIL_SAMPLES).toBeGreaterThanOrEqual(3);
    // The smallest window the analysis will judge, with a single +1 at its end:
    // a slope of 0.5, not a rounding error. That is what makes "any rise in the
    // tail" detectable at all rather than a threshold that has to be negotiated.
    expect(tailOf([0, 0, 0, 0, 0, 0, 1])).toHaveLength(3);
    expect(tailSlope([0, 0, 0, 0, 0, 0, 1])).toBeCloseTo(0.5, 10);
    expect(tailSlope([0, 0, 0, 0, 0, 0, 0])).toBe(0);
    // And the window a real 21-sample run uses: 7 samples, where one +1 at the end
    // is 3/28. Still unambiguously positive, and still nowhere near a bounded
    // cache's flat tail.
    const run = Array.from({ length: 21 }, (_unused, index) => index);
    expect(tailOf(run)).toHaveLength(7);
    const oneStepAtTheEnd = [...Array.from({ length: 20 }, () => 0), 1];
    expect(tailSlope(oneStepAtTheEnd)).toBeCloseTo(3 / 28, 10);
  });
});

describe('a run that did what it was asked to do', () => {
  it('produces no findings', () => {
    expect(evaluatePixiMemoryRun(runOf(PIXI_MEMORY_CYCLES + 1, () => healthySample(0)))).toEqual([]);
  });

  it('is not passing because it measured nothing', () => {
    // The baseline is read from Welcome, before any world exists. A run that never
    // established one cannot be compared against anything.
    const findings = evaluatePixiMemoryRun({
      baselineCanvasCount: -1,
      cycles: PIXI_MEMORY_CYCLES,
      samples: healthyRun(),
    });
    expect(codesOf(findings)).toContain('live-canvas-count');
  });
});

describe('a linear leak', () => {
  it('is caught by the retention thresholds, cycle by cycle', () => {
    // +1 canvas, +1 application and +1 live context per cycle: the shape of a
    // teardown that does not happen. Every cycle is wrong, not just the end.
    const findings = evaluatePixiMemoryRun(
      runOf(PIXI_MEMORY_CYCLES + 1, (cycle) =>
        healthySample(cycle, {
          liveCanvasCount: cycle + 1,
          applicationsCreated: cycle + 1,
          applicationsReleased: 0,
          applicationsRetained: cycle + 1,
          previousCanvas:
            cycle === 0 ? null : { connected: true, contextKind: 'webgl2', contextLost: false },
        }),
      ),
    );
    const codes = new Set(codesOf(findings));
    expect(codes).toContain('live-canvas-count');
    expect(codes).toContain('retained-canvas');
    expect(codes).toContain('retained-webgl-context');
    expect(codes).toContain('retained-application');
    // A leak is visible in the first cycle, not only at the end.
    expect(findings.some((finding) => finding.cycle === 1)).toBe(true);
    // Every cycle is reported, so a reader can see the slope rather than one number.
    expect(findings.filter((finding) => finding.code === 'retained-canvas')).toHaveLength(PIXI_MEMORY_CYCLES);
  });

  it('is caught by the tail trend when only the byte count moves', () => {
    // A host that released the element but kept a growing drawing surface: nothing
    // in the retention thresholds moves, so this is the counter that has to carry it.
    const findings = evaluatePixiMemoryRun(
      runOf(PIXI_MEMORY_CYCLES + 1, (cycle) =>
        healthySample(cycle, { liveCanvasBackingBytes: 1_000_000 * (cycle + 1) }),
      ),
    );
    expect(codesOf(findings)).toEqual(['backing-store-trending-up']);
  });
});

describe('a bounded cache, which is not a leak', () => {
  it('passes the tail trend that a leak would fail', () => {
    // Rises for the first four cycles, then holds. A whole-run trend would call this
    // a failure; a tail trend calls it what it is. This is the distinction the lane's
    // design rests on, and it is why the byte counter is judged on its tail.
    const steps = [1, 2, 3, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    const findings = evaluatePixiMemoryRun(
      runOf(PIXI_MEMORY_CYCLES + 1, (cycle) =>
        healthySample(cycle, { liveCanvasBackingBytes: 1_000_000 * steps[cycle] }),
      ),
    );
    expect(findings).toEqual([]);
  });

  it('is not judged at all while the surface is still moving', () => {
    // The series below is a perfect linear leak, and it is still not a verdict:
    // every sample's surface was mid-transient, so the bytes describe the browser's
    // observer timing rather than the product. The finding is the real one - the
    // surface never settled - and the trend arithmetic is not applied on top of it.
    const findings = evaluatePixiMemoryRun(
      runOf(PIXI_MEMORY_CYCLES + 1, (cycle) =>
        healthySample(cycle, {
          liveCanvasBackingBytes: 1_000_000 * (cycle + 1),
          surfaceSettledAtSample: false,
        }),
      ),
    );
    const codes = new Set(codesOf(findings));
    expect(codes).toContain('surface-not-settled');
    expect(codes).not.toContain('backing-store-trending-up');
    expect(findings.filter((entry) => entry.code === 'surface-not-settled')).toHaveLength(
      PIXI_MEMORY_CYCLES + 1,
    );
    expect(findings[0].message).toContain(String(SETTLED_FRAMES_NOTE));
  });

  it('still fails when the rise comes back at the end', () => {
    // The case a whole-run trend would have waved through: flat for twenty cycles,
    // then growing again. A leak that only starts leaking is still a leak.
    const steps = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6];
    const findings = evaluatePixiMemoryRun(
      runOf(PIXI_MEMORY_CYCLES + 1, (cycle) =>
        healthySample(cycle, { liveCanvasBackingBytes: 1_000_000 * steps[cycle] }),
      ),
    );
    expect(codesOf(findings)).toEqual(['backing-store-trending-up']);
  });
});

describe('a run that did not run', () => {
  it('is a failure rather than a pass, whatever the series looks like', () => {
    // The failure mode a lane that skipped would produce. Short of the required
    // sample count, the verdict is `unmeasured-run` and the series is not read at
    // all, so a beautiful flat series cannot stand in for a run that never happened.
    const findings = evaluatePixiMemoryRun(runOf(3, () => healthySample(0)));
    expect(codesOf(findings)).toEqual(['unmeasured-run']);
  });

  it('says so when a cycle did not actually remount the world', () => {
    const findings = evaluatePixiMemoryRun(
      runOf(PIXI_MEMORY_CYCLES + 1, (cycle) =>
        healthySample(cycle, cycle === 0 ? {} : { liveCanvasIsNew: false }),
      ),
    );
    expect(codesOf(findings)).toContain('cycle-did-not-remount');
    expect(findings.filter((finding) => finding.code === 'cycle-did-not-remount')).toHaveLength(
      PIXI_MEMORY_CYCLES,
    );
  });

  it('says so when a cycle never presented, and says why', () => {
    // The failure a timeout would have produced. A leaking host exhausts the
    // browser's contexts, the next world cannot start, and a lane that waited
    // politely would report a hang rather than the leak that caused it.
    const findings = evaluatePixiMemoryRun(
      runOf(PIXI_MEMORY_CYCLES + 1, (cycle) =>
        healthySample(cycle, {
          worldPresented: cycle < 15 ? true : false,
          liveCanvasCount: cycle < 15 ? 1 : 16,
          applicationsRetained: cycle < 15 ? 1 : 16,
        }),
      ),
    );
    const notPresented = findings.filter((entry) => entry.code === 'world-not-presented');
    expect(notPresented).toHaveLength(PIXI_MEMORY_CYCLES + 1 - 15);
    expect(notPresented[0].message).toContain('16 canvas(s)');
    expect(notPresented[0].message).toContain('16 application(s) alive');
    // And it does not replace the retention findings, which are the actual cause.
    expect(codesOf(findings)).toContain('live-canvas-count');
    expect(codesOf(findings)).toContain('retained-application');
  });

  it('says so when a renderer never obtained a context', () => {
    const findings = evaluatePixiMemoryRun(
      runOf(PIXI_MEMORY_CYCLES + 1, (cycle) => healthySample(cycle, { liveRendererContext: 'none' })),
    );
    expect(codesOf(findings)).toContain('no-renderer-context');
  });

  it('says so when a released context could not be read', () => {
    // An unreadable reading is not a passing reading. A lane that turned
    // "I could not measure the GPU release" into "no GPU release observed" would be
    // reporting a missing measurement as a result.
    const findings = evaluatePixiMemoryRun(
      runOf(PIXI_MEMORY_CYCLES + 1, (cycle) =>
        healthySample(cycle, {
          previousCanvas:
            cycle === 0 ? null : { connected: false, contextKind: 'webgl2', contextLost: null },
        }),
      ),
    );
    expect(codesOf(findings)).toContain('unmeasurable-webgl-context');
  });
});

describe('a world that grows while nothing is happening', () => {
  it('passes a settled surface', () => {
    expect(
      evaluateIdleGrowth({
        bytesBefore: 1_622_016,
        bytesAfter: 1_622_016,
        dwellFrames: 30,
        tickerTimeAdvancedMs: 500,
        cssHeightBefore: 72,
        cssHeightAfter: 72,
      }),
    ).toEqual([]);
  });

  it('fails a surface that grew during the dwell, and reports the numbers', () => {
    const findings = evaluateIdleGrowth({
      bytesBefore: 1_622_016,
      bytesAfter: 4_056_288,
      dwellFrames: 30,
      tickerTimeAdvancedMs: 500,
      cssHeightBefore: 72,
      cssHeightAfter: 180,
    });
    expect(codesOf(findings)).toEqual(['idle-surface-growth']);
    expect(findings[0].message).toContain('1622016');
    expect(findings[0].message).toContain('4056288');
    expect(findings[0].message).toContain('72');
    expect(findings[0].message).toContain('180');
  });

  it('refuses to conclude anything from a dwell in which the engine never ticked', () => {
    // Non-vacuity first. A growing surface in a world that presented no frame would
    // be measured differently, so a zero-frame dwell is a finding and not a pass.
    const findings = evaluateIdleGrowth({
      bytesBefore: 0,
      bytesAfter: 0,
      dwellFrames: 30,
      tickerTimeAdvancedMs: 0,
      cssHeightBefore: 0,
      cssHeightAfter: 0,
    });
    expect(codesOf(findings)).toEqual(['idle-did-not-render']);
  });

  it('refuses to conclude anything from an empty dwell', () => {
    expect(
      codesOf(
        evaluateIdleGrowth({
          bytesBefore: 0,
          bytesAfter: 0,
          dwellFrames: 0,
          tickerTimeAdvancedMs: 0,
          cssHeightBefore: 0,
          cssHeightAfter: 0,
        }),
      ),
    ).toEqual(['empty-dwell']);
  });

  it('cannot be satisfied by an unreadable ticker clock', () => {
    // `tickerTimeAdvancedMs: null` is "the ticker could not be read", not "zero frames".
    // The growth finding still has to be reachable, or a silent regression in the
    // probe would silence the gate.
    const findings = evaluateIdleGrowth({
      bytesBefore: 100,
      bytesAfter: 200,
      dwellFrames: 10,
      tickerTimeAdvancedMs: null,
      cssHeightBefore: 10,
      cssHeightAfter: 20,
    });
    expect(codesOf(findings)).toEqual(['idle-surface-growth']);
  });
});
