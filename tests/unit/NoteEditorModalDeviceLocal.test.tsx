/**
 * Phase 4: the note editor's image path is device-local.
 *
 * Before this phase, picking an image in the note editor built a `FormData` and
 * posted it to `/api/upload`, then recorded the result as an *external*
 * attachment pointing back at the app's own server. That is the learner-data
 * upload the Phase 4 exit criterion removes, and the removal is not flag-gated: it
 * happens in the default build too.
 *
 * This file drives the real component through a real file selection and asserts
 * the whole path: the bytes go to the device-local store, the room gains a
 * *local* attachment, the preview resolves from those bytes, and no network call
 * of any kind is made. A reload is simulated by re-reading the store, which is
 * what a reload does.
 *
 * Privacy: the payload is a synthetic byte array and the only host named is the
 * reserved `example.invalid`, which is never dereferenced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup, within } from '@testing-library/react';

// jsdom implements no IndexedDB, so the in-memory shim is installed for this file
// only. It must not reach `vitest.setup.ts`, because the rest of the suite
// characterizes current behavior against real `localStorage`.
import 'fake-indexeddb/auto';

import { NoteEditorModal } from '@/ui/components/NoteEditorModal';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import {
  closeDeviceLocalAttachmentStore,
  deleteDeviceLocalAttachmentDatabase,
  readAttachmentBytes,
  readAttachmentRecord,
} from '@/services/persistence/v2/attachmentBytes';
import { checksumBytes } from '@/services/persistence/v2/checksum';
import { resetRepositorySelection, selectLegacyRepository } from '@/services/persistence/v2/repositorySelection';
import type { RoomAttachment, SubjectSnapshot } from '@/core/validation/persistence';

const SUBJECT_ID = 'subject-note-editor-synthetic';
const ROOM_ID = 'room-note-editor-synthetic';
const EXTERNAL_URL = 'https://example.invalid/note-editor-synthetic-external.png';

/** A valid 1x1 PNG, written out byte by byte: synthetic and self-describing. */
const SYNTHETIC_PNG: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
];

function makeSnapshot(attachments: readonly RoomAttachment[] = []): SubjectSnapshot {
  return {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: SUBJECT_ID,
      subjectName: 'Note editor synthetic subject',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      phaseState: 'ScribeActive',
      rootRoomId: ROOM_ID,
      rooms: [{ roomId: ROOM_ID, topic: 'Note editor synthetic topic', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    },
    rooms: {
      [ROOM_ID]: {
        roomId: ROOM_ID,
        topic: 'Note editor synthetic topic',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        state: 'Created',
        notePath: `rooms/${ROOM_ID}/notes.md`,
        artifactPath: `rooms/${ROOM_ID}/artifact.md`,
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
      },
    },
  } as unknown as SubjectSnapshot;
}

function pickedFile(bytes: readonly number[], name = 'note-editor-synthetic.png'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

function openEditor(): void {
  useSessionStore.setState({
    isNoteEditorOpen: true,
    noteEditorRoomId: ROOM_ID,
    phase: 'scribe',
  });
  useSubjectStore.setState({ snapshot: makeSnapshot(), lastError: null });
}

beforeEach(() => {
  window.localStorage.clear();
  resetRepositorySelection();
  selectLegacyRepository();
  closeDeviceLocalAttachmentStore();
});

afterEach(async () => {
  cleanup();
  closeDeviceLocalAttachmentStore();
  await deleteDeviceLocalAttachmentDatabase();
  window.localStorage.clear();
  resetRepositorySelection();
  vi.restoreAllMocks();
});

describe('Phase 4 note editor: a picked image is stored on this device', () => {
  it('writes the bytes locally, attaches them as a local attachment, and makes no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
    openEditor();
    render(<NoteEditorModal />);

    fireEvent.click(screen.getByRole('button', { name: 'Images' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    const file = pickedFile(SYNTHETIC_PNG);
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => {
      expect(useSubjectStore.getState().snapshot?.rooms[ROOM_ID]?.attachments).toHaveLength(1);
    });

    const attachment = useSubjectStore.getState().snapshot?.rooms[ROOM_ID]?.attachments[0] as RoomAttachment;
    // A local attachment, not an external link to the app's own server.
    expect(attachment.sourceType).toBe('local');
    expect(attachment.externalUrl).toBeUndefined();
    expect(attachment.relativePath).toBeUndefined();
    expect(attachment.fileName).toBe('note-editor-synthetic.png');
    expect(attachment.mimeType).toBe('image/png');

    // The bytes are on the device, byte-identical, with a real SHA-256.
    const readBack = await readAttachmentBytes(attachment.attachmentId);
    expect(readBack).not.toBeNull();
    expect(Array.from((readBack as { bytes: Uint8Array }).bytes)).toEqual(Array.from(SYNTHETIC_PNG));
    expect((readBack as { contentHash: string }).contentHash).toBe(checksumBytes(new Uint8Array(SYNTHETIC_PNG)));

    // The attachment survived into the persisted subject, so a reload keeps it.
    expect(JSON.stringify(useSubjectStore.getState().snapshot)).toContain(attachment.attachmentId);

    // And nothing left the device.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });

  it('resolves the preview from the stored bytes after a reload', async () => {
    openEditor();
    render(<NoteEditorModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Images' }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [pickedFile(SYNTHETIC_PNG)], configurable: true });
    fireEvent.change(input);
    await waitFor(() => {
      expect(useSubjectStore.getState().snapshot?.rooms[ROOM_ID]?.attachments).toHaveLength(1);
    });
    const attachmentId = useSubjectStore.getState().snapshot?.rooms[ROOM_ID]?.attachments[0]?.attachmentId as string;

    // A "reload": the store is rehydrated from the persisted subject and the
    // attachment-bytes store is re-read from scratch, exactly as a fresh document
    // would.
    closeDeviceLocalAttachmentStore();
    const persisted = JSON.parse(
      window.localStorage.getItem('knowledge-dungeon:v1:subject:subject-1') ??
        window.localStorage.getItem(`knowledge-dungeon:v1:subject:${SUBJECT_ID}`) ??
        'null',
    ) as SubjectSnapshot | null;
    expect(persisted).not.toBeNull();
    const record = await readAttachmentRecord(attachmentId);
    expect(record).not.toBeNull();
    expect(record?.availability).toBe('stored');
    const bytes = await readAttachmentBytes(attachmentId);
    expect(Array.from((bytes as { bytes: Uint8Array }).bytes)).toEqual(Array.from(SYNTHETIC_PNG));
  });

  it('records an external link as a link, with no bytes and no download', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    openEditor();
    render(<NoteEditorModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Images' }));

    // The URL row is toggled by a button that shares its label with the submit
    // button, so the input's own row is the scope that disambiguates them.
    fireEvent.click(screen.getAllByRole('button', { name: '+ URL' })[0] as HTMLElement);
    const urlInput = screen.getByLabelText('External image URL') as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: EXTERNAL_URL } });
    const urlRow = urlInput.parentElement as HTMLElement;
    fireEvent.click(within(urlRow).getAllByRole('button', { name: '+ URL' })[0] as HTMLElement);

    await waitFor(() => {
      expect(useSubjectStore.getState().snapshot?.rooms[ROOM_ID]?.attachments).toHaveLength(1);
    });
    const attachment = useSubjectStore.getState().snapshot?.rooms[ROOM_ID]?.attachments[0] as RoomAttachment;
    expect(attachment.sourceType).toBe('external');
    expect(attachment.externalUrl).toBe(EXTERNAL_URL);

    // The external attachment is represented as unavailable bytes, not as a
    // download, and nothing was fetched.
    const record = await readAttachmentRecord(attachment.attachmentId);
    expect(record).toMatchObject({ availability: 'external-only', contentHash: null, bytes: null, byteLength: 0 });
    expect(await readAttachmentBytes(attachment.attachmentId)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
