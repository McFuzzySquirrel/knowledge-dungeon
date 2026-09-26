/**
 * Phase 4 privacy gate, test 3: external attachment URLs are never fetched.
 *
 * Plan section 2.3: "External image URLs remain user-provided external content
 * and are not silently downloaded into backups", and the Phase 4 non-goal "No
 * automated external image downloading." The Phase 4 scope also requires that
 * external attachment URLs be preserved "without automatic background
 * fetching".
 *
 * The gate has two halves that must both hold:
 *
 * 1. **Source level.** No module reachable from `src/main.tsx` passes a
 *    user-supplied external attachment URL, or any non-same-origin destination,
 *    to a network API. The scan is proved non-vacuous by asserting that the
 *    modules which *handle* external attachment URLs are in the graph, so a
 *    graph that silently stopped containing them cannot pass.
 * 2. **Unit level.** The resolve path returns the stored external URL to the
 *    renderer without contacting a network, and a migrated external attachment
 *    is represented as unavailable bytes (`availability: 'external-only'`,
 *    `contentHash: null`, zero stored bytes) rather than as a download.
 *
 * Declared scope limit: the note editor and room panel render a user-supplied
 * external URL in an `<img src=...>`. That is a user-initiated display of a URL
 * the learner typed, not a background download, and it is explicitly not
 * covered here. What is covered is any programmatic fetch of such a URL, and
 * whether it happens is observed by the browser lane in
 * `tests/e2e/storageV2.spec.ts`, which treats an external request as a policy
 * violation.
 *
 * Privacy: the only host in this file is the reserved `example.invalid`, and it
 * is never dereferenced. `fetch` is stubbed and asserted to be unused.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  describeFindings,
  scanGraphForNetworkRules,
  walkAppGraph,
  type NetworkRule,
} from './support/appGraph';
import { useSubjectStore } from '@/store/subjectStore';
import { fixedClock } from '@/services/persistence/v2/database';
import {
  buildMigratedRecords,
  migrateLegacyState,
} from '@/services/persistence/v2/migrations';
import { readLegacyAppState } from '@/services/persistence/v2/legacyReader';
import type {
  AttachmentMetadataRecordValue,
  ExternalOnlyAttachmentReport,
  MigrationReport,
} from '@/services/persistence/v2/schema';
import {
  deleteTestDatabase,
  openTestRepository,
  readSubjectFixture,
  MIGRATION_NOW,
} from '../migrations/support/storageV2TestSupport';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';
import type { RoomAttachment, RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';

const GENERATION_ID = 'gen-privacy-external-0001';
const NOW = MIGRATION_NOW;
const SUBJECT_ID = 'subject-privacy-external';
const ROOM_ID = 'room-privacy-external';
const EXTERNAL_URL = 'https://example.invalid/synthetic-external-attachment.png';

/** Rules that would mean a network request left the device. */
const NETWORK_ESCAPE_RULES: readonly NetworkRule[] = [
  'absolute-network-destination',
  'external-attachment-fetch',
  'unresolved-network-destination',
  'xhr-construction',
  'beacon-post',
  'websocket-construction',
  'eventsource-construction',
  'import-scripts-call',
  'uploads-path-literal',
];

/** A legacy room holding a historical external URL and a server-hosted path. */
function hostileLegacySubject(): string {
  const payload = JSON.parse(readSubjectFixture('subject-1.1.0-full-unknown-fields.json')) as {
    dungeon: Record<string, unknown>;
    rooms: Record<string, Record<string, unknown>>;
  };
  const room = Object.values(payload.rooms)[0] as Record<string, unknown>;
  room.attachments = [
    {
      attachmentId: 'att-privacy-historical-external',
      sourceType: 'external',
      fileName: 'privacy-synthetic-historical.png',
      mimeType: 'image/png',
      externalUrl: EXTERNAL_URL,
      altText: 'privacy synthetic historical alt',
      addedAt: NOW,
    },
    {
      attachmentId: 'att-privacy-server-hosted',
      sourceType: 'local',
      fileName: 'privacy-synthetic-server-hosted.png',
      mimeType: 'image/png',
      relativePath: 'uploads/privacy-synthetic-server-hosted.png',
      altText: 'privacy synthetic server hosted alt',
      addedAt: NOW,
    },
  ];
  return JSON.stringify(payload);
}

function seedLegacyKeys(subjectId: string, subjectJson: string): void {
  const storage = window.localStorage;
  storage.setItem('knowledge-dungeon:v1:subjects', JSON.stringify([subjectId]));
  storage.setItem(`knowledge-dungeon:v1:subject:${subjectId}`, subjectJson);
  storage.setItem('knowledge-dungeon:v1:activeSubjectId', subjectId);
}

let repository: StorageV2Repository | null = null;
let databaseName = '';
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  window.localStorage.clear();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(async () => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  useSubjectStore.getState().setSnapshot(null);
  repository?.close();
  repository = null;
  if (databaseName) await deleteTestDatabase(databaseName);
  databaseName = '';
});

describe('Phase 4 privacy gate 3a: no module in the application graph fetches an external attachment URL', () => {
  it('finds the external-attachment code in the graph, so the scan is not vacuous', () => {
    const graph = walkAppGraph();
    const paths = graph.modules.map((module) => module.path);

    // The modules that read `attachment.externalUrl` really are in the graph.
    // Without this, a walker that stopped reaching them would report a clean
    // tree and mean nothing.
    for (const path of [
      'src/ui/components/NoteEditorModal.tsx',
      'src/ui/components/RoomPanel.tsx',
      'src/store/subjectStore.ts',
    ]) {
      expect(paths).toContain(path);
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source, path).toContain('externalUrl');
    }

    // The application really does create external attachments, so the guarantee
    // is about transport, not about the feature being absent.
    const persistence = readFileSync(
      join(process.cwd(), 'src/services/persistence/subjectPersistence.ts'),
      'utf8',
    );
    expect(persistence).toContain("sourceType: 'external'");
  });

  it('never passes a non-same-origin destination to a network API from the app graph', async () => {
    const graph = walkAppGraph();
    const scan = scanGraphForNetworkRules(graph);

    // The live same-origin loads are counted, so "no escape rules" cannot mean
    // "no network code at all".
    //
    // Phase 4 removed the third call site this floor used to count: the
    // `fetch('/api/upload', …)` in the note editor, which is the defect the phase
    // exists to remove. The floor therefore drops to the two real same-origin
    // asset loads that remain, and each is named rather than counted, so a graph
    // that lost a live call site entirely would fail here instead of passing on a
    // smaller number.
    const { scanModuleForNetworkRules } = await import('./support/appGraph');
    const liveCallSites = ['src/services/spriteManifest.ts', 'src/ui/components/MakeItYoursTab.tsx'].map(
      (file) => scanModuleForNetworkRules(file, readFileSync(join(process.cwd(), file), 'utf8')).callSites,
    );
    expect(liveCallSites).toEqual([1, 1]);
    expect(scan.callSites).toBeGreaterThanOrEqual(2);
    expect(scan.sameOriginCalls).toBe(scan.callSites);

    const escapes = scan.findings.filter((finding) => NETWORK_ESCAPE_RULES.includes(finding.rule));
    expect(escapes, describeFindings(escapes)).toEqual([]);
  });

  it('never builds a request body, an XHR, a socket, or a worker from a user-supplied URL', () => {
    const graph = walkAppGraph();
    const bodies = scanGraphForNetworkRules(graph).findings.filter(
      (finding) =>
        finding.rule === 'formdata-construction' ||
        finding.rule === 'xhr-construction' ||
        finding.rule === 'beacon-post' ||
        finding.rule === 'websocket-construction' ||
        finding.rule === 'eventsource-construction' ||
        finding.rule === 'import-scripts-call',
    );
    // Recorded, not asserted empty: `NoteEditorModal` still builds a FormData
    // for the pre-cutover upload path, which test 1 owns. What must never exist
    // is an XHR, a socket, an event source, or a worker import.
    expect(bodies.filter((finding) => finding.rule !== 'formdata-construction')).toEqual([]);
  });
});

describe('Phase 4 privacy gate 3b: the resolve path returns a URL without a request', () => {
  function snapshotWith(attachments: readonly RoomAttachment[]): SubjectSnapshot {
    const room: RoomMetadata = {
      roomId: ROOM_ID,
      topic: 'Privacy synthetic room topic',
      createdAt: NOW,
      updatedAt: NOW,
      state: 'Uncreated',
      notePath: '',
      artifactPath: '',
      noteText: '',
      artifactMarkdown: null,
      validationState: {
        wordCount: 0,
        requiredSectionsPresent: false,
        manualConfirmed: false,
        criterionScores: {
          sectionCompleteness: 0,
          conceptTermCoverage: 0,
          linkReferences: 0,
          recallQuestionQuality: 0,
          clarityReadability: 0,
        },
        failedChecks: [],
        qualityBonus: 0,
        finalPass: false,
      },
      reviewPassCount: 0,
      attachments: [...attachments],
    };
    return {
      dungeon: {
        dungeonId: SUBJECT_ID,
        subjectName: 'Privacy synthetic subject',
        schemaVersion: '1.1.0',
        createdAt: NOW,
        updatedAt: NOW,
        rootRoomId: ROOM_ID,
        rooms: [{ roomId: ROOM_ID, topic: room.topic, depth: 0, parentRoomId: null, children: [] }],
        biome: 'knowledge-dungeon',
        isTemplate: false,
      },
      rooms: { [ROOM_ID]: room },
    } as unknown as SubjectSnapshot;
  }

  it('resolves an external attachment to its stored URL with zero network calls', async () => {
    useSubjectStore.getState().setSnapshot(
      snapshotWith([
        {
          attachmentId: 'att-privacy-resolve-external',
          sourceType: 'external',
          fileName: 'privacy-synthetic-external.png',
          mimeType: 'image/png',
          externalUrl: EXTERNAL_URL,
          addedAt: NOW,
        },
      ]),
    );

    const resolved = await useSubjectStore
      .getState()
      .resolveAttachmentUrl(ROOM_ID, 'att-privacy-resolve-external');

    expect(resolved).toBe(EXTERNAL_URL);
    // The value came out of the snapshot, not out of the network.
    expect(fetchSpy).not.toHaveBeenCalled();
    // A resolution attempt is not a reason to create an image request either.
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('reports a local attachment as unresolvable on the web build instead of fetching it', async () => {
    useSubjectStore.getState().setSnapshot(
      snapshotWith([
        {
          attachmentId: 'att-privacy-resolve-local',
          sourceType: 'local',
          fileName: 'privacy-synthetic-local.png',
          mimeType: 'image/png',
          relativePath: 'uploads/privacy-synthetic-local.png',
          addedAt: NOW,
        },
      ]),
    );

    const resolved = await useSubjectStore
      .getState()
      .resolveAttachmentUrl(ROOM_ID, 'att-privacy-resolve-local');

    // The web build has no Electron bridge and no device-local byte store yet,
    // so resolution honestly reports nothing rather than reaching for the old
    // `/uploads/` path. Phase 4's application change is what makes this return
    // device-local bytes.
    expect(resolved).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(await useSubjectStore.getState().resolveAttachmentUrl(ROOM_ID, 'att-privacy-absent')).toBeNull();
    expect(await useSubjectStore.getState().resolveAttachmentUrl('room-privacy-absent', 'att-privacy-resolve-local')).toBeNull();
  });
});

describe('Phase 4 privacy gate 3c: a migrated external attachment is unavailable bytes, not a download', () => {
  it('records both historical attachment kinds as external-only with no bytes and no hash', async () => {
    seedLegacyKeys(SUBJECT_ID, hostileLegacySubject());

    databaseName = 'kd-privacy-external-migration';
    repository = await openTestRepository(databaseName, NOW);
    const outcome = await migrateLegacyState({
      repository,
      generationId: GENERATION_ID,
      now: NOW,
      clock: fixedClock(NOW),
    });

    expect(outcome.report.status).toBe('migrated');

    const report: MigrationReport = outcome.report;
    expect(report.attachments.total).toBe(2);
    // Nothing was downloaded, so nothing is stored and nothing is hashed.
    expect(report.attachments.storedBytes).toBe(0);
    expect(report.attachments.externalOnly).toBe(2);
    expect(report.recordCounts.attachmentBlobs).toBe(0);

    const reports: ExternalOnlyAttachmentReport[] = report.externalOnlyAttachments;
    expect(reports.map((entry) => entry.attachmentId).sort()).toEqual([
      'att-privacy-historical-external',
      'att-privacy-server-hosted',
    ]);
    for (const entry of reports) {
      expect(entry.contentHash).toBeNull();
      expect(entry.byteLength).toBeNull();
      expect(Object.keys(entry).sort()).toEqual([
        'attachmentId',
        'byteLength',
        'contentHash',
        'reason',
        'roomId',
        'sourceType',
        'subjectId',
      ]);
    }
    const byId = new Map(reports.map((entry) => [entry.attachmentId, entry]));
    expect(byId.get('att-privacy-historical-external')?.reason).toBe('historical-external-url');
    expect(byId.get('att-privacy-historical-external')?.sourceType).toBe('external');
    // A legacy `/uploads/` reference has no recoverable bytes either, and the
    // report says so rather than pretending the image is available.
    expect(byId.get('att-privacy-server-hosted')?.reason).toBe('bytes-not-recoverable');
    expect(byId.get('att-privacy-server-hosted')?.sourceType).toBe('local');

    // The records agree with the report, and no blob record was produced.
    const records = await repository.readRecords(GENERATION_ID);
    expect(records.records.attachmentBlobs).toEqual([]);
    expect(records.records.attachmentMetadata).toHaveLength(2);
    for (const envelope of records.records.attachmentMetadata) {
      const value = envelope.value as AttachmentMetadataRecordValue;
      expect(value.availability).toBe('external-only');
      expect(value.contentHash).toBeNull();
    }

    // The migration is a pure local transform: no network call at any point.
    expect(fetchSpy).not.toHaveBeenCalled();

    // And the legacy keys are untouched, so a rollback still reads them.
    expect(window.localStorage.getItem(`knowledge-dungeon:v1:subject:${SUBJECT_ID}`)).toBe(
      hostileLegacySubject(),
    );
  });

  it('never reports a URL, a filename, or an alt text in the external-only disclosure', () => {
    seedLegacyKeys(SUBJECT_ID, hostileLegacySubject());
    const state = readLegacyAppState();
    const built = buildMigratedRecords(state, { now: NOW, generationId: GENERATION_ID });
    const text = JSON.stringify(built.externalOnly);

    // A disclosure the learner could paste into a bug report must be safe to
    // share: opaque ids, a reason code, and counts.
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('privacy-synthetic');
    expect(text).toContain('att-privacy-historical-external');
    for (const entry of built.externalOnly) {
      expect(Object.keys(entry).sort()).toEqual([
        'attachmentId',
        'byteLength',
        'contentHash',
        'reason',
        'roomId',
        'sourceType',
        'subjectId',
      ]);
    }
  });
});
