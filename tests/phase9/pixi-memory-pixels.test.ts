/**
 * The reduced-motion measurement, tested without a browser.
 *
 * Two things are tested here and the distinction matters:
 *
 * - **The PNG decoder.** A decoder that silently returned the wrong pixels would
 *   make the reduced-motion comparison report "no change" for a world that moved,
 *   which is the failure mode a test built on a proxy is most likely to have. It is
 *   exercised against images this file *encodes*, across all five PNG filter types,
 *   so the un-filtering arithmetic is covered rather than assumed.
 * - **The verdict.** Which pair of readings passes and which fails, including the
 *   two pairs that are easy to confuse: a world that is genuinely still, and a world
 *   that has been frozen so hard that the state change vanished.
 *
 * The encoder exists only to feed the decoder. It is deliberately not reused by the
 * lane, which decodes screenshots a browser produced.
 */

import { deflateSync, inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  changedRegion,
  decodePng,
  setPngInflater,
  type DecodedImage,
  type MotionMeasurement,
} from '../e2e/pixi-memory-pixels';

function setPngInstaller(): void {
  setPngInflater((data) => new Uint8Array(inflateSync(data)));
}

setPngInstaller();

/* -------------------------------------------------------------------------- */
/* A minimal PNG encoder, to feed the decoder                                  */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(body, 8);
  view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  return du <= dul ? up : upLeft;
}

/**
 * Encodes a greyscale 8-bit PNG using the requested filter for every row, so the
 * decoder's five un-filtering branches are all exercised.
 */
function encodeGreyPng(image: DecodedImage, filterForRow: (row: number) => number): Uint8Array {
  const { width, height, data } = image;
  const stride = width;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const filter = filterForRow(row);
    raw[row * (stride + 1)] = filter;
    for (let index = 0; index < stride; index += 1) {
      const value = data[row * stride + index] ?? 0;
      const left = index >= 1 ? (data[row * stride + index - 1] ?? 0) : 0;
      const up = row > 0 ? (data[(row - 1) * stride + index] ?? 0) : 0;
      const upLeft = row > 0 && index >= 1 ? (data[(row - 1) * stride + index - 1] ?? 0) : 0;
      const encoded =
        filter === 0
          ? value
          : filter === 1
            ? value - left
            : filter === 2
              ? value - up
              : filter === 3
                ? value - Math.floor((left + up) / 2)
                : value - paeth(left, up, upLeft);
      raw[row * (stride + 1) + 1 + index] = encoded & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[12] = 0; // interlace: none

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

function greyImage(width: number, height: number, fill: (x: number, y: number) => number): DecodedImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = fill(x, y);
  }
  return { width, height, channels: 1, data };
}

/** A disc of `radius` centred in a `size` square, for the geometry tests. */
function disc(size: number, radius: number, shade: number, background: number): DecodedImage {
  const centre = (size - 1) / 2;
  return greyImage(size, size, (x, y) => {
    const dx = x - centre;
    const dy = y - centre;
    return Math.sqrt(dx * dx + dy * dy) <= radius ? shade : background;
  });
}

function diffTwo(before: DecodedImage, after: DecodedImage) {
  const beforePng = encodeGreyPng(before, () => 0);
  const afterPng = encodeGreyPng(after, (row) => row % 5);
  const beforeDecoded = decodePng(beforePng);
  const afterDecoded = decodePng(afterPng);
  if (!beforeDecoded.ok || !afterDecoded.ok) throw new Error('fixture failed to decode');
  return changedRegion(beforeDecoded.image, afterDecoded.image);
}

function motionReading(overrides: Partial<MotionMeasurement> = {}): MotionMeasurement {
  return {
    reducedMotion: false,
    identical: false,
    changedPixels: 100,
    boundingBoxArea: 100,
    decoded: true,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('the PNG decoder', () => {
  it('round-trips an image through all five filter types', () => {
    const source = greyImage(9, 7, (x, y) => (x * 3 + y * 11) % 256);
    for (let filter = 0; filter < 5; filter += 1) {
      const result = decodePng(encodeGreyPng(source, () => filter));
      expect(result.ok, `filter ${filter}`).toBe(true);
      if (!result.ok) continue;
      expect(result.image.width).toBe(9);
      expect(result.image.height).toBe(7);
      expect(result.image.channels).toBe(1);
      expect([...result.image.data]).toEqual([...source.data]);
    }
  });

  it('round-trips a realistic photo-like image', () => {
    const source = greyImage(64, 48, (x, y) => Math.round(127 + 120 * Math.sin((x * y) / 97)));
    const result = decodePng(encodeGreyPng(source, (row) => row % 5));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.image.data]).toEqual([...source.data]);
  });

  it('refuses what it cannot decode rather than approximating it', () => {
    const notAPng = decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(notAPng.ok).toBe(false);
    if (notAPng.ok) return;
    expect(notAPng.failure.code).toBe('not-a-png');
    // A truncated chunk is a bounded failure with a sentence, not a byte offset.
    const truncated = decodePng(encodeGreyPng(greyImage(4, 4, () => 1), () => 0).subarray(0, 24));
    expect(truncated.ok).toBe(false);
    if (truncated.ok) return;
    expect(truncated.failure.message).not.toMatch(/\d{3,}/);
  });

  it('reports a missing inflater rather than throwing', () => {
    setPngInflater(() => {
      throw new Error('no inflater installed');
    });
    const result = decodePng(encodeGreyPng(greyImage(4, 4, () => 1), () => 0));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('inflate-failed');
    // Restored, so a failure here cannot silence every later test in the file.
    setPngInstaller();
  });
});

describe('the changed region', () => {
  it('is empty for two identical images', () => {
    const image = disc(16, 5, 200, 20);
    const region = diffTwo(image, image);
    expect(region.changedPixels).toBe(0);
    expect(region.boundingBoxArea).toBe(0);
  });

  it('is the recoloured disc, and its area is the disc and not the canvas', () => {
    // The reduced-motion case: a tint, at the base size.
    const before = disc(32, 6, 200, 20);
    const after = disc(32, 6, 90, 20);
    const region = diffTwo(before, after);
    expect(region.sameSize).toBe(true);
    expect(region.changedPixels).toBeGreaterThan(0);
    expect(region.changedPixels).toBeLessThan(32 * 32);
    expect(region.boundingBoxArea).toBeGreaterThanOrEqual(region.changedPixels);
    expect(region.boundingBoxArea).toBeLessThan(32 * 32);
  });

  it('is strictly larger for a grown disc, which is what the verdict relies on', () => {
    const base = disc(32, 6, 200, 20);
    const recolouredAtBaseSize = disc(32, 6, 90, 20);
    const grownAndRecoloured = disc(32, 10, 90, 20);
    const reduced = diffTwo(base, recolouredAtBaseSize);
    const motion = diffTwo(base, grownAndRecoloured);
    expect(motion.changedPixels).toBeGreaterThan(reduced.changedPixels);
    expect(motion.boundingBoxArea).toBeGreaterThan(reduced.boundingBoxArea);
  });

  it('refuses to compare two different sizes', () => {
    const region = changedRegion(disc(8, 3, 1, 0), disc(9, 3, 1, 0));
    expect(region.sameSize).toBe(false);
    expect(region.changedPixels).toBe(0);
  });
});

describe('the reduced-motion verdict', () => {
  it('passes a world whose state change stays the same size under reduced motion', async () => {
    const { evaluateMotion } = await import('../e2e/pixi-memory-pixels');
    expect(
      evaluateMotion({
        withMotion: motionReading({ changedPixels: 250, boundingBoxArea: 250 }),
        withReducedMotion: motionReading({ reducedMotion: true, changedPixels: 130, boundingBoxArea: 130 }),
        control: 'idle-world-is-pixel-stable',
      }),
    ).toEqual([]);
  });

  it('fails a world that moves as much under reduced motion as with it', async () => {
    const { evaluateMotion } = await import('../e2e/pixi-memory-pixels');
    const findings = evaluateMotion({
      withMotion: motionReading({ changedPixels: 130 }),
      withReducedMotion: motionReading({ reducedMotion: true, changedPixels: 250 }),
      control: 'idle-world-is-pixel-stable',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['reduced-motion-not-shrinking-the-change']);
  });

  it('fails a world that was frozen rather than stilled', async () => {
    const { evaluateMotion } = await import('../e2e/pixi-memory-pixels');
    const findings = evaluateMotion({
      withMotion: motionReading({ changedPixels: 250 }),
      withReducedMotion: motionReading({ reducedMotion: true, changedPixels: 0 }),
      control: 'idle-world-is-pixel-stable',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['reduced-motion-froze-the-world']);
  });

  it('refuses to conclude anything from an idle world that never settles', async () => {
    const { evaluateMotion } = await import('../e2e/pixi-memory-pixels');
    const findings = evaluateMotion({
      withMotion: motionReading({ changedPixels: 0 }),
      withReducedMotion: motionReading({ reducedMotion: true, changedPixels: 0 }),
      control: 'idle-world-is-not-pixel-stable',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['idle-world-not-stable']);
  });

  it('says so when a screenshot could not be decoded', async () => {
    const { evaluateMotion } = await import('../e2e/pixi-memory-pixels');
    const findings = evaluateMotion({
      withMotion: motionReading({ decoded: false, changedPixels: 0 }),
      withReducedMotion: motionReading({ reducedMotion: true, decoded: false, changedPixels: 0 }),
      control: 'idle-world-is-pixel-stable',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['screenshot-undecodable']);
  });

  it('refuses to accept "not identical" and "nothing changed" at once', async () => {
    const { evaluateMotion } = await import('../e2e/pixi-memory-pixels');
    const findings = evaluateMotion({
      withMotion: motionReading({ identical: false, changedPixels: 0 }),
      withReducedMotion: motionReading({ reducedMotion: true, identical: false, changedPixels: 0 }),
      control: 'idle-world-is-pixel-stable',
    });
    expect(findings.map((finding) => finding.code)).toEqual(['motion-run-unmeasured']);
  });
});
