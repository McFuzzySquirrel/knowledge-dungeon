/**
 * Builds the reference `.kdbak` the Phase 5 gates attack, from a real populated
 * device.
 *
 * One function, used by every gate, so the "good" archive is byte-identical
 * across the round-trip, attachment-bytes, corruption, external-only, and
 * manifest gates. A baseline that differed per gate would make a difference in
 * outcome impossible to attribute.
 *
 * The reference archive is produced with the **audited production codec**
 * (`writeArchive`), so the good archive is the same kind of archive the product
 * will write. Its `state.json` and `manifest.json` members are built to the
 * plan's fixed layout, and its `attachments/<sha256>` members are content
 * addressed, which is what makes the corruption cases that tamper with a member
 * body tamper with a *named* member rather than with an arbitrary file.
 *
 * Privacy: the member names are fixed, opaque, and self-describing. No subject
 * name, topic, note, filename, or URL appears in any member name.
 */

import { STORAGE_V2_STORE_NAMES } from '@/services/persistence/v2/schema';
import { platformSha256 } from './hashes';
import { buildReferenceArchive, type ReferenceArchive, type ReferenceArchiveInput } from './hostileZip';
import { ATTACHMENT_IDS, SPRITE_PATH, type PopulatedDevice } from './populatedDevice';
import { buildStateDocument } from './stateDocument';
import { EXTERNAL_ONLY_REASON_BY_SOURCE } from './productInterface';
import type { GenerationSnapshot } from '@/services/persistence/v2/repository';

/** The fixed clock the reference archive stamps into its manifest. */
export const REFERENCE_CREATED_AT = '2026-09-26T00:00:00.000Z';

/**
 * Per-store record counts, derived from the *staged* values rather than declared
 * by hand, so a count in the manifest is a claim about real records.
 */
export function referenceRecordCounts(snapshot: GenerationSnapshot): Record<string, number> {
  const records = snapshot.records as unknown as Record<string, unknown[]>;
  const counts: Record<string, number> = {};
  for (const store of STORAGE_V2_STORE_NAMES) counts[store] = 0;
  counts.subjects = records.subjects.length;
  counts.progression = records.progression.length;
  counts.sessions = records.sessions.length;
  counts.preferences = records.preferences.length;
  counts.shortcuts = records.shortcuts.length;
  counts.assistance = records.assistance.length;
  counts.attachments = records.attachmentMetadata.length + records.attachmentBlobs.length;
  counts.customSprites = records.customSprites.length;
  counts.recovery = records.recovery.length;
  counts.migrationReceipts = records.migrationReceipts.length;
  return counts;
}

/** The reference archive input for a device's active generation. */
export function referenceArchiveInput(
  device: PopulatedDevice,
  snapshot: GenerationSnapshot,
): ReferenceArchiveInput {
  const stateJson = buildStateDocument(device, snapshot, REFERENCE_CREATED_AT);
  const attachmentMetadata = (
    snapshot.records as unknown as Record<string, { value: unknown }[]>
  ).attachmentMetadata.map((envelope) => envelope.value as Record<string, unknown>);

  // Only attachments whose bytes are on the device become members. The
  // external-only one contributes a disclosure and no member, which is the
  // honest behaviour plan section 2.3 requires.
  const storedIds = attachmentMetadata
    .filter((record) => record.availability === 'stored')
    .map((record) => String(record.attachmentId));
  const attachmentMembers = storedIds
    .map((attachmentId) => {
      const bytes = device.payloadBytes.get(attachmentId);
      if (bytes === undefined) {
        throw new Error(`No payload bytes for stored attachment ${attachmentId}.`);
      }
      return { bytes, contentHash: platformSha256(bytes) };
    })
    // Deduplicated by content hash: two attachments with identical bytes are one
    // member, which is the content-addressing claim the gate has to hold.
    .filter(
      (member, index, all) =>
        all.findIndex((candidate) => candidate.contentHash === member.contentHash) === index,
    );

  const externalOnly = attachmentMetadata.filter(
    (record) => record.availability === 'external-only',
  );
  const reasons: Record<string, number> = {};
  for (const record of externalOnly) {
    const reason =
      EXTERNAL_ONLY_REASON_BY_SOURCE[String(record.sourceType)] ?? 'bytes-not-recoverable';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }

  const customSprites = (
    snapshot.records as unknown as Record<string, { value: unknown }[]>
  ).customSprites.map((envelope) => envelope.value as Record<string, unknown>);
  const spriteRecords = customSprites
    .filter((record) => record.spritePath === SPRITE_PATH)
    .map((record) => ({
      bytes: new TextEncoder().encode(String(record.content)),
      // The extension is the record's `kind`, which is an opaque, fixed token
      // and is exactly the kind of name a member path is allowed to carry.
      extension: String(record.kind),
    }));

  const recovery = (
    snapshot.records as unknown as Record<string, { value: unknown }[]>
  ).recovery.map((envelope) => envelope.value as Record<string, unknown>);

  return {
    stateJson,
    attachmentMembers,
    customSpriteMembers: spriteRecords,
    recoveryMembers: recovery.map((record) => ({
      bytes: new TextEncoder().encode(String(record.raw)),
    })),
    createdAt: REFERENCE_CREATED_AT,
    recordCounts: referenceRecordCounts(snapshot),
    externalOnly: { count: externalOnly.length, reasons },
  };
}

/** Build the reference archive for a device's active generation. */
export function referenceArchiveForDevice(
  device: PopulatedDevice,
  snapshot: GenerationSnapshot,
): ReferenceArchive {
  return buildReferenceArchive(referenceArchiveInput(device, snapshot));
}

/** The attachment ids the device claims have bytes on it. */
export const STORED_ATTACHMENT_IDS: readonly string[] = [
  ATTACHMENT_IDS.storedOne,
  ATTACHMENT_IDS.storedTwo,
  ATTACHMENT_IDS.storedThree,
];
