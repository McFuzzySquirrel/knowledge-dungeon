/**
 * Checksum determinism and Web Crypto agreement.
 *
 * The SHA-256 implementation is plain TypeScript so a test needs no Web Crypto.
 * Where `globalThis.crypto.subtle.digest` does exist, this suite proves the two
 * agree, and skips cleanly where it does not.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  canonicalJsonStringify,
  checksumBytes,
  checksumOfChecksums,
  checksumText,
  checksumValue,
  sha256Hex,
} from '@/services/persistence/v2/checksum';

const encoder = new TextEncoder();

/** An independent SHA-256, used as the known-answer reference. */
function nodeSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

async function webCryptoHex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('canonicalJsonStringify', () => {
  it('is independent of key insertion order', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };

    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(canonicalJsonStringify(a)).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it('emits no insignificant whitespace and preserves array order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJsonStringify({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
  });

  it('drops undefined object properties and nulls undefined array holes', () => {
    expect(canonicalJsonStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJsonStringify([undefined, 1])).toBe('[null,1]');
  });

  it('matches JSON.stringify for non-finite numbers', () => {
    expect(canonicalJsonStringify({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toBe(
      JSON.stringify({ a: Number.NaN, b: Number.POSITIVE_INFINITY }),
    );
  });

  it('rejects values it cannot represent unambiguously', () => {
    expect(() => canonicalJsonStringify(new Map())).toThrow(TypeError);
    expect(() => canonicalJsonStringify(new Set())).toThrow(TypeError);
    expect(() => canonicalJsonStringify(1n)).toThrow(TypeError);
  });

  it('rejects a cyclic value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalJsonStringify(cyclic)).toThrow(TypeError);
  });
});

describe('sha256Hex', () => {
  it('matches the published FIPS 180-4 vectors', () => {
    expect(sha256Hex(encoder.encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(encoder.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      sha256Hex(encoder.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches node:crypto for every input length from 0 to 200', () => {
    // A regex shape check passes for any hex string, which is why the padding
    // defect survived it. This compares the digest itself against an independent
    // implementation for every length, so the `(len + 9) % 64 === 0` boundary -
    // that is, `len % 64 === 55` - is covered at 55, 119, and 183.
    const diverging: number[] = [];
    for (let length = 0; length <= 200; length += 1) {
      const bytes = new Uint8Array(length).fill(0x61);
      if (sha256Hex(bytes) !== nodeSha256(bytes)) diverging.push(length);
    }

    expect(diverging).toEqual([]);
    // The boundary is reachable inside the scanned range, so the sweep is not
    // accidentally skipping it.
    expect([55, 119, 183].every((length) => length <= 200)).toBe(true);
  });

  it('matches the reference digests at the lengths the padding formula used to get wrong', () => {
    // Lengths where `(length + 9)` is an exact multiple of 64.
    expect(sha256Hex(new Uint8Array(55).fill(0x61))).toBe(
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    );
    expect(sha256Hex(new Uint8Array(119).fill(0x61))).toBe(
      '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb',
    );
    expect(sha256Hex(new Uint8Array(183).fill(0x61))).toBe(
      'a88d44a2940a3a2fc363304926d263bf271afb562bab5640cb0e81f5e84320a3',
    );
  });

  it('is deterministic across repeated calls', () => {
    const bytes = encoder.encode('synthetic-checksum-input');
    expect(sha256Hex(bytes)).toBe(sha256Hex(bytes));
  });

  it('agrees with Web Crypto on the previously broken lengths, and fails loudly if it is unavailable', async () => {
    // A silent skip here would make the cross-check vacuous, so an absent
    // Web Crypto is a failure, not a skip.
    if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
      throw new Error('Web Crypto is unavailable, so the SHA-256 cross-check would be vacuous.');
    }
    const inputs = ['', 'abc', 'synthetic-checksum-input', 'x'.repeat(200)];
    // The three lengths the padding defect broke, built to exactly those sizes.
    for (const length of [55, 119, 183]) {
      inputs.push('a'.repeat(length));
    }

    for (const input of inputs) {
      const bytes = encoder.encode(input);
      expect(await webCryptoHex(bytes), `${input.length} bytes`).toBe(sha256Hex(bytes));
      expect(await webCryptoHex(bytes), `${input.length} bytes`).toBe(nodeSha256(bytes));
    }
  });
});

describe('checksum helpers', () => {
  it('derives the same value checksum for equal values written in different orders', () => {
    const first = { alpha: 1, beta: [{ y: 2, x: 1 }] };
    const second = { beta: [{ x: 1, y: 2 }], alpha: 1 };

    expect(checksumValue(first)).toBe(checksumValue(second));
  });

  it('detects a single changed value', () => {
    expect(checksumValue({ xpTotal: 1 })).not.toBe(checksumValue({ xpTotal: 2 }));
  });

  it('rolls a list of checksums up order-independently', () => {
    const a = checksumText('a');
    const b = checksumText('b');

    expect(checksumOfChecksums([a, b])).toBe(checksumOfChecksums([b, a]));
    expect(checksumOfChecksums([a, b])).not.toBe(checksumOfChecksums([a, a]));
  });

  it('hashes raw bytes and text through the same path', () => {
    expect(checksumBytes(encoder.encode('same'))).toBe(checksumText('same'));
  });
});
