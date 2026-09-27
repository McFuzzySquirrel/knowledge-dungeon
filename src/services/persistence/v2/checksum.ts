/**
 * Canonical JSON serialization and SHA-256 checksums.
 *
 * Storage-v2 compares content across generations, so a checksum must depend on
 * the *value* only, never on JavaScript key insertion order, whitespace, or the
 * platform's number formatting. {@link canonicalJsonStringify} therefore sorts
 * every object key and emits no insignificant whitespace.
 *
 * SHA-256 is implemented here in plain TypeScript rather than through
 * `crypto.subtle` for two reasons: it must work in a test environment with no
 * Web Crypto, and it must be a pure function of its input. A test asserts the
 * two agree whenever `globalThis.crypto.subtle.digest` is available and skips
 * cleanly when it is not.
 *
 * ## RAIL CHANGE: binary values are in the canonical form
 *
 * An `ArrayBuffer` used to fall through to the "any other class instance" branch
 * and serialize as `{}`, so `checksumValue` of an `AttachmentBlobRecordValue` - whose
 * `bytes` field is typed `ArrayBuffer` - was **independent of its own bytes**. Every
 * per-record checksum was blind to attachment content, and because the generation
 * roll-up is a roll-up of per-record checksums, the blind spot reached every
 * generation checksum, the `checksumMismatches` report, and the subject import's
 * plan-section-7.1 step-3 comparison. A blob corrupt on the device was therefore
 * carried forward and activated by an import, and no checksum in the system could
 * ever report it.
 *
 * Bytes now serialize to a **fixed-size digest form** rather than an expanded byte
 * array, for two reasons. A byte array is O(n) in the serialized string, and a
 * record checksum is hashed again for the store roll-up, so a multi-megabyte
 * attachment would be serialized more than once per write. And a digest form is the
 * same *shape* for an `ArrayBuffer` and for a `Uint8Array` over the same bytes, so
 * one value cannot have two checksums depending on which container a caller happened
 * to hand over - the ambiguity this module exists to remove.
 *
 * The format is `{"__bytes__":{"length":<byte count>,"sha256":"<lowercase hex>"}}`:
 * keys ascending, no whitespace, digest form fixed-width. `length` is carried
 * alongside the digest so a truncated payload that happened to share a digest is
 * still distinguishable, and because a SHA-256 of a *stream* of bytes is
 * length-sensitive anyway.
 *
 * No generation format version is bumped for this. The value shape of every record
 * is unchanged - only a derived checksum differs - and no storage-v2 generation has
 * shipped: this build is pre-release, the legacy reader still reads `localStorage`,
 * and the whole of storage-v2 is a rebuild-phase foundation. A stored checksum
 * written by a build with the blind spot is treated as derived state to be
 * rewritten, not as learner data to be migrated.
 */

// ── Canonical JSON ────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Realm-safe detection of "this is a buffer or a view over one".
 *
 * `instanceof ArrayBuffer` is false for a buffer created in another realm - a
 * `postMessage` transfer, an `iframe`, a worker - and storage-v2 reads values that
 * have crossed exactly those boundaries. `Object.prototype.toString` consults the
 * *internal* `[[Class]]` slot, so it answers correctly across realms, and
 * `ArrayBuffer.isView` is defined to be cross-realm. A `SharedArrayBuffer` is
 * deliberately not matched: it is not storable in IndexedDB and not a
 * record field type, so nothing legitimate depends on how it serializes.
 */
function isBinaryBuffer(value: unknown): boolean {
  if (ArrayBuffer.isView(value)) return true;
  if (value instanceof ArrayBuffer) return true;
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

/**
 * A `Uint8Array` over the value's bytes, without copying them.
 *
 * The view's own `byteOffset` is honoured, so a `Buffer` or a subarray hashes the
 * bytes it actually covers rather than the whole allocation behind it.
 */
function bytesOf(value: object): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
  }
  // The cross-realm case: a buffer that is not an `ArrayBuffer` instance here.
  return new Uint8Array(value as ArrayBuffer);
}

/**
 * The canonical form of a run of bytes.
 *
 * Fixed width and content-derived, so a checksum of a record that holds a
 * multi-megabyte attachment costs a hash rather than a multi-megabyte string. See
 * the "RAIL CHANGE" note in the module header for why bytes are in the canonical
 * form at all.
 */
function serializeBytes(value: object): string {
  const bytes = bytesOf(value);
  return `{"__bytes__":{"length":${bytes.length},"sha256":"${sha256Hex(bytes)}"}}`;
}

/**
 * Serialize a value to canonical JSON.
 *
 * - object keys are emitted in ascending code-unit order;
 * - no whitespace is emitted;
 * - `undefined` object properties are dropped, matching `JSON.stringify`;
 * - `undefined` array elements become `null`, also matching `JSON.stringify`;
 * - `NaN` and `Infinity` become `null`, also matching `JSON.stringify`;
 * - an `ArrayBuffer` or a view over one becomes the fixed-width
 *   `{"__bytes__":{"length":N,"sha256":"…"}}` digest form, so binary content is
 *   part of the canonical form rather than an empty object. See the "RAIL CHANGE"
 *   note in the module header;
 * - non-finite-safe types (`bigint`, `symbol`, `function`) are rejected rather
 *   than silently coerced, so a checksum can never be ambiguous;
 * - `Map` and `Set` are rejected for the same reason: their contents are
 *   not representable as a stable JSON object without an explicit key policy.
 *
 * Cyclic input throws: a checksum of a cycle is not defined.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serializeValue(value, new Set<object>());
}

function serializeValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
  if (type === 'undefined') return 'null';
  if (type === 'bigint' || type === 'symbol' || type === 'function') {
    throw new TypeError('canonicalJsonStringify cannot serialize this value type.');
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError('canonicalJsonStringify cannot serialize a cyclic value.');
  }
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      const items = object.map((item) =>
        typeof item === 'undefined' ? 'null' : serializeValue(item, seen),
      );
      return `[${items.join(',')}]`;
    }
    if (isPlainObject(object)) {
      const parts: string[] = [];
      for (const key of Object.keys(object).sort()) {
        const entry = (object as Record<string, unknown>)[key];
        if (typeof entry === 'undefined') continue;
        parts.push(`${JSON.stringify(key)}:${serializeValue(entry, seen)}`);
      }
      return `{${parts.join(',')}}`;
    }
    if (object instanceof Date) {
      return JSON.stringify(object.toISOString());
    }
    if (isBinaryBuffer(object)) {
      return serializeBytes(object);
    }
    if (
      object instanceof Map ||
      object instanceof Set ||
      object instanceof WeakMap ||
      object instanceof WeakSet ||
      object instanceof Promise
    ) {
      throw new TypeError('canonicalJsonStringify cannot serialize a Map, Set, or Promise.');
    }
    // Any other class instance is serialized by its own enumerable string keys,
    // which keeps `canonicalJsonStringify` total for plain data.
    const parts: string[] = [];
    for (const key of Object.keys(object).sort()) {
      const entry = (object as unknown as Record<string, unknown>)[key];
      if (typeof entry === 'undefined') continue;
      parts.push(`${JSON.stringify(key)}:${serializeValue(entry, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/** SHA-256 of raw bytes, lowercase hex. */
export function checksumBytes(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/** SHA-256 of a value's canonical JSON form, lowercase hex. */
export function checksumValue(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonicalJsonStringify(value)));
}

/** SHA-256 of a string's UTF-8 bytes, lowercase hex. */
export function checksumText(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

/**
 * Checksum of an ordered list of checksums.
 *
 * Used to roll per-record checksums up into one generation checksum. The list is
 * sorted first, so the generation checksum does not depend on enumeration order.
 */
export function checksumOfChecksums(checksums: readonly string[]): string {
  return sha256Hex(new TextEncoder().encode(canonicalJsonStringify([...checksums].sort())));
}

// ── SHA-256 ───────────────────────────────────────────────────────────────

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * SHA-256 over raw bytes, returned as lowercase hex.
 *
 * Straight FIPS 180-4 implementation. No Web Crypto, no randomness, no clock:
 * the same bytes always produce the same string.
 */
export function sha256Hex(input: Uint8Array): string {
  const bitLength = input.length * 8;
  // message + 0x80 + zero padding + 8-byte big-endian length, rounded up to the
  // next 64-byte block. This must be the MINIMAL such length: adding a spare
  // block would be absorbed into the message and the digest would be a valid
  // SHA-256 of a different message. The minimal length is what makes
  // `(len + 9) % 64 === 0` (that is, `len % 64 === 55`) come out right, which is
  // the boundary a `((len + 9) >> 6) + 1` expression gets wrong.
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  // Lengths above 2^32 bits cannot occur for a Uint8Array, so the high word is 0.
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  const hash = INITIAL_HASH.slice();
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < hash.length; i += 1) {
    hex += hash[i].toString(16).padStart(8, '0');
  }
  return hex;
}
