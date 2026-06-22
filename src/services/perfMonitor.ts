/**
 * Performance monitoring utilities for Knowledge Dungeon.
 *
 * Phase 5: Quality & Scale — Performance optimization.
 * Provides FPS tracking, memory usage estimation, and profiling helpers.
 */

export interface FpsStats {
  fps: number;
  frameTime: number;
  minFps: number;
  maxFps: number;
  samples: number;
}

/**
 * Lightweight FPS tracker using requestAnimationFrame with optional
 * moving-average smoothing. Designed to have negligible overhead so it
 * can remain enabled during gameplay.
 */
export class FpsMonitor {
  private lastTime = 0;
  private frameCount = 0;
  private accumulatedTime = 0;
  private currentFps = 60;
  private frameTime = 16;
  private minFps = Number.POSITIVE_INFINITY;
  private maxFps = 0;
  private smoothingAlpha = 0.1;
  private running = false;
  private rafId = 0;

  /** Start monitoring frames. Safe to call multiple times. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(() => this.tick());
  }

  /** Stop monitoring. */
  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** Get current stats snapshot without stopping. */
  snapshot(): FpsStats {
    return {
      fps: Math.round(this.currentFps),
      frameTime: Math.round(this.frameTime * 100) / 100,
      minFps: this.minFps === Number.POSITIVE_INFINITY ? 0 : Math.round(this.minFps),
      maxFps: Math.round(this.maxFps),
      samples: this.frameCount,
    };
  }

  reset(): void {
    this.minFps = Number.POSITIVE_INFINITY;
    this.maxFps = 0;
    this.frameCount = 0;
    this.accumulatedTime = 0;
  }

  private tick(): void {
    if (!this.running) return;
    const now = performance.now();
    const delta = now - this.lastTime;
    this.lastTime = now;

    if (delta > 0 && delta < 500) {
      this.frameTime =
        this.frameTime * (1 - this.smoothingAlpha) + delta * this.smoothingAlpha;
      const instantFps = 1000 / delta;

      if (instantFps < this.minFps) this.minFps = instantFps;
      if (instantFps > this.maxFps) this.maxFps = instantFps;

      this.frameCount += 1;
      this.accumulatedTime += delta;

      // Recalculate every 30 frames for stability
      if (this.frameCount % 30 === 0 && this.accumulatedTime > 0) {
        this.currentFps = (this.frameCount / this.accumulatedTime) * 1000;
      }
    }

    this.rafId = requestAnimationFrame(() => this.tick());
  }
}

/**
 * Returns true if the browser supports the Performance API memory extension
 * (Chrome-only). Returns estimated JS heap size in bytes or null.
 */
export function getJsHeapSize(): number | null {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
  return perf.memory?.usedJSHeapSize ?? null;
}

/**
 * Conservative estimate of localStorage usage in bytes.
 * Iterates all keys under our prefix and sums their lengths.
 */
export function estimateLocalStorageUsage(): number {
  let total = 0;
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith('knowledge-dungeon:')) {
          const value = localStorage.getItem(key);
          if (value) {
            total += key.length + value.length;
          }
        }
      }
    }
  } catch {
    // localStorage unavailable
  }
  return total;
}

/**
 * Estimate whether we are approaching the localStorage quota (typically 5-10 MB).
 * Returns a 0-1 value where 1 means full and 0 means empty.
 */
export function estimateStorageFullness(): number {
  const used = estimateLocalStorageUsage();
  // Conservative 5MB threshold
  const limit = 5 * 1024 * 1024;
  return Math.min(1, used / limit);
}
