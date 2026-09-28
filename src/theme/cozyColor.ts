/**
 * Renderer-neutral colour arithmetic for the Cozy token system (Phase 8).
 *
 * This module is the only place allowed to convert a Cozy colour token into a
 * number. React needs CSS strings; a PixiJS host needs 0xRRGGBB and 0..1
 * component arrays. Both come from the same hex literal, so the two consumers
 * can never drift.
 *
 * Renderer-neutral by contract: no `document`, `window`, `globalThis`, no React
 * import, no renderer import, and no I/O. It is safe to evaluate in a worker.
 * `tests/phase8/cozy-tokens.test.ts` enforces that property for this file and
 * every other module listed in {@link RENDERER_NEUTRAL_THEME_MODULES}.
 */

/** A `#rrggbb` colour literal. `CozyHex` keeps token values assignable to hex. */
export type CozyHex = `#${string}`;

const SHORT_HEX = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const LONG_HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** 0..255 channel values for one colour. */
export interface CozyRgb255 {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** 0..1 channel values for one colour, the form PixiJS tint/alpha maths wants. */
export interface CozyRgbaUnit {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * Parse a 3- or 6-digit hex literal into 0..255 channels.
 *
 * Throws on anything else so a malformed token fails at module evaluation or in
 * the token test rather than silently rendering as black.
 */
export function parseCozyHex(value: string): CozyRgb255 {
  const short = SHORT_HEX.exec(value);
  if (short) {
    return {
      r: Number.parseInt(short[1] + short[1], 16),
      g: Number.parseInt(short[2] + short[2], 16),
      b: Number.parseInt(short[3] + short[3], 16),
    };
  }
  const long = LONG_HEX.exec(value);
  if (long) {
    return {
      r: Number.parseInt(long[1], 16),
      g: Number.parseInt(long[2], 16),
      b: Number.parseInt(long[3], 16),
    };
  }
  throw new TypeError(`cozyColor: expected a #rgb or #rrggbb colour, received "${value}"`);
}

/** The 0xRRGGBB integer form. PixiJS `Graphics`/`Sprite` tint values use this. */
export function cozyHexToNumber(value: string): number {
  const { r, g, b } = parseCozyHex(value);
  return ((r << 16) | (g << 8) | b) >>> 0;
}

/** The 0..1 component tuple PixiJS multiplies a texture by. */
export function cozyHexToUnitRgba(value: string, alpha = 1): CozyRgbaUnit {
  const { r, g, b } = parseCozyHex(value);
  return { r: r / 255, g: g / 255, b: b / 255, a: alpha };
}

/** The 0..1 tuple as a plain array, the argument shape PixiJS APIs accept. */
export function cozyHexToUnitArray(value: string, alpha = 1): [number, number, number, number] {
  const unit = cozyHexToUnitRgba(value, alpha);
  return [unit.r, unit.g, unit.b, unit.a];
}

/** A CSS `rgb()`/`rgba()` string, for the rare DOM consumer that cannot use a token. */
export function cozyRgbaCss(value: string, alpha = 1): string {
  const { r, g, b } = parseCozyHex(value);
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

function channelToLinear(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG 2.x relative luminance, 0 (black) to 1 (white).
 *
 * This is the function the shipped contrast test uses, so the recorded
 * measurements in `cozyTokens.ts` and the enforced thresholds can never be
 * produced by different maths.
 */
export function cozyRelativeLuminance(value: string): number {
  const { r, g, b } = parseCozyHex(value);
  return (
    0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b)
  );
}

/**
 * WCAG 2.x contrast ratio between two colours, 1:1 to 21:1.
 *
 * Order-independent, so callers may pass the foreground first.
 */
export function cozyContrastRatio(foreground: string, background: string): number {
  const a = cozyRelativeLuminance(foreground);
  const b = cozyRelativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** True when `foreground` on `background` reaches `minimum` (default 4.5:1). */
export function cozyMeetsContrast(
  foreground: string,
  background: string,
  minimum = 4.5,
): boolean {
  return cozyContrastRatio(foreground, background) >= minimum;
}

/** Linear RGB-space blend of two hex colours. `weight` is the share of `b`. */
export function cozyMixHex(a: string, b: string, weight: number): CozyHex {
  const t = Math.min(1, Math.max(0, weight));
  const from = parseCozyHex(a);
  const to = parseCozyHex(b);
  const channel = (x: number, y: number) => Math.round(x + (y - x) * t);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(channel(from.r, to.r))}${hex(channel(from.g, to.g))}${hex(channel(from.b, to.b))}`;
}
