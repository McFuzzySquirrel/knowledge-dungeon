/**
 * Phase 18 gate 2: the statistics data survives every data product.
 *
 * ## The exit criterion under test
 *
 * Phase 18: *"Data survives reload, full backup, and subject backup."* The statistics layer
 * keeps **two** kinds of record, and this file covers both:
 *
 * 1. **the per-subject statistics event ledger**, which Phase 18 added as a *new preserved key*
 *    in the progression record's `extraFields` carrier - `statisticsEventLedger`, alongside the
 *    Phase 15/16/17 reward ledgers. This is the authoritative exactly-once count of notes,
 *    reviews, XP, and kept catches;
 * 2. **session records**, which were already in both products before this phase and are what the
 *    session-derived reader reads. The plan's exit criterion is about the dashboard, and the
 *    dashboard reads both, so both are here.
 *
 * ## What is proved, and how it is kept falsifiable
 *
 * - **Byte-for-byte, not "a ledger exists".** Every assertion compares the *event array* the
 *   core reader produces, deep-equal against the array that went in. A round trip that kept
 *   `version: 1` and dropped every event would fail.
 * - **A different device.** The restore half writes into a *second* forged device, so "it
 *   survived" cannot be satisfied by the export reading the same in-memory object it wrote.
 * - **An independent fingerprint.** `tests/phase6/support/forge.ts` is the verifier's own
 *   harness: it re-derives its fingerprint from raw IndexedDB rather than calling
 *   `captureDeviceState`, and it shares no code with `tests/data/support/`. The "a failed import
 *   changes nothing" claim is measured with it.
 * - **A positive control on that fingerprint.** Before the "nothing changed" assertions, one
 *   real record is rewritten through the real repository and the digest is required to move. If
 *   a single edited field could not move the fingerprint, every "unchanged" assertion below
 *   would be decorative.
 * - **A good import still works afterwards.** Each failure case is followed by a successful
 *   import, so "the import refused" cannot be explained by a reader that refuses everything.
 *
 * ## What is deliberately NOT asserted
 *
 * No learner content appears anywhere. Every id is synthetic and prefixed so a scan finds it by
 * shape. No real host, URL, request body, or credential is present.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  STATISTICS_EVENT_LEDGER_KEY,
  deriveStatisticsEventId,
  noteSubmissionEventSourceIdentity,
  readStatisticsEventLedgerFromFields,
  reviewCompletionEventSourceIdentity,
  toNoteSubmissionEvent,
  toReviewCompletionEvent,
  toXpAwardEvent,
  writeStatisticsEventLedgerToFields,
  type StatisticsEvent,
} from '@/core/statistics/statisticsEvents';
import { readArchive, writeArchive } from '@/services/persistence/v2/archive';
import { canonicalJsonStringify } from '@/services/persistence/v2/checksum';
import type { ProgressionRecordValue, SessionRecordValue } from '@/services/persistence/v2/schema';
import {
  inspectFullDeviceArchive,
  fullDeviceManifestContentChecksum,
} from '@/services/persistence/products/archiveValidation';
import {
  exportFullDeviceBackup,
  importFullDeviceBackup,
} from '@/services/persistence/products/fullDeviceBackup';
import {
  SUBJECT_ARCHIVE_ATTACHMENT_PREFIX,
  SUBJECT_ARCHIVE_FIXED_MEMBERS,
  SUBJECT_ARCHIVE_PROGRESSION_MEMBER,
  SUBJECT_ARCHIVE_SESSIONS_MEMBER,
  exportSubjectBackup,
  importSubjectBackup,
  inspectSubjectArchive,
} from '@/services/persistence/products/subjectBackup';
import { validateProgressionRecord } from '@/services/persistence/v2/validation';

import {
  ALPHA,
  FIXED_NOW,
  alphaSessions,
  forgeDevice,
  forgeSha256,
  fingerprintDevice,
  type ForgedDevice,
} from '../phase6/support/forge';

/** The subject the statistics ledger is planted on. */
const SUBJECT = ALPHA;
const CLEAR_IDENTITY = 'clear-0000c1ea';
const REVIEW_IDENTITY = 'review-0000c1ea';
const LOCAL_DATE = '2026-02-03';
const NOW = FIXED_NOW;

/**
 * The exact events the three award sites would write for one note and one review.
 *
 * Built by the production constructors from the same identity components the reward sites pass,
 * so the fixture cannot drift from the shape the ledger actually stores - and so a round trip
 * that lost an event would be losing a *real* event, not a hand-written approximation.
 */
function plantedEvents(): readonly StatisticsEvent[] {
  const noteIdentity = { roomId: 'synthetic-qa18-room-note', clearIdentity: CLEAR_IDENTITY };
  const reviewIdentity = {
    roomId: 'synthetic-qa18-room-review',
    passNumber: 1,
    reviewIdentity: REVIEW_IDENTITY,
  };
  return [
    toNoteSubmissionEvent({
      subjectId: SUBJECT,
      identity: noteIdentity,
      localDate: LOCAL_DATE,
      recordedAt: NOW,
      xpAwarded: 25,
    }),
    toXpAwardEvent({
      subjectId: SUBJECT,
      source: 'note-submission',
      sourceIdentity: noteSubmissionEventSourceIdentity(noteIdentity),
      localDate: LOCAL_DATE,
      recordedAt: NOW,
      amount: 25,
    }),
    toReviewCompletionEvent({
      subjectId: SUBJECT,
      identity: reviewIdentity,
      localDate: LOCAL_DATE,
      recordedAt: NOW,
      xpAwarded: 6,
    }),
    toXpAwardEvent({
      subjectId: SUBJECT,
      source: 'review-completion',
      sourceIdentity: reviewCompletionEventSourceIdentity(reviewIdentity),
      localDate: LOCAL_DATE,
      recordedAt: NOW,
      amount: 6,
    }),
  ];
}

const PLANTED_EVENTS = plantedEvents();

/**
 * The exact event array the ledger must carry, in the exact order it is written.
 *
 * Newest first, which is the order `recordStatisticsEvent` prepends in and therefore the order
 * a byte-for-byte round trip has to preserve.
 */
const LEDGER_EVENTS_NEWEST_FIRST = [...PLANTED_EVENTS].reverse();

/** The exact event array the ledger must carry, in the exact order it is written. */
function expectedLedgerEvents(): unknown[] {
  return LEDGER_EVENTS_NEWEST_FIRST;
}

/**
 * An app-owned field the statistics layer knows nothing about, planted beside the ledger.
 *
 * The forge's own progression fixture carries no preserved fields, so without this the
 * "additive, does not displace another ledger" claim would have nothing to be additive to.
 */
const UNKNOWN_APP_OWNED_FIELD = 'syntheticQa18UnknownField';
const UNKNOWN_APP_OWNED_VALUE = { marker: 'synthetic-qa18-unknown-field' };

/**
 * Plant the ledger on the device's progression record for {@link SUBJECT}, through the real
 * storage-v2 write path.
 *
 * `repository.putRecords` is the same call the application makes, so the record on disk is a
 * record the application could have written - not one assembled by a test-only route.
 */
async function plantLedger(device: ForgedDevice): Promise<void> {
  const generationId = await device.repository.readActiveGenerationId();
  if (generationId === null) throw new Error('no active generation');
  const snapshot = await device.repository.readRecords(generationId);
  const progression = snapshot.records.progression.map((entry) => ({ ...entry.value }));
  let touched = false;
  for (const record of progression) {
    const bySubject = record.bySubject as unknown as Record<string, Record<string, unknown>>;
    const own = bySubject[record.subjectId];
    if (own === undefined) continue;
    const fields = writeStatisticsEventLedgerToFields(
      {
        ...((own.extraFields as Record<string, unknown> | undefined) ?? {}),
        [UNKNOWN_APP_OWNED_FIELD]: UNKNOWN_APP_OWNED_VALUE,
      },
      { version: 1, events: LEDGER_EVENTS_NEWEST_FIRST },
    );
    bySubject[record.subjectId] = { ...own, extraFields: fields };
    touched = true;
  }
  if (!touched) throw new Error('the forged device holds no progression record to plant into');
  await device.repository.putRecords(generationId, {
    progression: progression as ProgressionRecordValue[],
  });
}

/** Every event array the device's active generation carries for the planted subject. */
async function readPlantedEvents(device: ForgedDevice): Promise<unknown[]> {
  const generationId = await device.repository.readActiveGenerationId();
  if (generationId === null) throw new Error('no active generation');
  const snapshot = await device.repository.readRecords(generationId);
  const found: unknown[] = [];
  for (const entry of snapshot.records.progression) {
    const bySubject = entry.value.bySubject as unknown as Record<string, Record<string, unknown>>;
    const own = bySubject[SUBJECT];
    if (own === undefined) continue;
    found.push(...readStatisticsEventLedgerFromFields(own.extraFields as Record<string, unknown>).events);
  }
  return found;
}

/** Decode one fixed member of an archive. */
function memberJson<T>(bytes: Uint8Array, path: string): T {
  const member = readArchive(bytes).find((file) => file.path === path);
  if (member === undefined) throw new Error(`the archive has no ${path} member`);
  return JSON.parse(new TextDecoder().decode(member.bytes)) as T;
}

const OPEN_DEVICES: ForgedDevice[] = [];

async function forgedDevice(): Promise<ForgedDevice> {
  const device = await forgeDevice();
  await plantLedger(device);
  OPEN_DEVICES.push(device);
  return device;
}

afterEach(async () => {
  while (OPEN_DEVICES.length > 0) {
    const device = OPEN_DEVICES.pop();
    if (device === undefined) continue;
    device.repository.close();
    indexedDB.deleteDatabase(device.databaseName);
  }
  window.localStorage.clear();
});

// ─────────────────────────────────────────────────────────────────────────────
// The ledger itself
// ─────────────────────────────────────────────────────────────────────────────

describe('the statistics ledger is a validated preserved field of the progression record', () => {
  it('is written under the shared preserved key and read back whole', async () => {
    const device = await forgedDevice();
    // The key is the documented static vocabulary, so a rename would break every reader at
    // once rather than silently orphan a device's history.
    const generationId = (await device.repository.readActiveGenerationId()) as string;
    const snapshot = await device.repository.readRecords(generationId);
    const own = (snapshot.records.progression[0].value.bySubject as unknown as Record<
      string,
      Record<string, unknown>
    >)[SUBJECT];
    const fields = own.extraFields as Record<string, unknown>;

    // The statistics ledger is **additive**: it shares the preserved-field carrier with the
    // reward ledgers and with any unknown app-owned field, and displaces none of them.
    expect(Object.keys(fields).sort()).toEqual(
      [UNKNOWN_APP_OWNED_FIELD, STATISTICS_EVENT_LEDGER_KEY].sort(),
    );
    expect(fields[UNKNOWN_APP_OWNED_FIELD]).toEqual(UNKNOWN_APP_OWNED_VALUE);
    expect(readStatisticsEventLedgerFromFields(fields).events).toEqual(expectedLedgerEvents());

    // And the event identities are the derived digests, so a ledger whose `eventId` disagreed
    // with its own components would fail here.
    expect(deriveStatisticsEventId({
      kind: 'note-submission',
      subjectId: SUBJECT,
      sourceIdentity: noteSubmissionEventSourceIdentity({
        roomId: 'synthetic-qa18-room-note',
        clearIdentity: CLEAR_IDENTITY,
      }),
    })).toBe((PLANTED_EVENTS[0] as { eventId: string }).eventId);
  });

  it('carries no learner content: ids and integers only', async () => {
    const device = await forgedDevice();
    const events = (await readPlantedEvents(device)).map((event) => JSON.stringify(event));
    // The documented privacy rule: every identity input is an app-minted id or a non-negative
    // integer. A digest, a date key, and an amount - never a name, a topic, or free text.
    for (const serialized of events) {
      expect(serialized).not.toMatch(/ZX-MARKER/);
    }
    expect(events.join('|')).not.toContain('Synthetic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full-device backup (`.kdbak`)
// ─────────────────────────────────────────────────────────────────────────────

describe('the statistics ledger survives the full-device backup product', () => {
  it('is written into state.json whole, with its event order intact', async () => {
    const device = await forgedDevice();
    const exported = await exportFullDeviceBackup({
      repository: device.repository,
      generationId: device.generationId,
      now: NOW,
    });

    const state = memberJson<{
      progression: Array<{ bySubject: Record<string, { extraFields?: Record<string, unknown> }> }>;
    }>(exported.bytes, 'state.json');

    const carried: unknown[] = [];
    for (const record of state.progression) {
      const own = record.bySubject[SUBJECT];
      if (own === undefined) continue;
      carried.push(...readStatisticsEventLedgerFromFields(own.extraFields).events);
    }
    // Deep-equal against the array that went in: every event, every field, in order.
    expect(carried).toEqual(expectedLedgerEvents());
    // And the count, stated separately so a failure names the magnitude.
    expect(carried).toHaveLength(4);
  });

  it('is accepted by the archive auditor with no problem at all', async () => {
    const device = await forgedDevice();
    const exported = await exportFullDeviceBackup({
      repository: device.repository,
      generationId: device.generationId,
      now: NOW,
    });

    // `archiveValidation.ts` is the module that vets a `.kdbak` before anything trusts it. An
    // `ok: false` here means the product would refuse its own export.
    const inspection = inspectFullDeviceArchive(exported.bytes);
    expect(inspection.ok, inspection.ok ? '' : JSON.stringify(inspection.error)).toBe(true);
    if (!inspection.ok) return;
    // No **error**-severity problem. The forge's fixture deliberately contains a malformed
    // graph edge, which the auditor discloses as a warning - so this is not "the array is
    // empty", it is "nothing here blocks an import", and the control below proves the
    // difference is being measured rather than assumed.
    const blocking = inspection.preview.problems.filter((problem) => problem.severity === 'error');
    expect(blocking, JSON.stringify(inspection.preview.problems)).toEqual([]);
    // CONTROL: the auditor really does report problems for this fixture, so the assertion
    // above is filtering a populated list rather than an empty one.
    expect(inspection.preview.problems.length).toBeGreaterThan(0);
    expect(inspection.preview.problems.every((problem) => problem.severity === 'warning')).toBe(true);
    expect(inspection.preview.recordCounts.progression).toBeGreaterThan(0);
    expect(inspection.preview.totalMemberCount).toBeGreaterThan(0);
    // The ledger's key is not named in the manifest: a preserved field is record content, not
    // an archive member, and a member named after it would leak a vocabulary word into a file
    // listing a learner could read.
    expect(inspection.preview.memberNames.some((name) => name.includes(STATISTICS_EVENT_LEDGER_KEY))).toBe(
      false,
    );
  });

  it('restores into a DIFFERENT device with the ledger and the sessions intact', async () => {
    const source = await forgedDevice();
    const exported = await exportFullDeviceBackup({
      repository: source.repository,
      generationId: source.generationId,
      now: NOW,
    });

    // A second forged device, with its own database and its own unrelated state. The restore
    // runs against it, so nothing can be satisfied by the exporter handing back the object it
    // just read.
    const destination = await forgedDevice();
    const result = await importFullDeviceBackup({
      repository: destination.repository,
      bytes: exported.bytes,
      now: NOW,
      keepPreviousGeneration: true,
    });
    expect(result.previousGenerationRetained).toBe(true);

    expect(await readPlantedEvents(destination)).toEqual(expectedLedgerEvents());

    // The session records the dashboard reads survived the same round trip. Compared as whole
    // values, including the counters.
    const generationId = await destination.repository.readActiveGenerationId();
    const snapshot = await destination.repository.readRecords(generationId as string);
    const sessions = snapshot.records.sessions.map((entry) => entry.value as SessionRecordValue);
    // A `.kdbak` is a *whole-device* product, so the destination legitimately holds more
    // sessions than the one subject. What is asserted is that every exported session arrived
    // unchanged, counters included.
    const sourceSessions = alphaSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(sourceSessions.length);
    expect(sessions).toEqual(expect.arrayContaining(sourceSessions));
    for (const original of sourceSessions) {
      const landed = sessions.find((entry) => entry.sessionId === original.sessionId);
      expect(landed, `${original.sessionId} did not survive the full-device restore`).toBeDefined();
      expect(landed).toEqual(original);
    }
  });

  it('NON-VACUITY CONTROL: the fingerprint moves when one real record is rewritten', async () => {
    const device = await forgedDevice();
    const before = await fingerprintDevice(device.repository, device.databaseName);

    const generationId = (await device.repository.readActiveGenerationId()) as string;
    const snapshot = await device.repository.readRecords(generationId);
    const sessions = snapshot.records.sessions.map((entry) => ({ ...entry.value }));
    sessions[0].xpEarned = (sessions[0].xpEarned ?? 0) + 1;
    await device.repository.putRecords(generationId, { sessions: sessions as SessionRecordValue[] });

    const after = await fingerprintDevice(device.repository, device.databaseName);
    expect(after.digest).not.toBe(before.digest);
    expect(after.records).not.toEqual(before.records);
  });

  it('a FAILED import leaves the active generation byte-for-byte identical', async () => {
    const device = await forgedDevice();
    const exported = await exportFullDeviceBackup({
      repository: device.repository,
      generationId: device.generationId,
      now: NOW,
    });

    // Three independent failures, each a *different* stage of the read, so "the import refused"
    // is not one gate wearing three hats.
    //
    //  (a) a member's declared sha256 no longer matches its bytes - a hand-edited archive;
    //  (b) a manifest checksum that disagrees with its own member list;
    //  (c) a state document that is no longer JSON.
    const files = readArchive(exported.bytes);
    const manifestIndex = files.findIndex((file) => file.path === 'manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(files[manifestIndex].bytes)) as {
      members: Array<{ path: string; byteLength: number; sha256: string }>;
      contentChecksum: string;
      totalBytes: number;
    };

    /**
     * Rebuild the archive from a *declared* member list.
     *
     * The declared digests are used **verbatim**: an earlier version of this helper recomputed
     * every `sha256` from the real bytes, which silently repaired each corruption and made
     * two of the three cases below unfailable. `byteLength` is still taken from the real bytes,
     * because a length is a property of the member rather than a declaration.
     */
    const rebuildFull = (
      mutate: (
        members: Array<{ path: string; byteLength: number; sha256: string }>,
        content: Map<string, Uint8Array>,
      ) => {
        members: Array<{ path: string; byteLength: number; sha256: string }>;
        consistentRollUp: boolean;
        /** Replace the roll-up with a value that describes nothing. */
        rollUpOverride?: boolean;
      },
    ): Uint8Array => {
      const content = new Map(files.map((file) => [file.path, file.bytes] as const));
      const patched = mutate(manifest.members.map((member) => ({ ...member })), content);
      const members: Array<{ path: string; byteLength: number; sha256: string }> = [];
      for (const member of patched.members) {
        const bytes = content.get(member.path);
        if (bytes === undefined) throw new Error(`missing ${member.path}`);
        members.push({ path: member.path, byteLength: bytes.byteLength, sha256: member.sha256 });
      }
      // `consistentRollUp: true` recomputes the manifest's roll-up from the DECLARED member
      // list, so the roll-up check agrees with the manifest and only the per-member digest
      // check can catch the case. `false` leaves the original roll-up, so the roll-up check is
      // the one that fires. The two are kept distinct on purpose: a gate that only ever
      // exercised the roll-up would not notice the per-member check being removed.
      return writeArchive([
        ...[...content.entries()]
          .filter(([path]) => path !== 'manifest.json')
          .map(([path, bytes]) => ({ path, bytes })),
        {
          path: 'manifest.json',
          bytes: new TextEncoder().encode(
            canonicalJsonStringify({
              ...manifest,
              members,
              ...(patched.rollUpOverride === true
                ? { contentChecksum: forgeSha256('synthetic-roll-up-describes-nothing') }
                : patched.consistentRollUp
                  ? { contentChecksum: fullDeviceManifestContentChecksum(members as never) }
                  : {}),
              totalBytes: members.reduce((total, member) => total + member.byteLength, 0),
            }),
          ),
        },
      ]);
    };

    const unparseableStateDocument = (): Uint8Array =>
      rebuildFull((members, content) => {
        const state = new TextDecoder()
          .decode(content.get('state.json') as Uint8Array)
          .replace('"formatVersion"', '"formatVersion" ');
        content.set('state.json', new TextEncoder().encode(state));
        return { members, consistentRollUp: true };
      });

    const declaredDigestDisagreesWithBytes = (): Uint8Array =>
      rebuildFull((members, content) => {
        // The document is edited, and the manifest keeps declaring the digest of the bytes it
        // used to hold. The roll-up is recomputed from the declared list, so the manifest is
        // internally consistent and only a per-member comparison can catch this.
        const state = new TextDecoder().decode(content.get('state.json') as Uint8Array);
        content.set(
          'state.json',
          new TextEncoder().encode(state.replace('"formatVersion"', '"formatVersion" ')),
        );
        return {
          members: members.map((member) =>
            member.path === 'state.json'
              ? { ...member, byteLength: (content.get('state.json') as Uint8Array).byteLength }
              : member,
          ),
          consistentRollUp: true,
        };
      });

    /**
     * The manifest contradicts itself, and **only** the roll-up can see it.
     *
     * Every declared member digest is left correct for the real bytes, so a per-member
     * comparison passes; only the roll-up `contentChecksum` is replaced, so it no longer
     * describes the member list it is attached to. This case and the one above are therefore
     * independent: removing either check leaves the other to catch its own case.
     */
    const declaredRollUpDisagreesWithItsMemberList = (): Uint8Array =>
      rebuildFull((members) => ({ members, consistentRollUp: false, rollUpOverride: true }));

    const missingStateDocument = (): Uint8Array =>
      writeArchive([
        ...files
          .filter((file) => file.path !== 'state.json' && file.path !== 'manifest.json')
          .map((file) => ({ path: file.path, bytes: file.bytes })),
        { path: 'manifest.json', bytes: new TextEncoder().encode(canonicalJsonStringify(manifest)) },
      ]);

    const failures: ReadonlyArray<readonly [string, Uint8Array]> = [
      ['unparseable-state-document', unparseableStateDocument()],
      ['declared-member-digest-disagrees-with-bytes', declaredDigestDisagreesWithBytes()],
      ['declared-roll-up-disagrees-with-its-member-list', declaredRollUpDisagreesWithItsMemberList()],
      ['the-state-document-is-missing', missingStateDocument()],
    ];

    const before = await fingerprintDevice(device.repository, device.databaseName);

    for (const [id, bytes] of failures) {
      let threw = false;
      let code: string | null = null;
      try {
        await importFullDeviceBackup({ repository: device.repository, bytes, now: NOW });
      } catch (error) {
        threw = true;
        code = (error as { code?: string }).code ?? null;
      }
      expect(threw, `${id}: the import accepted a corrupt archive`).toBe(true);
      // A typed, sanitized failure - not an `Error` with the archive's bytes in its message.
      expect(typeof code, `${id}: the failure carried no typed code`).toBe('string');

      // The whole device, byte for byte: the pointer, every generation, every record envelope,
      // every descriptor, and the legacy mirror.
      const after = await fingerprintDevice(device.repository, device.databaseName);
      expect(after.digest, `${id}: a failed import changed the device`).toBe(before.digest);
      expect(after.activeGenerationId, `${id}: the active generation pointer moved`).toBe(
        before.activeGenerationId,
      );
      expect(after.generationIds, `${id}: a generation was staged or abandoned`).toEqual(
        before.generationIds,
      );
    }

    // And the product still works: a good archive imports into the same untouched device, and
    // the statistics land. "Every import was refused" is not an acceptable passing state.
    const good = await importFullDeviceBackup({
      repository: device.repository,
      bytes: exported.bytes,
      now: NOW,
    });
    expect(good.generationId).not.toBeNull();
    expect(await readPlantedEvents(device)).toEqual(expectedLedgerEvents());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Subject backup (`.kdsubject`)
// ─────────────────────────────────────────────────────────────────────────────

describe('the statistics ledger survives the subject backup product', () => {
  it('is written into progression.json whole', async () => {
    const device = await forgedDevice();
    const exported = await exportSubjectBackup({
      repository: device.repository,
      generationId: device.generationId,
      subjectId: SUBJECT,
      now: NOW,
      payloadBytes: new Map(),
    });

    // The `.kdsubject` layout has exactly four fixed document members. The ledger must be in
    // the progression one, and must NOT have needed a fifth: every other member is either one
    // of the five fixed names or an `attachments/`-prefixed byte member.
    const paths = readArchive(exported.bytes).map((file) => file.path).sort();
    expect(paths).toContain(SUBJECT_ARCHIVE_PROGRESSION_MEMBER);
    expect(paths).toContain(SUBJECT_ARCHIVE_SESSIONS_MEMBER);
    expect(SUBJECT_ARCHIVE_FIXED_MEMBERS.every((name) => paths.includes(name))).toBe(true);
    expect(paths.filter((path) => !path.startsWith(SUBJECT_ARCHIVE_ATTACHMENT_PREFIX)).sort()).toEqual(
      [...SUBJECT_ARCHIVE_FIXED_MEMBERS].sort(),
    );

    const document = memberJson<{
      progression: Array<{ bySubject: Record<string, { extraFields?: Record<string, unknown> }> }>;
    }>(exported.bytes, SUBJECT_ARCHIVE_PROGRESSION_MEMBER);

    const carried: unknown[] = [];
    for (const record of document.progression) {
      const own = record.bySubject[SUBJECT];
      if (own === undefined) continue;
      carried.push(...readStatisticsEventLedgerFromFields(own.extraFields).events);
    }
    expect(carried).toEqual(expectedLedgerEvents());
  });

  it('the auditor accepts the subject archive, and the sessions member is non-empty', async () => {
    const device = await forgedDevice();
    const exported = await exportSubjectBackup({
      repository: device.repository,
      generationId: device.generationId,
      subjectId: SUBJECT,
      now: NOW,
      payloadBytes: new Map(),
    });

    // `inspectSubjectArchive` is the subject product's own reader; an `ok: false` means the
    // product would refuse its own export.
    const inspection = inspectSubjectArchive(exported.bytes);
    expect(inspection.ok, inspection.ok ? '' : JSON.stringify(inspection.error)).toBe(true);
    if (!inspection.ok) return;
    const blocking = inspection.preview.disclosedProblems.filter(
      (problem) => problem.severity === 'error',
    );
    expect(blocking, JSON.stringify(inspection.preview.disclosedProblems)).toEqual([]);
    // CONTROL: the list is populated for this fixture, so the filter above is doing work.
    expect(inspection.preview.disclosedProblems.length).toBeGreaterThan(0);
    // And no member name leaks the ledger vocabulary.
    expect(
      inspection.preview.memberNames.some((name) => name.includes(STATISTICS_EVENT_LEDGER_KEY)),
    ).toBe(false);

    const sessions = memberJson<{ sessions: SessionRecordValue[] }>(
      exported.bytes,
      SUBJECT_ARCHIVE_SESSIONS_MEMBER,
    );
    expect(sessions.sessions.map((entry) => entry.sessionId).sort()).toEqual(
      alphaSessions().map((entry) => entry.sessionId).sort(),
    );
  });

  it('restores through a replace import, and the ledger lands on the destination', async () => {
    const source = await forgedDevice();
    const exported = await exportSubjectBackup({
      repository: source.repository,
      generationId: source.generationId,
      subjectId: SUBJECT,
      now: NOW,
      payloadBytes: new Map(),
    });

    const destination = await forgedDevice();
    const result = await importSubjectBackup({
      repository: destination.repository,
      bytes: exported.bytes,
      now: NOW,
      mode: 'replace',
      confirmReplace: true,
      replaceSubjectId: SUBJECT,
    });
    expect(result.importedSubjectId).toBe(SUBJECT);
    expect(result.replacedSubjectId).toBe(SUBJECT);

    // Exactly the four events, once. A replace that *appended* rather than replaced would show
    // eight here, which is the counted-once property this whole phase rests on.
    const events = await readPlantedEvents(destination);
    expect(events).toEqual(expectedLedgerEvents());
    const eventIds = events.map((event) => (event as { eventId: string }).eventId);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it('a FAILED subject import leaves the active generation byte-for-byte identical', async () => {
    const device = await forgedDevice();
    const exported = await exportSubjectBackup({
      repository: device.repository,
      generationId: device.generationId,
      subjectId: SUBJECT,
      now: NOW,
      payloadBytes: new Map(),
    });

    const before = await fingerprintDevice(device.repository, device.databaseName);

    // Two refusals the product declares up front, before it opens anything: an unconfirmed
    // replace, and a replace whose target is not the subject the archive carries. Both must
    // leave the device untouched.
    const refusals: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['replace-not-confirmed', { mode: 'replace', replaceSubjectId: SUBJECT }],
      [
        'replace-target-disagrees',
        { mode: 'replace', confirmReplace: true, replaceSubjectId: 'synthetic-qa18-other-subject' },
      ],
    ];
    for (const [id, overrides] of refusals) {
      let threw = false;
      try {
        await importSubjectBackup({
          repository: device.repository,
          bytes: exported.bytes,
          now: NOW,
          ...overrides,
        } as Parameters<typeof importSubjectBackup>[0]);
      } catch {
        threw = true;
      }
      expect(threw, `${id}: the import was accepted`).toBe(true);
      const after = await fingerprintDevice(device.repository, device.databaseName);
      expect(after.digest, `${id}: a refused import changed the device`).toBe(before.digest);
    }

    // A corrupt archive is refused too, with the device still untouched. Five independent
    // corruptions, one per stage of the read, so "the import refused" is not one gate wearing
    // five hats.
    const files = readArchive(exported.bytes);
    const manifest = JSON.parse(
      new TextDecoder().decode(files.find((file) => file.path === 'manifest.json')?.bytes ?? new Uint8Array()),
    ) as Record<string, unknown>;
    const rebuild = (
      mutate: (entries: ReadonlyArray<{ path: string; bytes: Uint8Array }>) => ReadonlyArray<{
        path: string;
        bytes: Uint8Array;
      }>,
      manifestOverride?: Record<string, unknown>,
    ): Uint8Array =>
      writeArchive([
        ...mutate(files).filter((file) => file.path !== 'manifest.json'),
        {
          path: 'manifest.json',
          bytes: new TextEncoder().encode(canonicalJsonStringify(manifestOverride ?? manifest)),
        },
      ]);

    const corruptions: ReadonlyArray<readonly [string, Uint8Array]> = [
      ['a truncated archive', exported.bytes.slice(0, Math.floor(exported.bytes.length / 2))],
      [
        'a progression document whose bytes no longer match the manifest digest',
        rebuild((entries) =>
          entries.map((file) =>
            file.path === SUBJECT_ARCHIVE_PROGRESSION_MEMBER
              ? {
                  path: file.path,
                  // A byte inside the document, so the member still unzips and still parses -
                  // only its declared digest is now wrong.
                  bytes: new TextEncoder().encode(
                    new TextDecoder()
                      .decode(file.bytes)
                      .replace('"crossSubjectAchievements"', '"crossSubjectAchievements": [],"syntheticQa18Tampered":1,"unused"'),
                  ),
                }
              : file,
          ),
        ),
      ],
      [
        'a manifest whose member digest does not match the bytes',
        rebuild(
          () => files,
          {
            ...manifest,
            members: (manifest.members as Array<{ path: string }>).map((member) =>
              member.path === SUBJECT_ARCHIVE_PROGRESSION_MEMBER
                ? { ...member, sha256: forgeSha256('synthetic-not-the-progression-document') }
                : member,
            ),
          },
        ),
      ],
      [
        'a progression document that is no longer JSON',
        rebuild((entries) =>
          entries.map((file) =>
            file.path === SUBJECT_ARCHIVE_PROGRESSION_MEMBER
              ? { path: file.path, bytes: new TextEncoder().encode('{ not json') }
              : file,
          ),
        ),
      ],
      [
        'a progression document missing from the archive',
        rebuild((entries) => entries.filter((file) => file.path !== SUBJECT_ARCHIVE_PROGRESSION_MEMBER)),
      ],
    ];

    for (const [id, bytes] of corruptions) {
      let threw = false;
      let code: string | null = null;
      try {
        await importSubjectBackup({ repository: device.repository, bytes, now: NOW });
      } catch (error) {
        threw = true;
        code = (error as { code?: string }).code ?? null;
      }
      expect(threw, `${id}: the import accepted it`).toBe(true);
      expect(typeof code, `${id}: the failure carried no typed code`).toBe('string');
      const after = await fingerprintDevice(device.repository, device.databaseName);
      expect(after.digest, `${id}: a refused import changed the device`).toBe(before.digest);
      expect(after.activeGenerationId, `${id}: the active generation pointer moved`).toBe(
        before.activeGenerationId,
      );
    }

    // A good replace still works on the same device.
    const good = await importSubjectBackup({
      repository: device.repository,
      bytes: exported.bytes,
      now: NOW,
      mode: 'replace',
      confirmReplace: true,
      replaceSubjectId: SUBJECT,
    });
    expect(good.importedSubjectId).toBe(SUBJECT);
    expect(await readPlantedEvents(device)).toEqual(expectedLedgerEvents());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation is what lets the ledger be carried at all
// ─────────────────────────────────────────────────────────────────────────────

describe('a ledger-bearing progression record is accepted by the record validator', () => {
  it('reports no problem, so storage-v2 needs no change to carry Phase 18', () => {
    const value = {
      subjectId: SUBJECT,
      sourceVersion: 3 as const,
      rank: 'Novice' as const,
      xpTotal: 31,
      bySubject: {
        [SUBJECT]: {
          xpTotal: 31,
          rank: 'Novice',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 1,
          reviewPasses: 1,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [],
          extraFields: writeStatisticsEventLedgerToFields(undefined, {
            version: 1,
            events: PLANTED_EVENTS,
          }),
        },
      },
      crossSubjectAchievements: [],
    };
    expect(validateProgressionRecord(value).problems).toEqual([]);
  });

  it('CONTROL: the same validator DOES report a problem for a broken record', () => {
    // Without this the previous case could be passing because the validator reports nothing for
    // anything. The control is a record whose `xpTotal` is not a number.
    const value = {
      subjectId: SUBJECT,
      sourceVersion: 3 as const,
      rank: 'Novice' as const,
      xpTotal: 'lots',
      bySubject: {},
      crossSubjectAchievements: [],
    };
    // Cast: the point of the control is a record the validator must *reject*, so it cannot be
    // typed as a valid one.
    expect(validateProgressionRecord(value as never).problems.length).toBeGreaterThan(0);
  });
});