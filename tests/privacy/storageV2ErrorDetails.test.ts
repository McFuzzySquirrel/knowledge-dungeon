/**
 * Phase 4: `StorageV2Error` details are structurally sanitized.
 *
 * Phase 3 recorded this as a limitation rather than a fix: "the type accepts a
 * string, so `toReport()` is safe only because every call site is careful". Phase 4
 * makes the gate structural, so the safety is a property of the type *and* of the
 * constructor rather than a property of the call sites.
 *
 * A detail value may be a count, a boolean, or a code-shaped token. A subject name,
 * a room topic, a note, a filename, and a URL all contain at least one character
 * the code shape forbids - a space, a slash, a colon, a comma, a quote - so they
 * are refused at construction and can never reach `toReport()`, a log, or a
 * recovery screen.
 *
 * Privacy: the values below are synthetic. The one URL uses the reserved
 * `example.invalid` host and is never dereferenced.
 */

import { describe, expect, it } from 'vitest';

import {
  StorageV2Error,
  isSanitizedDetailText,
  toStorageV2Error,
  type StorageV2ErrorDetails,
} from '@/services/persistence/v2/schema';

const CODES_AND_STAGES: readonly string[] = [
  'validate',
  'stage-records',
  'compare',
  'activate',
  'MIGRATION_FAILED',
  'VALIDATION_FAILED',
  'knowledge-dungeon-storage-v2',
  'gen-synthetic-0001',
  'subject-synthetic-0001',
  'att-synthetic-0001',
  'indexedDB',
  'room-synthetic-0001',
];

/**
 * Values that are learner content, or a container for it, and that the gate must
 * refuse. The last three are the ones a character class alone cannot catch: a slug
 * and a filename are both identifier-shaped, so the filename rule is what refuses
 * them.
 */
const LEARNER_SHAPED: readonly string[] = [
  'Storage lane synthetic subject',
  'Room topic with words',
  'note body text',
  'storage-lane-synthetic-uploaded.png',
  'https://example.invalid/storage-lane-synthetic.png',
  '/uploads/storage-lane-synthetic.png',
  "quote'inside",
  'trailing ',
  ' leading',
  'tab\tinside',
  'newline\ninside',
  'x'.repeat(65),
  'subject-ends-in-a-dot.v2',
  'note-body.md',
  'attachment.jpeg',
];

describe('Phase 4: the code shape a detail value must have', () => {
  it('accepts every code, stage, and opaque identifier the application mints', () => {
    for (const value of CODES_AND_STAGES) {
      expect(isSanitizedDetailText(value), value).toBe(true);
      expect(() => new StorageV2Error('VALIDATION_FAILED', { stage: value })).not.toThrow();
    }
    // A subject id whose *tail* is a dotted version is the one shape the
    // filename rule also refuses. It is the conservative direction, and it is
    // recorded here so the residual is visible rather than implied.
    expect(isSanitizedDetailText('subject-synthetic-0001')).toBe(true);
  });

  it('rejects every learner-shaped value, so the check is not a length limit', () => {
    for (const value of LEARNER_SHAPED) {
      expect(isSanitizedDetailText(value), JSON.stringify(value)).toBe(false);
      expect(() => new StorageV2Error('VALIDATION_FAILED', { stage: value })).toThrow(/refused/);
    }
  });

  it('refuses at construction, and the thrown message does not echo the value', () => {
    const secret = 'Storage lane synthetic subject';
    let thrown: unknown = null;
    try {
      new StorageV2Error('RECORD_INVALID', { field: secret });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    // The throw names the *key*, never the value: a throw that echoed it would be
    // the leak this check exists to prevent.
    expect(String((thrown as Error).message)).toContain('"field"');
    expect(String((thrown as Error).message)).not.toContain(secret);
  });
});

describe('Phase 4: the report projection carries only what the constructor accepted', () => {
  it('round-trips counts, booleans, and codes', () => {
    const details: StorageV2ErrorDetails = {
      stage: 'validate',
      problemCount: 3,
      generationId: 'gen-synthetic-0001',
      retryable: true,
    };
    const error = new StorageV2Error('VALIDATION_FAILED', details);
    const report = error.toReport();

    expect(Object.keys(report).sort()).toEqual(['code', 'details']);
    expect(report.code).toBe('VALIDATION_FAILED');
    expect(report.details).toEqual(details);
    expect(Object.keys(report.details).sort()).toEqual([
      'generationId',
      'problemCount',
      'retryable',
      'stage',
    ]);
    // The message is fixed per code; it never interpolates a detail.
    expect(error.message).toBe('storage-v2 error: VALIDATION_FAILED');
  });

  it('an empty detail bag is legal and reports nothing', () => {
    const error = new StorageV2Error('NO_ACTIVE_GENERATION');
    expect(error.toReport()).toEqual({ code: 'NO_ACTIVE_GENERATION', details: {} });
    expect(error.message).toBe('storage-v2 error: NO_ACTIVE_GENERATION');
  });

  it('the details bag is frozen, so a caller cannot widen it after construction', () => {
    const error = new StorageV2Error('VALIDATION_FAILED', { stage: 'validate' });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(() => {
      (error.details as Record<string, unknown>).stage = 'anything';
    }).toThrow();
  });

  it('toStorageV2Error passes a typed error through and sanitizes a foreign one', () => {
    const typed = new StorageV2Error('TRANSACTION_ABORTED', { storeCount: 2 });
    expect(toStorageV2Error(typed, 'MIGRATION_FAILED')).toBe(typed);
    expect(toStorageV2Error(new Error('foreign'), 'MIGRATION_FAILED', { stage: 'activate' }).toReport()).toEqual({
      code: 'MIGRATION_FAILED',
      details: { stage: 'activate' },
    });
  });
});
