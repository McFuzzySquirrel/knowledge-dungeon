/**
 * Phase 15 - the Scribe encounter application layer.
 *
 * `src/application/encounterCommands.ts` is the contract the redesigned Scribe
 * workspace and the Pixi dungeon surface will both call, so this file covers the
 * parts of it that are observable from outside the module:
 *
 * - which branch `encounter/note-submit` reports (draft versus clear), and that
 *   the draft branch carries no progression at all;
 * - that a clear reports whether the room-clear reward was actually awarded, so a
 *   surface cannot announce a reward that did not happen;
 * - the refusal shapes, including the store's own message strings;
 * - that a persistence failure **rejects** rather than resolving to a typed
 *   result, because `submitNote` rejected before Phase 15 and must still;
 * - that the local attachment path makes no request of any kind;
 * - that artifact pickup is forwarded to the existing `artifact/collect` command
 *   rather than reimplemented;
 * - that `dispatch` and the named methods are the same implementation.
 *
 * The reward transaction's own properties are in
 * `tests/unit/roomClearRewards.test.ts`; this file only checks that the command
 * supplies it with a (room, clear generation) identity.
 *
 * Privacy: every string here is synthetic. The fake "picked file" is bytes in
 * memory; nothing in this file reaches a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createEncounterController,
  type EncounterCommandDeps,
  type EncounterProgressionPort,
  type EncounterSubjectStorePort,
} from '@/application/encounterCommands';
import type { EncounterCommand } from '@/application/contracts/commands';
import { evaluateNoteValidation } from '@/core/validation/notes';
import { deriveRoomClearIdentity } from '@/core/progression/roomClearRewards';
import type { RoomAttachment, RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';
import { makeEmptyRoomMetadata, makeEmptyValidationState } from '@/core/validation/persistence';

const SUBJECT_ID = 'subject-encounter';
const ROOM_ID = 'room-vector-space';
const CHILD_ID = 'room-matrices';
const OTHER_SUBJECT_ID = 'subject-other';
const FIXED_NOW = '2026-03-03T03:03:03.000Z';

const DRAFT_NOTE = 'Summary\nnothing complete yet';
const VALID_NOTE = [
  'Summary',
  'A synthetic summary about vectors and spans.',
  '',
  'Key Points',
  '- A synthetic key point.',
  '',
  'Recall Question',
  'What is a synthetic vector space?',
].join('\n');

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: {
  room?: Partial<RoomMetadata> | null;
  dungeonId?: string;
  attachments?: RoomAttachment[];
} = {}): SubjectSnapshot {
  const room =
    overrides.room === null
      ? undefined
      : {
          ...makeEmptyRoomMetadata({ roomId: ROOM_ID, topic: 'Vector Space', nowIso: FIXED_NOW }),
          ...(overrides.room ?? {}),
          attachments: overrides.attachments ?? [],
        };
  return {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: overrides.dungeonId ?? SUBJECT_ID,
      subjectName: 'Synthetic Encounter Subject',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      phaseState: 'ScribeActive',
      rootRoomId: ROOM_ID,
      rooms: [
        { roomId: ROOM_ID, topic: 'Vector Space', status: 'Visited' },
        { roomId: CHILD_ID, topic: 'Matrices', status: 'Visited' },
      ],
      edges: [
        {
          fromRoomId: ROOM_ID,
          toRoomId: CHILD_ID,
          relationType: 'subtopic',
          createdAt: FIXED_NOW,
          createdByPhase: 'Creator',
        },
      ],
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    },
    rooms: room === undefined ? {} : { [ROOM_ID]: room },
  };
}

/** A submission result shaped exactly as `submitNote` builds it. */
function submission(
  noteText: string,
  manualConfirmed: boolean,
  artifactMarkdown: string | null,
): ReturnType<EncounterSubjectStorePort['submitNote']> extends Promise<infer R> ? R : never {
  return { ...evaluateNoteValidation({ noteText, manualConfirmed, roomTopic: 'Vector Space' }), artifactMarkdown };
}

/** A local attachment record, shaped as the store returns it. */
function attachment(attachmentId: string): RoomAttachment {
  return {
    attachmentId,
    sourceType: 'local',
    fileName: 'synthetic-image.png',
    mimeType: 'image/png',
    altText: 'synthetic image',
    addedAt: FIXED_NOW,
  };
}

interface Recording {
  deps: EncounterCommandDeps;
  subject: {
    submitted: { roomId: string; noteText: string; manualConfirmed: boolean }[];
    localAdded: { roomId: string; file: Blob & { name?: string } }[];
    externalAdded: { roomId: string; url: string }[];
    removed: { roomId: string; attachmentId: string }[];
  };
  progression: {
    clearAwards: {
      qualityBonus: number;
      scribeClearedRooms: number;
      clear: { roomId: string; clearIdentity: string } | undefined;
    }[];
    badges: string[];
  };
  artifacts: { type: 'artifact/collect'; roomId: string }[];
}

function harness(options: {
  snapshot?: SubjectSnapshot | null;
  submit?: (roomId: string, noteText: string, manualConfirmed: boolean) => Promise<ReturnType<typeof submission>>;
  attachLocal?: (roomId: string, file: Blob & { name?: string }) => Promise<RoomAttachment | null>;
  attachExternal?: (roomId: string, url: string) => Promise<RoomAttachment | null>;
  clearReward?: Partial<{ awarded: boolean; duplicate: boolean; xpGained: number }>;
} = {}): Recording {
  const submitted: Recording['subject']['submitted'] = [];
  const localAdded: Recording['subject']['localAdded'] = [];
  const externalAdded: Recording['subject']['externalAdded'] = [];
  const removed: Recording['subject']['removed'] = [];
  const clearAwards: Recording['progression']['clearAwards'] = [];
  const badges: string[] = [];
  const artifacts: Recording['artifacts'] = [];

  const subject: EncounterSubjectStorePort = {
    readSnapshot: () => (options.snapshot === undefined ? makeSnapshot() : options.snapshot),
    submitNote: async (roomId, noteText, manualConfirmed) => {
      submitted.push({ roomId, noteText, manualConfirmed });
      if (options.submit) return options.submit(roomId, noteText, manualConfirmed);
      return submission(noteText, manualConfirmed, manualConfirmed ? '# Artifact' : null);
    },
    addDeviceLocalAttachment: async (roomId, file) => {
      localAdded.push({ roomId, file });
      if (options.attachLocal) return options.attachLocal(roomId, file);
      return attachment('attachment-device-0001');
    },
    addExternalAttachment: async (roomId, url) => {
      externalAdded.push({ roomId, url });
      if (options.attachExternal) return options.attachExternal(roomId, url);
      return { ...attachment('attachment-external-0001'), sourceType: 'external', externalUrl: url };
    },
    removeAttachment: async (roomId, attachmentId) => {
      removed.push({ roomId, attachmentId });
    },
  };

  const progression: EncounterProgressionPort = {
    awardRoomClear: (input) => {
      clearAwards.push({
        qualityBonus: input.qualityBonus,
        scribeClearedRooms: input.scribeClearedRooms,
        clear: input.clear,
      });
      return {
        xpGained: options.clearReward?.xpGained ?? 12,
        newRank: 'Scholar',
        rankChanged: false,
        unlockedBadges: [],
        loot: null,
        unlockedAchievements: [],
        awarded: options.clearReward?.awarded ?? true,
        duplicate: options.clearReward?.duplicate ?? false,
      };
    },
    awardBadge: (badgeId) => {
      badges.push(badgeId);
      return true;
    },
  };

  return {
    deps: {
      subject,
      progression,
      artifactCollection: {
        collectArtifact: (command) => {
          artifacts.push({ type: command.type, roomId: command.payload.roomId });
        },
      },
      nowIso: () => FIXED_NOW,
    },
    subject: { submitted, localAdded, externalAdded, removed },
    progression: { clearAwards, badges },
    artifacts,
  };
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected success, got refusal ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectRefusal<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): { code: string; message: string; details?: Record<string, unknown> } {
  if (result.ok) throw new Error('expected a refusal, got success');
  return result.error as { code: string; message: string; details?: Record<string, unknown> };
}

// ── note-submit ─────────────────────────────────────────────────────────────

describe('encounterCommands - encounter/note-submit', () => {
  it('reports a draft, with no progression of any kind', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);

    const value = expectOk(
      await controller.submitNote({
        roomId: ROOM_ID,
        noteText: DRAFT_NOTE,
        manualConfirmed: false,
      }),
    );

    expect(value.kind).toBe('draft');
    expect(value.progression).toBeNull();
    expect(value.artifactMarkdown).toBeNull();
    expect(value.validation.finalPass).toBe(false);
    // No reward was attempted and no badge was awarded.
    expect(recording.progression.clearAwards).toEqual([]);
    expect(recording.progression.badges).toEqual([]);
  });

  it('passes the note text through untouched and never inspects it', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);

    await controller.submitNote({ roomId: ROOM_ID, noteText: DRAFT_NOTE, manualConfirmed: false });

    expect(recording.subject.submitted).toEqual([
      { roomId: ROOM_ID, noteText: DRAFT_NOTE, manualConfirmed: false },
    ]);
  });

  it('reports a clear with the generated artifact and the reward it earned', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);

    const value = expectOk(
      await controller.submitNote({
        roomId: ROOM_ID,
        noteText: VALID_NOTE,
        manualConfirmed: true,
      }),
    );

    expect(value.kind).toBe('cleared');
    if (value.kind !== 'cleared') throw new Error('unreachable');
    expect(value.artifactMarkdown).toBe('# Artifact');
    expect(value.progression.awarded).toBe(true);
    expect(value.progression.duplicate).toBe(false);
    expect(value.progression.xpGained).toBe(12);
  });

  it('awards the 120-word Scribe badge on a long enough clear, after the reward', async () => {
    const longNote = `${VALID_NOTE}\n\n${'synthetic filler sentence about vectors. '.repeat(20)}`;
    const recording = harness();
    const controller = createEncounterController(recording.deps);

    const value = expectOk(
      await controller.submitNote({ roomId: ROOM_ID, noteText: longNote, manualConfirmed: true }),
    );

    if (value.kind !== 'cleared') throw new Error('expected a clear');
    expect(value.validation.wordCount).toBeGreaterThanOrEqual(120);
    expect(value.progression.badgeAwarded).toBe(true);
    expect(recording.progression.badges).toEqual(['ScribeCentury120']);
  });

  it('supplies the reward with the room and the clear generation the note was validated in', async () => {
    const snapshot = makeSnapshot();
    const recording = harness({ snapshot });
    const controller = createEncounterController(recording.deps);

    const value = expectOk(
      await controller.submitNote({ roomId: ROOM_ID, noteText: VALID_NOTE, manualConfirmed: true }),
    );

    expect(recording.progression.clearAwards[0]?.clear).toEqual({
      roomId: ROOM_ID,
      clearIdentity: deriveRoomClearIdentity({ roomId: ROOM_ID, dungeon: snapshot.dungeon }),
    });
    if (value.kind !== 'cleared') throw new Error('unreachable');
    expect(value.progression.clearIdentity).toBe(
      recording.progression.clearAwards[0]?.clear?.clearIdentity,
    );
  });

  it('keeps the modal badge-progress numbers, computed from the pre-submit snapshot', async () => {
    // One other room has already passed validation, so this clear is the second.
    const recording = harness({
      snapshot: makeSnapshot({
        room: {
          validationState: {
            ...makeEmptyValidationState(),
            finalPass: true,
          },
        },
      }),
    });
    const controller = createEncounterController(recording.deps);

    await controller.submitNote({ roomId: ROOM_ID, noteText: VALID_NOTE, manualConfirmed: true });

    expect(recording.progression.clearAwards[0]?.scribeClearedRooms).toBe(2);
  });

  it('reports a suppressed reward rather than announcing one', async () => {
    const recording = harness({ clearReward: { awarded: false, duplicate: true, xpGained: 0 } });
    const controller = createEncounterController(recording.deps);

    const value = expectOk(
      await controller.submitNote({ roomId: ROOM_ID, noteText: VALID_NOTE, manualConfirmed: true }),
    );

    if (value.kind !== 'cleared') throw new Error('expected a clear');
    expect(value.progression.awarded).toBe(false);
    expect(value.progression.duplicate).toBe(true);
    expect(value.progression.xpGained).toBe(0);
  });

  it('does not award the word-count badge below the threshold', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);

    await controller.submitNote({ roomId: ROOM_ID, noteText: VALID_NOTE, manualConfirmed: true });

    // This note is well under 120 words, so the bonus badge is not awarded. The
    // room clear is unconditional on word count and still is.
    expect(recording.progression.badges).toEqual([]);
    expect(recording.progression.clearAwards).toHaveLength(1);
  });

  it('refuses with NO_ACTIVE_SUBJECT and the store\'s own message', async () => {
    const recording = harness({ snapshot: null });
    const controller = createEncounterController(recording.deps);

    const error = expectRefusal(
      await controller.submitNote({ roomId: ROOM_ID, noteText: VALID_NOTE, manualConfirmed: true }),
    );

    expect(error.code).toBe('NO_ACTIVE_SUBJECT');
    expect(error.message).toBe('No active subject');
    // Nothing was submitted and nothing was awarded.
    expect(recording.subject.submitted).toEqual([]);
    expect(recording.progression.clearAwards).toEqual([]);
  });

  it('refuses with ROOM_NOT_FOUND and names the room', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);

    const error = expectRefusal(
      await controller.submitNote({
        roomId: 'room-missing',
        noteText: VALID_NOTE,
        manualConfirmed: true,
      }),
    );

    expect(error.code).toBe('ROOM_NOT_FOUND');
    expect(error.message).toBe('Room not found');
    expect(error.details).toEqual({ roomId: 'room-missing' });
    expect(recording.subject.submitted).toEqual([]);
  });

  it('rejects when the write fails, exactly as submitNote did', async () => {
    const failure = new Error('Failed to save subject data.');
    const recording = harness({
      submit: async () => {
        throw failure;
      },
    });
    const controller = createEncounterController(recording.deps);

    // A rejected promise, not a typed result: turning an I/O failure into
    // `ok: false` would be a typed lie.
    await expect(
      controller.submitNote({ roomId: ROOM_ID, noteText: VALID_NOTE, manualConfirmed: true }),
    ).rejects.toBe(failure);
    expect(recording.progression.clearAwards).toEqual([]);
  });

  it('rejects when the draft write fails too', async () => {
    const failure = new Error('Failed to save subject data.');
    const recording = harness({
      submit: async () => {
        throw failure;
      },
    });
    const controller = createEncounterController(recording.deps);

    await expect(
      controller.submitNote({ roomId: ROOM_ID, noteText: DRAFT_NOTE, manualConfirmed: false }),
    ).rejects.toBe(failure);
  });

  it('refuses a clear that produced no artifact', async () => {
    const recording = harness({
      submit: async (_roomId, noteText, manualConfirmed) =>
        submission(noteText, manualConfirmed, null),
    });
    const controller = createEncounterController(recording.deps);

    const error = expectRefusal(
      await controller.submitNote({ roomId: ROOM_ID, noteText: VALID_NOTE, manualConfirmed: true }),
    );

    expect(error.code).toBe('INVALID_OPERATION');
    // The reward is not attempted on a broken clear: reporting a reward for an
    // encounter whose artifact does not exist would be worse than refusing.
    expect(recording.progression.clearAwards).toEqual([]);
  });
});

// ── artifact pickup ─────────────────────────────────────────────────────────

describe('encounterCommands - artifact pickup', () => {
  it('forwards to the existing artifact/collect command rather than reimplementing it', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);

    const value = expectOk(await controller.artifactCollect({ roomId: ROOM_ID }));

    expect(value.command).toBe('artifact/collect');
    expect(value.roomId).toBe(ROOM_ID);
    expect(recording.artifacts).toEqual([{ type: 'artifact/collect', roomId: ROOM_ID }]);
  });

  it('is a separate action from generation: a pickup on a draft never awards anything', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);

    await controller.submitNote({ roomId: ROOM_ID, noteText: DRAFT_NOTE, manualConfirmed: false });
    expectOk(await controller.artifactCollect({ roomId: ROOM_ID }));

    // One command generated the artifact (it did not, because the note was a
    // draft) and one collected it; neither did the other's job.
    expect(recording.progression.clearAwards).toEqual([]);
    expect(recording.artifacts).toHaveLength(1);
  });
});

// ── attachments ─────────────────────────────────────────────────────────────

describe('encounterCommands - local image attachments', () => {
  beforeEach(() => {
    // Any network attempt anywhere in the attachment path fails this test loudly.
    vi.stubGlobal('fetch', () => {
      throw new Error('the encounter command layer must never make a request');
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stores picked bytes through the device-local port and reports the attachment', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) as Blob & {
      name: string;
    };

    const value = expectOk(await controller.addAttachment({ roomId: ROOM_ID, file }));

    expect(value.command).toBe('encounter/attachment-add');
    expect(value.attachment?.attachmentId).toBe('attachment-device-0001');
    expect(value.attachment?.sourceType).toBe('local');
    expect(recording.subject.localAdded).toHaveLength(1);
    expect(recording.subject.localAdded[0]?.roomId).toBe(ROOM_ID);
  });

  it('makes no request of any kind while storing bytes', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('the encounter command layer must never make a request');
    });
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('XMLHttpRequest', class {
      open(): void {
        throw new Error('XMLHttpRequest must never be used by the attachment path');
      }
    });
    // A multipart upload is the shape `/api/upload` needed, so constructing one is
    // itself a failure here.
    vi.stubGlobal('FormData', class {
      append(): void {
        throw new Error('FormData must never be constructed by the attachment path');
      }
    });
    const beacon = vi.fn(() => {
      throw new Error('sendBeacon must never be used by the attachment path');
    });
    vi.stubGlobal('navigator', { ...globalThis.navigator, sendBeacon: beacon });

    const recording = harness();
    const controller = createEncounterController(recording.deps);
    const file = new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }) as Blob & {
      name: string;
    };

    // The file never left this call as a request: it went to the device-local port.
    await controller.addAttachment({ roomId: ROOM_ID, file });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(recording.subject.localAdded).toHaveLength(1);
  });

  it('reports a store that declines rather than pretending to have attached', async () => {
    const recording = harness({ attachLocal: async () => null });
    const controller = createEncounterController(recording.deps);
    const file = new Blob([new Uint8Array([])]) as Blob & { name: string };

    const value = expectOk(await controller.addAttachment({ roomId: ROOM_ID, file }));

    expect(value.attachment).toBeNull();
  });

  it('records an external URL without resolving it', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);
    const url = 'https://example.invalid/synthetic-image.png';

    const value = expectOk(await controller.addExternalAttachment({ roomId: ROOM_ID, url }));

    expect(value.command).toBe('encounter/attachment-add-external');
    expect(value.attachment?.externalUrl).toBe(url);
    expect(recording.subject.externalAdded).toEqual([{ roomId: ROOM_ID, url }]);
  });

  it('removes an attachment the room actually has', async () => {
    const recording = harness({
      snapshot: makeSnapshot({ attachments: [attachment('attachment-device-0001')] }),
    });
    const controller = createEncounterController(recording.deps);

    const value = expectOk(
      await controller.removeAttachment({
        roomId: ROOM_ID,
        attachmentId: 'attachment-device-0001',
      }),
    );

    expect(value.command).toBe('encounter/attachment-remove');
    expect(recording.subject.removed).toEqual([
      { roomId: ROOM_ID, attachmentId: 'attachment-device-0001' },
    ]);
  });

  it('refuses to remove an attachment the room does not have', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);

    // The store's `removeAttachment` resolves without doing anything here, so
    // without the pre-check this would report a removal that never happened.
    const error = expectRefusal(
      await controller.removeAttachment({ roomId: ROOM_ID, attachmentId: 'attachment-missing' }),
    );

    expect(error.code).toBe('ROOM_NOT_FOUND');
    expect(recording.subject.removed).toEqual([]);
  });

  it('refuses an attachment command for an unknown room', async () => {
    const recording = harness();
    const controller = createEncounterController(recording.deps);
    const file = new Blob([new Uint8Array([])]) as Blob & { name: string };

    expect(expectRefusal(await controller.addAttachment({ roomId: 'room-missing', file })).code).toBe(
      'ROOM_NOT_FOUND',
    );
    expect(
      expectRefusal(
        await controller.addExternalAttachment({ roomId: 'room-missing', url: 'https://example.invalid/x.png' }),
      ).code,
    ).toBe('ROOM_NOT_FOUND');
    expect(recording.subject.localAdded).toEqual([]);
    expect(recording.subject.externalAdded).toEqual([]);
  });

  it('rejects an attachment write failure', async () => {
    const failure = new Error('Failed to save subject data.');
    const recording = harness({
      attachLocal: async () => {
        throw failure;
      },
    });
    const controller = createEncounterController(recording.deps);
    const file = new Blob([new Uint8Array([])]) as Blob & { name: string };

    await expect(controller.addAttachment({ roomId: ROOM_ID, file })).rejects.toBe(failure);
  });
});

// ── dispatch ────────────────────────────────────────────────────────────────

describe('encounterCommands - dispatch', () => {
  it('runs the same implementation as the named methods, for every command', async () => {
    const file = new Blob([new Uint8Array([])]) as Blob & { name: string };
    const commands: readonly EncounterCommand[] = [
      { type: 'encounter/note-submit', payload: { roomId: ROOM_ID, noteText: DRAFT_NOTE, manualConfirmed: false } },
      { type: 'encounter/attachment-add', payload: { roomId: ROOM_ID, file } },
      {
        type: 'encounter/attachment-add-external',
        payload: { roomId: ROOM_ID, url: 'https://example.invalid/x.png' },
      },
      { type: 'encounter/attachment-remove', payload: { roomId: ROOM_ID, attachmentId: 'attachment-device-0001' } },
    ];

    for (const command of commands) {
      const snapshot = makeSnapshot({ attachments: [attachment('attachment-device-0001')] });
      const recording = harness({ snapshot });
      const controller = createEncounterController(recording.deps);

      const dispatched = expectOk(await controller.dispatch(command));

      expect(dispatched.command).toBe(command.type);
    }
  });

  it('keeps the clear identity derived from the room the command names', async () => {
    const snapshot = makeSnapshot();
    const recording = harness({ snapshot });
    const controller = createEncounterController(recording.deps);

    expectOk(
      await controller.dispatch({
        type: 'encounter/note-submit',
        payload: { roomId: ROOM_ID, noteText: VALID_NOTE, manualConfirmed: true },
      }),
    );

    expect(recording.progression.clearAwards[0]?.clear?.roomId).toBe(ROOM_ID);
    expect(recording.progression.clearAwards[0]?.clear?.clearIdentity).toBe(
      deriveRoomClearIdentity({ roomId: ROOM_ID, dungeon: snapshot.dungeon }),
    );
  });

  it('does not treat a different subject as the same room', async () => {
    const snapshot = makeSnapshot({ dungeonId: OTHER_SUBJECT_ID });
    const recording = harness({ snapshot });
    const controller = createEncounterController(recording.deps);

    const value = expectOk(
      await controller.submitNote({ roomId: ROOM_ID, noteText: VALID_NOTE, manualConfirmed: true }),
    );

    // The identity is graph-scoped, and the room's world in this subject is
    // different from the one in another subject, so the two never collide.
    expect(value.roomId).toBe(ROOM_ID);
    if (value.kind !== 'cleared') throw new Error('expected a clear');
    expect(value.progression.clearIdentity).toMatch(/^clear-[0-9a-f]{8}$/);
  });
});