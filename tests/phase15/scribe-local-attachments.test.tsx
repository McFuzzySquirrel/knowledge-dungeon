/**
 * Exit criterion 4: image attachment and preview work locally.
 *
 * Plan section 2.3: web image attachments are stored in IndexedDB on the device and are no
 * longer uploaded to `/api/upload`. This file drives the redesigned workspace's own image
 * path end to end - pick, attach, preview, insert into the note, remove - and asserts the
 * whole trip: the bytes come back out of the device-local store, the room gains a *local*
 * attachment, the preview resolves from those bytes, and **no network call of any kind is
 * made**.
 *
 * ## Why the request assertion is here as well as in the privacy gate
 *
 * `tests/privacy/uploadBoundary.test.ts` scans the import graph statically. That gate is the
 * stronger statement and it must keep passing, but a static scan cannot see a request made
 * by a library the workspace calls. So the same boundary is also asserted at run time, with
 * `fetch`, `XMLHttpRequest.open`, and `navigator.sendBeacon` observed for the duration of
 * each test. Both halves matter: the static gate proves the shape, this one proves the
 * behaviour.
 *
 * Spies rather than replacements: `vi.spyOn` observes a request without removing the
 * machinery a library might legitimately need to construct, so a failure here means "a
 * request was made", not "the request API was missing".
 *
 * ## Hermeticity
 *
 * jsdom implements no IndexedDB, so the in-memory shim is installed for this file only - it
 * must not reach `vitest.setup.ts`, because the rest of the suite characterises current
 * behaviour against real `localStorage`.
 *
 * Privacy: the payload is a synthetic byte array written out in `scribeFixtures.ts`, and the
 * only host named is the reserved `example.invalid`, which is never dereferenced.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, scribeEncounterWorkspace: true },
  };
});

import 'fake-indexeddb/auto';

import {
  closeDeviceLocalAttachmentStore,
  deleteDeviceLocalAttachmentDatabase,
  readAttachmentBytes,
} from '@/services/persistence/v2/attachmentBytes';
import { resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { SCRIBE_CONTROL_IDS } from '@/ui/study/controlIds';
import { ScribeEncounterDialog } from '@/ui/study/scribe/ScribeEncounter';
import {
  FIXTURE_DUNGEON_ID,
  SYNTHETIC_PNG,
  buildScribeFixture,
  type ScribeFixture,
} from './support/scribeFixtures';

const EXTERNAL_URL = 'https://example.invalid/scribe-phase15-external.png';
const FILE_NAME = 'scribe-phase15-synthetic.png';
/** What `altTextFor` derives from `FILE_NAME`, and therefore what the inserted token reads. */
const FILE_ALT = 'scribe phase15 synthetic';

let fixture: ScribeFixture;

function snapshot() {
  const live = useSubjectStore.getState().snapshot;
  if (live === null) throw new Error('No snapshot installed');
  return live;
}

function room() {
  const live = snapshot().rooms[fixture.matrixRoomId];
  if (live === undefined) throw new Error('No matrix room');
  return live;
}

function pickedFile(): File {
  return new File([new Uint8Array(SYNTHETIC_PNG)], FILE_NAME, { type: 'image/png' });
}

/**
 * Put a file into the input.
 *
 * `Object.defineProperty` rather than `fireEvent.change(input, { target: { files } })`:
 * jsdom's `files` is a read-only accessor, and redefining it on the element is the shape the
 * existing device-local suite uses, so this is proven rather than new.
 */
function pickFile(file: File | null): void {
  const input = document.getElementById(SCRIBE_CONTROL_IDS.attachLocal);
  if (input === null) throw new Error('No file input');
  Object.defineProperty(input, 'files', {
    value: file === null ? [] : [file],
    configurable: true,
  });
  fireEvent.change(input);
}

/** Open the images panel, which starts closed. */
function openImages(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Images (0)' }));
}

function renderEncounter(): void {
  render(<ScribeEncounterDialog />);
}

/**
 * Run a body with every request path observed, then assert none of them was used.
 *
 * Every spy is a local, so this file needs no module-level mock types and the assertion
 * cannot be satisfied by a stale spy from a previous test.
 */
async function withoutRequests(body: () => Promise<void> | void): Promise<void> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
  const beaconSpy = vi.fn();
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beaconSpy });
  try {
    await body();
    expect(fetchSpy, 'fetch was called').not.toHaveBeenCalled();
    expect(xhrSpy, 'XMLHttpRequest.open was called').not.toHaveBeenCalled();
    expect(beaconSpy, 'navigator.sendBeacon was called').not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
}

beforeEach(async () => {
  window.localStorage.clear();
  resetRepositorySelection();
  closeDeviceLocalAttachmentStore();
  await deleteDeviceLocalAttachmentDatabase();

  fixture = buildScribeFixture();
  useSubjectStore.setState({ snapshot: fixture.snapshot, lastError: null });
  useSessionStore.setState({
    phase: 'scribe',
    activeScreen: 'game',
    isNoteEditorOpen: true,
    noteEditorRoomId: fixture.matrixRoomId,
    noteEditorPendingInsert: null,
  });
  useProgressionStore.setState({ bySubject: {}, crossSubjectAchievements: [], collectedNotes: [] });
  useProgressionStore.getState().setActiveSubject(FIXTURE_DUNGEON_ID);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  closeDeviceLocalAttachmentStore();
  await deleteDeviceLocalAttachmentDatabase();
});

describe('a picked image stays on this device', () => {
  it('attaches, previews from the stored bytes, and issues no request', async () => {
    await withoutRequests(async () => {
      renderEncounter();
      openImages();
      expect(screen.getByText('No room images yet.')).toBeInTheDocument();

      pickFile(pickedFile());

      await waitFor(() => expect(room().attachments).toHaveLength(1));
      const attachment = room().attachments[0];
      if (attachment === undefined) throw new Error('No attachment');
      expect(attachment.sourceType).toBe('local');
      expect(attachment.fileName).toBe(FILE_NAME);
      expect(attachment.mimeType).toBe('image/png');
      // Not an external link back at a server: there is no server.
      expect(attachment.externalUrl).toBeUndefined();
      expect(attachment.relativePath).toBeUndefined();

      // The bytes are genuinely here, and they are the bytes that were picked.
      const stored = await readAttachmentBytes(attachment.attachmentId);
      expect(Array.from(stored?.bytes ?? new Uint8Array())).toEqual([...SYNTHETIC_PNG]);

      // The preview resolves out of that store, not out of a URL that was fetched.
      await waitFor(() => {
        const preview = document.querySelector<HTMLImageElement>('.scribe-image-card__image');
        expect(preview?.getAttribute('src')).toMatch(/^blob:/);
      });
      expect(screen.getByText('Saved on this device')).toBeInTheDocument();
    });
  });

  it('round-trips: attach, insert into the note, preview it, then remove', async () => {
    await withoutRequests(async () => {
      renderEncounter();
      openImages();
      pickFile(pickedFile());
      await waitFor(() => expect(room().attachments).toHaveLength(1));
      const attachmentId = room().attachments[0]?.attachmentId ?? '';
      await waitFor(() =>
        expect(document.querySelector('.scribe-image-card__image')).not.toBeNull(),
      );

      // Insert puts a `local:` reference in the active section, never a URL.
      fireEvent.click(screen.getByRole('button', { name: `Insert ${FILE_NAME} in the note` }));
      expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveValue(
        `![${FILE_ALT}](local:${attachmentId})`,
      );

      // The preview renders the inserted reference out of the device-local bytes.
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      await waitFor(() => {
        const preview = document.querySelector<HTMLImageElement>('.scribe-composer__preview img');
        expect(preview?.getAttribute('src')).toMatch(/^blob:/);
      });

      // Remove forgets the attachment and its bytes. The images panel stayed open across the
      // preview toggle, which is why the control is reachable without reopening anything.
      fireEvent.click(screen.getByRole('button', { name: `Remove ${FILE_NAME}` }));

      await waitFor(() => expect(room().attachments).toHaveLength(0));
      expect(await readAttachmentBytes(attachmentId)).toBeNull();
      expect(screen.getByText('No room images yet.')).toBeInTheDocument();
    });
  });

  it('counts the image in the encounter state the learner is shown', async () => {
    await withoutRequests(async () => {
      renderEncounter();
      expect(screen.getByText('Images attached to this room: 0')).toBeInTheDocument();

      openImages();
      pickFile(pickedFile());

      await waitFor(() =>
        expect(screen.getByText('Images attached to this room: 1')).toBeInTheDocument(),
      );
    });
  });

  it('records nothing when the learner cancels the picker', async () => {
    await withoutRequests(async () => {
      renderEncounter();
      openImages();

      // A file input with no selection is a cancellation, not a zero-byte image.
      pickFile(null);

      await waitFor(() => expect(screen.getByText('No room images yet.')).toBeInTheDocument());
      expect(room().attachments).toHaveLength(0);
    });
  });
});

describe('an externally hosted image is recorded, never downloaded', () => {
  it('records the link, previews it from the recorded value, and issues no request', async () => {
    await withoutRequests(async () => {
      renderEncounter();
      openImages();
      fireEvent.click(screen.getByRole('button', { name: 'Add an image link' }));

      fireEvent.change(screen.getByRole('textbox', { name: 'Image link' }), {
        target: { value: EXTERNAL_URL },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Record this image link' }));

      await waitFor(() => expect(room().attachments).toHaveLength(1));
      const attachment = room().attachments[0];
      if (attachment === undefined) throw new Error('No attachment');
      expect(attachment.sourceType).toBe('external');
      expect(attachment.externalUrl).toBe(EXTERNAL_URL);

      await waitFor(() => {
        const preview = document.querySelector<HTMLImageElement>('.scribe-image-card__image');
        expect(preview?.getAttribute('src')).toBe(EXTERNAL_URL);
      });
      expect(screen.getByText('A link, kept as a link')).toBeInTheDocument();
      // The single strongest statement in this file: the URL was stored, not dereferenced.
    });
  });

  it('refuses an empty link with the reason next to the control', () => {
    renderEncounter();
    openImages();
    fireEvent.click(screen.getByRole('button', { name: 'Add an image link' }));

    const record = screen.getByRole('button', { name: 'Record this image link' });
    expect(record).toBeDisabled();
    expect(screen.getByText('Type an image link before recording it.')).toBeInTheDocument();
    expect(room().attachments).toHaveLength(0);
  });
});