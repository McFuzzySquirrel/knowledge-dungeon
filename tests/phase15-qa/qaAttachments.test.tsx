/**
 * QA's independent probe for exit criterion 4: image attachment and preview work locally.
 *
 * ## Why this is a separate probe from the implementers'
 *
 * Their file drives the workspace's image panel. This one drives the **store port** the
 * command calls, with a real `fake-indexeddb` device-local store, and then reads the bytes
 * back out through the store's own resolver. That is the trip the criterion names - pick,
 * store on this device, resolve for preview - and a DOM assertion on a mocked resolver would
 * not exercise any of it.
 *
 * The run-time network observation is duplicated here on purpose. `tests/privacy/
 * uploadBoundary.test.ts` proves the *shape* (no forbidden construct is reachable); this
 * proves the *behaviour* for the exact path the criterion names, including the external-link
 * path, which records a URL and must never resolve it.
 *
 * Hermeticity: `fake-indexeddb` is imported for this file only, the device-local attachment
 * store is closed and its database deleted between tests, and the subject store's own write
 * is stubbed as everywhere else.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

import 'fake-indexeddb/auto';

import {
  closeDeviceLocalAttachmentStore,
  deleteDeviceLocalAttachmentDatabase,
  readAttachmentBytes,
} from '@/services/persistence/v2/attachmentBytes';
import { encounterController } from '@/store/encounterCommands';
import { useSubjectStore } from '@/store/subjectStore';
import { SCRIBE_CONTROL_IDS } from '@/ui/study/controlIds';
import { ScribeEncounterDialog } from '@/ui/study/scribe/ScribeEncounter';
import { useSessionStore } from '@/store/sessionStore';
import { TARGET_ROOM, buildQaFixture } from './qaFixtures';

const FILE_NAME = 'qa-synthetic-pixel.png';
const FILE_ALT = 'qa synthetic pixel';
const EXTERNAL_URL = 'https://example.invalid/qa-external.png';

/** A 1x1 transparent PNG, written out so the fixture carries real bytes. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

let fetchSpy: MockInstance;
let xhrOpenSpy: MockInstance;
let beaconSpy: MockInstance;
let beaconPropertyWasOwn: boolean;

function room() {
  const found = useSubjectStore.getState().snapshot?.rooms[TARGET_ROOM];
  if (found === undefined) throw new Error('no target room');
  return found;
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(`refused: ${result.error.message}`);
  return result.value;
}

function pickableFile(): File {
  const file = new File([PNG_BYTES], FILE_NAME, { type: 'image/png' });
  return file;
}

beforeEach(async () => {
  window.localStorage.clear();
  await closeDeviceLocalAttachmentStore();
  await deleteDeviceLocalAttachmentDatabase();
  const fixture = buildQaFixture();
  useSubjectStore.setState({ snapshot: fixture.snapshot, lastError: null });
  useSessionStore.setState({
    phase: 'scribe',
    isNoteEditorOpen: true,
    noteEditorRoomId: TARGET_ROOM,
    noteEditorPendingInsert: null,
  });
  fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
  xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
  // jsdom implements no `navigator.sendBeacon`, so there is nothing to spy on. The absence
  // is itself the fact worth pinning: install a stub and require it to stay untouched.
  beaconPropertyWasOwn = Object.prototype.hasOwnProperty.call(navigator, 'sendBeacon');
  beaconSpy = vi.fn();
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: beaconSpy,
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  xhrOpenSpy.mockRestore();
  if (beaconPropertyWasOwn) {
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: vi.fn() });
  } else {
    delete (navigator as unknown as Record<string, unknown>).sendBeacon;
  }
  cleanup();
  await closeDeviceLocalAttachmentStore();
  await deleteDeviceLocalAttachmentDatabase();
});

describe('criterion 4: a picked image is stored on this device and previews from those bytes', () => {
  it('round-trips the bytes through the real device-local store and resolves a blob URL', async () => {
    const outcome = expectOk(
      await encounterController.addAttachment({ roomId: TARGET_ROOM, file: pickableFile() }),
    );

    expect(outcome.attachment).not.toBeNull();
    const attachment = outcome.attachment!;
    expect(attachment.sourceType).toBe('local');
    expect(attachment.fileName).toBe(FILE_NAME);
    expect(attachment.mimeType).toBe('image/png');
    // Device-local means the bytes are addressed by attachment id and there is *no*
    // external URL to resolve - the two things an upload would have produced.
    expect(attachment.attachmentId).toBeTruthy();
    expect(attachment.externalUrl).toBeUndefined();
    expect(attachment.relativePath).toBeUndefined();

    // The bytes really are in the device-local store, byte for byte.
    const stored = await readAttachmentBytes(attachment.attachmentId);
    expect(stored).not.toBeNull();
    expect(stored!.byteLength).toBe(PNG_BYTES.length);
    expect([...stored!.bytes.slice(0, 8)]).toEqual([...PNG_BYTES.slice(0, 8)]);
    expect([...stored!.bytes]).toEqual([...PNG_BYTES]);

    // And the room carries it.
    expect(room().attachments.map((entry) => entry.attachmentId)).toEqual([
      attachment.attachmentId,
    ]);

    // The preview source the composer renders resolves to a local object URL, not to a
    // network address. This is the "preview works locally" half of the criterion.
    const resolved = await useSubjectStore
      .getState()
      .resolveAttachmentUrl(TARGET_ROOM, attachment.attachmentId);
    expect(resolved).toMatch(/^blob:/);

    // No request of any kind was made to get there.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpenSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
  });

  it('records an external link as a link and never dereferences it', async () => {
    const outcome = expectOk(
      await encounterController.addExternalAttachment({
        roomId: TARGET_ROOM,
        url: EXTERNAL_URL,
      }),
    );
    expect(outcome.attachment).not.toBeNull();
    expect(outcome.attachment!.sourceType).toBe('external');
    expect(outcome.attachment!.externalUrl).toBe(EXTERNAL_URL);

    const resolved = await useSubjectStore
      .getState()
      .resolveAttachmentUrl(TARGET_ROOM, outcome.attachment!.attachmentId);
    expect(resolved).toBe(EXTERNAL_URL);
    // The URL is returned as data, not fetched.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpenSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
  });

  it('removes the attachment, its device-local bytes, and its preview', async () => {
    const local = expectOk(
      await encounterController.addAttachment({ roomId: TARGET_ROOM, file: pickableFile() }),
    ).attachment!;
    const external = expectOk(
      await encounterController.addExternalAttachment({
        roomId: TARGET_ROOM,
        url: EXTERNAL_URL,
      }),
    ).attachment!;
    expect(room().attachments).toHaveLength(2);

    await encounterController.removeAttachment({
      roomId: TARGET_ROOM,
      attachmentId: local.attachmentId,
    });
    expect(room().attachments.map((entry) => entry.attachmentId)).toEqual([
      external.attachmentId,
    ]);
    // The bytes went with it, so a preview cannot resurrect them.
    expect(await readAttachmentBytes(local.attachmentId)).toBeNull();

    await encounterController.removeAttachment({
      roomId: TARGET_ROOM,
      attachmentId: external.attachmentId,
    });
    expect(room().attachments).toEqual([]);
  });

  it('refuses to remove an attachment that is not there (QA floor)', async () => {
    await encounterController.addAttachment({ roomId: TARGET_ROOM, file: pickableFile() });
    const before = room().attachments.length;

    const refusal = await encounterController.removeAttachment({
      roomId: TARGET_ROOM,
      attachmentId: 'att-not-real',
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error('unreachable');
    expect(refusal.error.code).toBe('ROOM_NOT_FOUND');
    expect(room().attachments).toHaveLength(before);
  });

  it('declines to attach to a room that does not exist', async () => {
    const outcome = await encounterController.addAttachment({
      roomId: 'r-not-a-room',
      file: pickableFile(),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.code).toBe('ROOM_NOT_FOUND');
  });
});

describe('criterion 4 in the DOM: the image library previews and offers remove', () => {
  it('renders a local preview image whose src is the resolved blob URL', async () => {
    expectOk(
      await encounterController.addAttachment({ roomId: TARGET_ROOM, file: pickableFile() }),
    );

    render(<ScribeEncounterDialog />);

    const libraryButton = await screen.findByRole('button', { name: /images \(1\)/i });
    libraryButton.click();

    const image = await waitFor(() => {
      const found = document.querySelector<HTMLImageElement>(
        `#${SCRIBE_CONTROL_IDS.imageLibrary} img`,
      );
      if (found === null) throw new Error('no preview image yet');
      return found;
    });
    expect(image.src).toMatch(/^blob:/);
    // The accessible name carries the file's alt text, which is derived from its name.
    expect(image.alt).toBe(FILE_ALT);
    // Removal is offered with the file name in the visible label, so a screen-reader user
    // knows which image they are removing.
    const remove = screen.getByRole('button', { name: `Remove ${FILE_NAME}` });
    expect(remove).toBeInTheDocument();
    // ...and a per-attachment insert that adds a `local:` markdown token.
    const insert = screen.getByRole('button', { name: `Insert ${FILE_NAME} in the note` });
    expect(within(insert.closest('li') as HTMLElement).getByText(FILE_NAME)).toBeInTheDocument();

    remove.click();
    await waitFor(() => {
      expect(
        useSubjectStore.getState().snapshot?.rooms[TARGET_ROOM].attachments,
      ).toEqual([]);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});