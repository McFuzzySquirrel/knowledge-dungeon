/**
 * Independent SHA-256 for the Phase 5 data-product gate.
 *
 * Two implementations that share no code are compared on every payload this
 * suite hashes:
 *
 * 1. `node:crypto`'s `createHash('sha256')` - the platform implementation.
 * 2. `sha256Hex` from `src/services/persistence/v2/checksum.ts` - the
 *    application's own FIPS 180-4 implementation, which is what the storage-v2
 *    repository and the `.kdbak` manifest will use.
 *
 * A product that hashes with the wrong algorithm, hashes the wrong bytes, or
 * hashes a text encoding of the bytes instead of the bytes themselves fails
 * here, and a *shared* bug in one implementation cannot hide behind itself.
 *
 * Web Crypto (`crypto.subtle.digest`) is a third, optional witness. It is
 * present in Node 20 and Node 22 and in every browser, but its availability
 * under jsdom is not something this suite should depend on, so it is recorded
 * and asserted **only when present** - the same "skip cleanly" discipline
 * Phase 3 used for the same reason.
 *
 * The Node 20 portability rule from the Phase 3 evidence applies here: under
 * jsdom the test realm and Node's crypto realm differ, so `digest` is always
 * handed a freshly constructed `Uint8Array` rather than a `.buffer.slice()`
 * view. Node 20's `SubtleCrypto` validates its argument with an `instanceof`
 * chain and rejects a cross-realm `ArrayBuffer`; Node 22 accepts it. That
 * produced a real CI-only failure in Phase 3 and must not be reintroduced.
 *
 * Privacy: this module hashes bytes and returns lowercase hex. It never logs,
 * reports, or embeds a payload.
 */

import { createHash } from 'node:crypto';

import { sha256Hex as applicationSha256Hex } from '@/services/persistence/v2/checksum';

/** Platform SHA-256 of raw bytes, lowercase hex. */
export function platformSha256(bytes: Uint8Array): string {
  // `Buffer.from(view)` copies the view's *elements* into this realm's buffer,
  // which is what keeps the call correct under jsdom on both Node majors.
  return createHash('sha256').update(Buffer.from(new Uint8Array(bytes))).digest('hex');
}

/** The application's SHA-256 of raw bytes, lowercase hex. */
export function applicationSha256(bytes: Uint8Array): string {
  return applicationSha256Hex(new Uint8Array(bytes));
}

/** Whether Web Crypto's `subtle.digest` is callable in this realm. */
export function webCryptoAvailable(): boolean {
  const subtle = (globalThis as { crypto?: { subtle?: { digest?: unknown } } }).crypto?.subtle;
  return typeof subtle?.digest === 'function';
}

/**
 * Web Crypto's SHA-256 of raw bytes, or `null` when `subtle.digest` is not
 * callable in this realm.
 */
export async function webCryptoSha256(bytes: Uint8Array): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: { digest?: (a: unknown, b: unknown) => Promise<ArrayBuffer> } } })
    .crypto?.subtle;
  if (typeof subtle?.digest !== 'function') return null;
  const digest = await subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface HashWitness {
  readonly platform: string;
  readonly application: string;
  readonly webCrypto: string | null;
  /** True only when every available implementation returned the same digest. */
  readonly allAgree: boolean;
  /** How many implementations actually answered. */
  readonly witnessCount: number;
}

/**
 * Hash `bytes` with every available implementation and compare them.
 *
 * The comparison is the point: a caller that wants a hash gets evidence that
 * the value is not an artifact of one implementation, not a single string.
 */
export async function hashWithWitnesses(bytes: Uint8Array): Promise<HashWitness> {
  const platform = platformSha256(bytes);
  const application = applicationSha256(bytes);
  const webCrypto = await webCryptoSha256(bytes);
  const answers = [platform, application, webCrypto].filter(
    (value): value is string => value !== null,
  );
  return {
    platform,
    application,
    webCrypto,
    allAgree: answers.every((value) => value === platform),
    witnessCount: answers.length,
  };
}

/** Lowercase-hex to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('hexToBytes requires an even-length lowercase hex string.');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/** True when `value` is a 64-character lowercase SHA-256 hex digest. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * UTF-8 bytes of `text`.
 *
 * A local `TextEncoder` rather than a global one: the suite must produce the
 * same bytes on Node 20 and Node 22, and it must produce the bytes the
 * *archive* carries rather than whatever an ambient encoder is bound to.
 */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
