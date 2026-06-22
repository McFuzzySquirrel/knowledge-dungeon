/**
 * Phase 5: Unit tests for performance monitoring.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FpsMonitor, estimateLocalStorageUsage, estimateStorageFullness } from '@/services/perfMonitor';

describe('FpsMonitor', () => {
  let monitor: FpsMonitor;

  beforeEach(() => {
    monitor = new FpsMonitor();
  });

  it('starts with default values', () => {
    const stats = monitor.snapshot();
    expect(stats.fps).toBeGreaterThanOrEqual(0);
    expect(stats.frameTime).toBeGreaterThanOrEqual(0);
    expect(stats.samples).toBe(0);
  });

  it('can start and stop without errors', () => {
    expect(() => monitor.start()).not.toThrow();
    expect(() => monitor.stop()).not.toThrow();
  });

  it('reset clears accumulated data', () => {
    monitor.reset();
    const stats = monitor.snapshot();
    expect(stats.samples).toBe(0);
    expect(stats.maxFps).toBe(0);
    expect(stats.minFps).toBe(0);
  });

  it('stop is idempotent', () => {
    monitor.stop();
    monitor.stop();
    expect(() => monitor.snapshot()).not.toThrow();
  });
});

describe('estimateLocalStorageUsage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns 0 when nothing is stored', () => {
    expect(estimateLocalStorageUsage()).toBe(0);
  });

  it('counts knowledge-dungeon prefixed keys', () => {
    localStorage.setItem('knowledge-dungeon:test1', 'hello');
    localStorage.setItem('knowledge-dungeon:test2', 'world');
    const usage = estimateLocalStorageUsage();
    // "knowledge-dungeon:test1" (23) + "hello" (5) + "knowledge-dungeon:test2" (23) + "world" (5) = 56
    expect(usage).toBeGreaterThan(0);
  });

  it('ignores non-prefixed keys', () => {
    localStorage.setItem('other-key', 'some value');
    expect(estimateLocalStorageUsage()).toBe(0);
  });
});

describe('estimateStorageFullness', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns 0 when storage is empty', () => {
    expect(estimateStorageFullness()).toBe(0);
  });

  it('returns a number between 0 and 1', () => {
    // Add some data
    localStorage.setItem('knowledge-dungeon:test', 'x'.repeat(10000));
    const fullness = estimateStorageFullness();
    expect(fullness).toBeGreaterThanOrEqual(0);
    expect(fullness).toBeLessThanOrEqual(1);
  });
});
