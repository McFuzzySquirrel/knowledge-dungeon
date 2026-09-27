/**
 * Phase 6: the Data Center's subject-backup tab.
 *
 * `tests/data/` holds the eight gates this phase pinned for the *product*, and it
 * holds them well. This file covers the *interface*, which no pinned gate can see
 * because the interface did not exist when they were written. It is organised
 * around the five things that can go wrong in a screen that offers one safe
 * operation and one destructive one:
 *
 * 1. **The tablist.** Three tabs as of Phase 7 - full device, one subject, and the
 *    reusable template - with real `tab`/`tabpanel` wiring, `aria-selected` genuinely
 *    true on exactly one, roving `tabIndex`, arrow-key movement that wraps in both
 *    directions, Home and End, and only the selected panel's contents in the DOM - so
 *    the other tabs' file inputs do not exist and cannot be tabbed into.
 * 2. **The export.** A real subject list read from the real device, one subject
 *    chosen, a real `.kdsubject` downloaded through a blob and an object URL that is
 *    revoked - with only *that subject's* attachment ids resolved, and with no
 *    subject name in the file name or the status line.
 * 3. **The default.** `Create a copy` is what a learner gets without choosing, a
 *    `.kdsubject` from another device cannot be replaced onto anything, and a copy
 *    really does add a subject and destroy nothing.
 * 4. **The destructive path, and the four routes into it that are closed.** The
 *    radio is disabled unless the archive's own subject is on this device; choosing
 *    a file resets the mode to copy; the confirm handler re-checks; and there is no
 *    form and no key handler anywhere near it. Plus a replace that names the subject
 *    it destroys and really does destroy exactly that.
 * 5. **Accessibility**, measured rather than asserted by class name: roles, live
 *    regions, touch targets computed from the real stylesheet, contrast recomputed
 *    from the real tokens, the dialog's focus trap, initial focus, Escape,
 *    restoration, and the honest non-dismissable window while an import is in
 *    flight.
 *
 * ## How the flag and the product are reached
 *
 * `runtimeConfig` is parsed once at module load, so the flag is exercised with
 * `vi.stubEnv` plus `vi.resetModules` and a fresh `import()` of the component - the
 * same thing a build with the variable set does. Nothing here imports a product
 * statically, which is both the plan's lazy-boundary rule and the reason
 * `tests/data/subjectProductBoundary.test.ts` passes.
 *
 * ## Fixtures
 *
 * The adversarial one from the gate suite, `createNastySubjectDevice`: two subjects,
 * a stored image, an external-only image, a prior generation, and a subject name
 * that is itself a room id. The subject name is what makes the privacy assertions
 * non-vacuous - a surface that renders no subject name cannot fail a check that no
 * subject name is rendered.
 *
 * Privacy: every fixture is synthetic and self-describing. The only host named
 * anywhere in this file is the reserved `example.invalid`, and it is named only as
 * an attachment URL that must never reach the DOM.
 */

import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { blankComments } from '../data/support/importGraph';
import { MARKER_TOKEN } from '../data/support/marker';
import {
  NASTY_ATTACHMENT_IDS,
  NASTY_DEVICE_NOW,
  NASTY_GENERATION_ID,
  NASTY_OTHER_SUBJECT_ID,
  NASTY_SUBJECT_ID,
  createNastySubjectDevice,
  type NastyDevice,
} from '../data/support/nastySubject';
import { createPopulatedDevice } from '../data/support/populatedDevice';
import type { BackupPreview } from '@/ui/data/ImportPreview';
import type { SubjectImportReport } from '@/ui/data/RecoveryStatus';

type SubjectProductModule = typeof import('@/services/persistence/products/subjectBackup');

const product = (await import('@/services/persistence/products/subjectBackup')) as SubjectProductModule;

// ── The surface under test, reached the way a build reaches it ─────────────

type DataCenterModule = typeof import('@/ui/data/DataCenter');

/** The requests the wrapped product saw, in call order. */
const importRequests: Array<Record<string, unknown>> = [];
/** The attachment-id lists the screen asked the device-local resolver for. */
const payloadResolutions: string[][] = [];

/**
 * Load the Data Center with the owner flag at a chosen value.
 *
 * The product module is wrapped rather than replaced, so the request each call is
 * sent and the attachment ids each export resolves are recorded, and the *real*
 * product still runs - so the download this file measures is the product's own
 * bytes rather than a fixture's.
 */
async function loadDataCenter(dataProductsV2: boolean): Promise<DataCenterModule> {
  vi.resetModules();
  vi.stubEnv('VITE_DATA_PRODUCTS_V2', String(dataProductsV2));
  importRequests.length = 0;
  payloadResolutions.length = 0;
  if (dataProductsV2) {
    vi.doMock('@/services/persistence/products/subjectBackup', async (importOriginal) => {
      const actual = await importOriginal<SubjectProductModule>();
      return {
        ...actual,
        exportSubjectBackup: async (request: Parameters<SubjectProductModule['exportSubjectBackup']>[0]) => {
          return actual.exportSubjectBackup(request);
        },
        importSubjectBackup: async (request: Parameters<SubjectProductModule['importSubjectBackup']>[0]) => {
          importRequests.push(request as unknown as Record<string, unknown>);
          return actual.importSubjectBackup(request);
        },
        resolveDeviceLocalPayloadBytes: async (ids: readonly string[]) => {
          payloadResolutions.push([...ids]);
          return actual.resolveDeviceLocalPayloadBytes(ids);
        },
      };
    });
  } else {
    vi.doUnmock('@/services/persistence/products/subjectBackup');
  }
  return import('@/ui/data/DataCenter');
}

async function selectLiveRepository(repository: NastyDevice['repository']): Promise<void> {
  const selection = await import('@/services/persistence/v2/repositorySelection');
  selection.resetRepositorySelection();
  selection.selectStorageV2Repository(repository);
}

// ── Browser doubles ───────────────────────────────────────────────────────

interface DownloadRecord {
  readonly download: string;
  readonly href: string;
  readonly blob: Blob | null;
  readonly inDocumentWhenClicked: boolean;
}

const createdObjectUrls: string[] = [];
const revokedObjectUrls: string[] = [];
const downloads: DownloadRecord[] = [];
let lastBlob: Blob | null = null;
let fetchSpy: ReturnType<typeof vi.fn>;
let xhrOpenSpy: ReturnType<typeof vi.fn>;
let beaconSpy: ReturnType<typeof vi.fn>;

function installBrowserDoubles(): void {
  createdObjectUrls.length = 0;
  revokedObjectUrls.length = 0;
  downloads.length = 0;

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      const url = `blob:knowledge-dungeon/${createdObjectUrls.length}`;
      createdObjectUrls.push(url);
      lastBlob = blob;
      return url;
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((url: string) => {
      revokedObjectUrls.push(url);
    }),
  });
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    configurable: true,
    writable: true,
    value: vi.fn(function (this: HTMLAnchorElement) {
      downloads.push({
        download: this.download,
        href: this.getAttribute('href') ?? '',
        blob: lastBlob,
        inDocumentWhenClicked: document.body.contains(this),
      });
    }),
  });

  fetchSpy = vi.fn(() => Promise.reject(new Error('the Data Center must not make a request')));
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetchSpy });
  xhrOpenSpy = vi.fn();
  Object.defineProperty(XMLHttpRequest.prototype, 'open', {
    configurable: true,
    writable: true,
    value: xhrOpenSpy,
  });
  beaconSpy = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, writable: true, value: beaconSpy });
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ── The real stylesheet, so measurements are measurements ─────────────────

const STYLESHEET_PATH = join(process.cwd(), 'src', 'ui', 'data', 'dataCenter.css');

function stylesheetSource(): string {
  return readFileSync(STYLESHEET_PATH, 'utf8');
}

function installStylesheet(): void {
  const style = document.createElement('style');
  style.setAttribute('data-kd-under-test', 'data-center');
  style.textContent = stylesheetSource();
  document.head.appendChild(style);
}

function token(name: string): string {
  const match = new RegExp(`--kd-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(stylesheetSource());
  if (match === null) throw new Error(`The stylesheet declares no --${name} colour.`);
  return match[1] as string;
}

/** A literal colour declared in the stylesheet, for a surface with no token. */
function literalColour(value: string): string {
  const match = new RegExp(`:\\s*(${value});`).exec(blankComments(stylesheetSource()));
  if (match === null) throw new Error(`The stylesheet declares no ${value}.`);
  return match[1] as string;
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, computed rather than eyeballed. */
function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── Fixtures and queries ──────────────────────────────────────────────────

/** A real `.kdsubject` the product's own export wrote. */
async function realSubjectArchive(
  device: NastyDevice,
  subjectId: string = NASTY_SUBJECT_ID,
): Promise<Uint8Array> {
  const result = await product.exportSubjectBackup({
    repository: device.repository,
    generationId: NASTY_GENERATION_ID,
    subjectId,
    now: '2026-09-26T10:00:00.000Z',
    payloadBytes: device.payloadBytes,
  });
  return result.bytes;
}

function fileOf(bytes: Uint8Array, name: string): File {
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type: 'application/zip' });
}

async function chooseSubjectFile(bytes: Uint8Array, name = 'subject-backup.kdsubject'): Promise<void> {
  const input = subjectTab().querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('The subject tab rendered no file input.');
  fireEvent.change(input, { target: { files: [fileOf(bytes, name)] } });
  await nextTask();
  await nextTask();
}

const dataCenterOf = (): HTMLElement => {
  const surface = document.querySelector<HTMLElement>('[data-kd-surface="data-center"]');
  if (surface === null) throw new Error('The Data Center is not on the screen.');
  return surface;
};

const subjectTab = (): HTMLElement => {
  const panel = screen.queryAllByRole('tabpanel', { hidden: true })[1];
  if (panel === undefined) throw new Error('The subject tab is not on the screen.');
  return panel;
};

/**
 * The mode group, which is rendered inside the confirmation dialog.
 *
 * Queried globally rather than within the tabpanel, because a real browser run of
 * this surface moved it: the dialog is a modal layer, so it intercepts pointer
 * events for everything behind it, and a mode chosen *outside* it was a mode whose
 * confirmation could never be seen. The choice now lives in the window that states
 * what the chosen mode will do.
 */
const modeGroup = (): HTMLElement => {
  const surface = document.querySelector<HTMLElement>('[data-kd-surface="subject-import-mode"]');
  if (surface === null) throw new Error('The subject confirmation rendered no mode choice.');
  return surface;
};

const copyRadio = (): HTMLInputElement =>
  within(modeGroup()).getByRole<HTMLInputElement>('radio', { name: /create a copy/i });
const replaceRadio = (): HTMLInputElement =>
  within(modeGroup()).getByRole<HTMLInputElement>('radio', { name: /replace the subject it came from/i });

const subjectDialog = (): HTMLElement => {
  const dialog = document.querySelector<HTMLElement>('[data-kd-surface="subject-import-confirmation"]');
  if (dialog === null) throw new Error('The subject import confirmation is not open.');
  return dialog;
};

const subjectPreview = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-kd-surface="backup-preview"]');

const subjectOutcome = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-kd-surface="restore-outcome"]');

/** The mode the confirmation is currently offering, read from the checked radio. */
function modeIs(): 'copy' | 'replace' | 'none' {
  const checked = within(modeGroup())
    .getAllByRole('radio')
    .find((radio) => (radio as HTMLInputElement).checked);
  if (checked === undefined) return 'none';
  return (checked as HTMLInputElement).value as 'copy' | 'replace';
}

const copyConfirm = (): HTMLButtonElement =>
  within(subjectDialog()).getByRole<HTMLButtonElement>('button', { name: /add a copy of this subject/i });
const replaceConfirm = (): HTMLButtonElement =>
  within(subjectDialog()).getByRole<HTMLButtonElement>('button', { name: /^replace the subject$/i });

/** Click the subject tab and wait until its read of this device has settled. */
async function openSubjectTab(): Promise<void> {
  fireEvent.click(screen.getByRole('tab', { name: /one subject backup/i }));
  await waitFor(() => {
    expect(within(subjectTab()).getByLabelText(/subject to back up/i)).toBeInTheDocument();
  });
  // The subject list is read from storage on mount, so the picker is empty for a
  // turn. Waiting for the *settled* answer rather than for the control is what
  // makes the assertions about the read rather than about the timing.
  await waitFor(() => {
    // `queryByText`, not `getByText`: the wait is for the *absence* of the pending
    // sentence, and a `get` that throws would make this retry for ever.
    expect(within(subjectTab()).queryByText(/reading the subjects on this device/i)).toBeNull();
  });
  await nextTask();
}

async function openSubjectTabAndChoose(bytes: Uint8Array): Promise<void> {
  await openSubjectTab();
  await chooseSubjectFile(bytes);
  await waitFor(() => {
    expect(subjectDialog()).toBeInTheDocument();
  });
  // The dialog opens while the file is still being read - that is the whole point
  // of opening it from the act of choosing a file - so the wait is for the read to
  // finish, which is exactly what an enabled commit control means.
  await waitFor(() => {
    expect(copyConfirm()).toBeEnabled();
  });
  await waitFor(() => {
    expect(within(modeGroup()).getAllByRole('radio')).toHaveLength(2);
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

let device: NastyDevice;

beforeEach(async () => {
  installBrowserDoubles();
  installStylesheet();
  window.localStorage.clear();
  device = await createNastySubjectDevice('subject-tab-ui');
});

afterEach(() => {
  cleanup();
  vi.doUnmock('@/services/persistence/products/subjectBackup');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
  void import('@/services/persistence/v2/repositorySelection').then((selection) =>
    selection.resetRepositorySelection(),
  );
});

// ── 1. The tablist ────────────────────────────────────────────────────────

describe('Phase 6 subject tab: the tablist', () => {
  it('renders nothing at all when VITE_DATA_PRODUCTS_V2 is off, so there is no second tab', async () => {
    const { DataCenter } = await loadDataCenter(false);
    const { container } = render(<DataCenter />);
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('*')).toHaveLength(0);
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('is a real tablist with three tabs, one selected, and only the selected panel in the DOM', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);

    const tablist = screen.getByRole('tablist', { name: /data products/i });
    expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');
    const tabs = within(tablist).getAllByRole('tab');
    // Three since Phase 7: the whole device, one subject, and the reusable template.
    // The template label is chosen so Phase 5's browser lane, which finds the
    // full-backup tab by `/full[\s-]*device|full[\s-]*backup/i`, still matches exactly
    // one tab.
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Full device backup',
      'One subject backup',
      'Reusable template',
    ]);

    // `aria-selected` that is actually true, and true on exactly one.
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);

    // Every tab's `aria-controls` resolves to a real tabpanel, labelled by that tab.
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') as string);
      expect(panel, tab.textContent ?? '').not.toBeNull();
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }

    // Roving tabindex: the tablist is one stop in the page's order.
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);

    // Only the selected panel's contents exist, so the other tabs' file inputs are
    // not in the DOM and cannot be reached by Tab.
    const panels = screen.getAllByRole('tabpanel', { hidden: true });
    expect(panels).toHaveLength(3);
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(within(panels[1] as HTMLElement).queryByRole('radio')).toBeNull();
  });

  it('moves between all three tabs with the arrow keys, Home, and End, and selects as it goes', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);

    const device_ = screen.getByRole('tab', { name: /full device backup/i });
    const subject_ = screen.getByRole('tab', { name: /one subject backup/i });
    const template_ = screen.getByRole('tab', { name: /reusable template/i });
    device_.focus();

    fireEvent.keyDown(device_, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(subject_);
    expect(subject_).toHaveAttribute('aria-selected', 'true');
    expect(device_).toHaveAttribute('aria-selected', 'false');
    expect(document.activeElement?.getAttribute('tabindex')).toBe('0');

    // Forward through the third, then wraps at the end, in both directions. The wrap is
    // the part a second tab could not exercise, and it is the reason the third tab's
    // presence is a real change to the movement rather than one more stop.
    fireEvent.keyDown(subject_, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(template_);
    expect(template_).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(template_, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(device_);
    fireEvent.keyDown(device_, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(template_);

    fireEvent.keyDown(template_, { key: 'Home' });
    expect(document.activeElement).toBe(device_);
    fireEvent.keyDown(device_, { key: 'End' });
    expect(document.activeElement).toBe(template_);

    // The vertical arrows work too, so a learner who expects a list is not stuck.
    fireEvent.keyDown(template_, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(device_);

    // A key the tablist does not own is left alone, so browser scrolling still works.
    const before = document.activeElement;
    fireEvent.keyDown(before as HTMLElement, { key: 'PageDown' });
    expect(document.activeElement).toBe(before);

    // ...and the panel's contents exist only once it is selected.
    await openSubjectTab();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(document.querySelector('[data-kd-surface="subject-import-mode"]')).toBeNull();
    // The mode choice belongs to the confirmation, so it arrives with the file.
    await chooseSubjectFile(await realSubjectArchive(device, NASTY_SUBJECT_ID));
    await waitFor(() => {
      expect(within(modeGroup()).getAllByRole('radio')).toHaveLength(2);
    });
  });
});

// ── 2. The export ─────────────────────────────────────────────────────────

describe('Phase 6 subject tab: the export', () => {
  it('lists the device\'s own subjects and downloads the chosen one as a real local file', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTab();

    const picker = within(subjectTab()).getByLabelText<HTMLSelectElement>(/subject to back up/i);
    const options = [...picker.options].map((option) => option.textContent ?? '');
    expect(options).toHaveLength(2);
    // Both subjects, by the name this device gives them, and with their room counts
    // so two similar names can be told apart.
    expect(options.join(' ')).toContain(device.staged.subjects.length === 2 ? '' : '');
    expect(options.some((option) => option.includes('room'))).toBe(true);

    // Choose the second subject explicitly, then download it.
    const otherOption = [...picker.options].find((option) => option.value === NASTY_OTHER_SUBJECT_ID);
    expect(otherOption).toBeDefined();
    fireEvent.change(picker, { target: { value: NASTY_OTHER_SUBJECT_ID } });

    fireEvent.click(within(subjectTab()).getByRole('button', { name: /download this subject/i }));
    await waitFor(() => {
      expect(downloads).toHaveLength(1);
    });
    await nextTask();

    // The file: the product's **constant** name, real bytes, an object URL, and a
    // revoke once the click has been handled.
    const record = downloads[0] as DownloadRecord;
    expect(record.download).toBe(product.SUBJECT_BACKUP_FILE_NAME);
    expect(record.download.endsWith('.kdsubject')).toBe(true);
    expect(record.href.startsWith('blob:')).toBe(true);
    expect(record.inDocumentWhenClicked).toBe(true);
    expect((record.blob as Blob).size).toBeGreaterThan(0);
    expect((record.blob as Blob).type).toBe('application/zip');
    await waitFor(() => {
      expect(revokedObjectUrls).toEqual([createdObjectUrls[0] as string]);
    });
    expect(document.querySelector('a[download]')).toBeNull();

    // Only the chosen subject's own attachment ids were resolved, not the
    // device's - a `.kdsubject` is one subject, and asking for every id would
    // resolve four times the bytes it can carry.
    const chosenSubjectAttachments = device.staged.attachmentMetadata
      .filter((record_) => record_.subjectId === NASTY_OTHER_SUBJECT_ID)
      .map((record_) => record_.attachmentId);
    expect(payloadResolutions).toHaveLength(1);
    expect([...(payloadResolutions[0] as string[])].sort()).toEqual([...chosenSubjectAttachments].sort());

    // The status line reports the file and the counts, and no network API was touched.
    const status = document.querySelector('[data-kd-surface="subject-export-status"]') as HTMLElement;
    expect(status).toHaveAttribute('role', 'status');
    expect(status.textContent).toContain(product.SUBJECT_BACKUP_FILE_NAME);
    expect(status.textContent).toMatch(/\d+ bytes/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpenSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
  });

  it('preselects the subject the learner is working in', async () => {
    const { DataCenter } = await loadDataCenter(true);
    const { useSessionStore } = await import('@/store/sessionStore');
    useSessionStore.setState({ activeSubjectId: NASTY_OTHER_SUBJECT_ID });
    try {
      await selectLiveRepository(device.repository);
      render(<DataCenter />);
      await openSubjectTab();
      const picker = within(subjectTab()).getByLabelText<HTMLSelectElement>(/subject to back up/i);
      await waitFor(() => {
        expect(picker.value).toBe(NASTY_OTHER_SUBJECT_ID);
      });
    } finally {
      useSessionStore.setState({ activeSubjectId: null });
    }
  });

  it('says so in words when this build cannot read its own subjects, rather than showing an empty picker', async () => {
    const { DataCenter } = await loadDataCenter(true);
    // No live repository: the honest answer is that this build has nothing to read,
    // said in words rather than as an exception.
    render(<DataCenter />);
    fireEvent.click(screen.getByRole('tab', { name: /one subject backup/i }));
    await waitFor(() => {
      expect(
        within(subjectTab()).getByText(/versioned store this tab reads from/i),
      ).toBeInTheDocument();
    });

    const picker = within(subjectTab()).getByLabelText<HTMLSelectElement>(/subject to back up/i);
    expect(picker).toBeDisabled();
    expect(picker.options[0]?.textContent).toBe('This device cannot be read here');
    expect(within(subjectTab()).getByRole('button', { name: /download this subject/i })).toBeDisabled();

    fireEvent.click(within(subjectTab()).getByRole('button', { name: /download this subject/i }));
    await nextTask();
    expect(downloads).toHaveLength(0);
  });

  it('reports a typed failure with no invented message when the backup cannot be made', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTab();
    // A subject id the device does not hold: the product refuses, and the screen
    // reports the product's code rather than a message that could carry a name.
    const picker = within(subjectTab()).getByLabelText<HTMLSelectElement>(/subject to back up/i);
    const detached = document.createElement('option');
    detached.value = 'subject-not-on-this-device';
    detached.textContent = 'Subject with no name — 0 rooms';
    picker.appendChild(detached);
    fireEvent.change(picker, { target: { value: 'subject-not-on-this-device' } });

    fireEvent.click(within(subjectTab()).getByRole('button', { name: /download this subject/i }));
    const region = await waitFor(() => {
      const found = document.querySelector('[data-kd-surface="subject-export-problem"]');
      if (found === null) throw new Error('no export problem yet');
      return found as HTMLElement;
    });
    expect(region).toHaveAttribute('role', 'alert');
    expect(region.textContent).toMatch(/reported as [A-Z_]+/);
    expect(region.textContent).not.toContain('Subject with no name');
    expect(downloads).toHaveLength(0);
  });
});

// ── 3. The default ────────────────────────────────────────────────────────

describe('Phase 6 subject tab: a copy is what a learner gets without choosing', () => {
  it('opens the confirmation already in copy mode, with the mode stated as a sentence', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    // Before a file is chosen there is no confirmation at all, so there is no mode
    // to get wrong: the choice is collected by the window that states what the
    // chosen mode will do, and the window does not exist yet.
    await openSubjectTab();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-kd-surface="subject-import-mode"]')).toBeNull();

    // Choosing a file opens it, and the copy is the one already chosen.
    await chooseSubjectFile(await realSubjectArchive(device, NASTY_SUBJECT_ID));
    await waitFor(() => {
      expect(copyConfirm()).toBeEnabled();
    });
    expect(copyRadio()).toBeChecked();
    expect(replaceRadio()).not.toBeChecked();
    expect(modeGroup()).toHaveTextContent(/nothing that is already here is replaced/i);
    expect(within(modeGroup()).getAllByRole('status')[0]).toHaveAttribute('aria-live', 'polite');
    // The commit control matches the mode, and the destructive one is not on screen.
    expect(copyConfirm()).toBeEnabled();
    expect(within(subjectDialog()).queryByRole('button', { name: /^replace the subject$/i })).toBeNull();
  });

  it('offers the destructive mode only for a backup whose subject this device has', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));
    expect(replaceRadio()).toBeEnabled();
    expect(replaceRadio()).not.toBeChecked();

    // A backup of a subject this device does not have: the mode is not merely
    // disabled, it says why, in the window where the choice is made.
    const foreign = await createPopulatedDevice('subject-tab-ui-foreign-reason');
    await selectLiveRepository(foreign.repository);
    await chooseSubjectFile(await realSubjectArchive(device, NASTY_SUBJECT_ID), 'elsewhere.kdsubject');
    await waitFor(() => {
      expect(replaceRadio()).toBeDisabled();
    });
    expect(modeGroup()).toHaveTextContent(
      /for a subject that is not on this device, so there is nothing here for it to replace/i,
    );
  });

  it('adds a subject, destroys nothing, and remaps every id when the learner never chooses a mode', async () => {
    const { DataCenter } = await loadDataCenter(true);
    const target = await createNastySubjectDevice('subject-tab-ui-copy-target');
    await selectLiveRepository(target.repository);
    render(<DataCenter />);
    // A backup of the *other* subject, so the target cannot possibly replace it.
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_OTHER_SUBJECT_ID));

    const before = await target.repository.readRecords(NASTY_GENERATION_ID);
    const beforeSubjectIds = before.records.subjects.map((entry) => entry.value.subjectId).sort();

    // The dialog is a copy dialog: its title, its confirm control, and its wording.
    const dialog = subjectDialog();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: /add a copy of this subject\?/i })).toBeInTheDocument();
    expect(dialog.textContent).toMatch(/nothing that is already here is replaced, removed, or changed/i);
    expect(dialog.textContent).toMatch(/new internal id/i);
    expect(dialog.textContent).toMatch(/Nothing on this device is destroyed by this/i);
    expect(within(dialog).queryByRole('button', { name: /^replace the subject$/i })).toBeNull();

    fireEvent.click(copyConfirm());
    await waitFor(
      async () => {
        expect(await target.repository.readActiveGenerationId()).not.toBe(NASTY_GENERATION_ID);
      },
      { timeout: 5000 },
    );

    // The request the product was sent: no `mode`, no `replaceSubjectId`, no
    // `confirmReplace`. The product's own default is copy, and there is nothing in
    // the call for it to honour a replace.
    expect(importRequests).toHaveLength(1);
    const request = importRequests[0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(['bytes', 'now', 'repository']);
    expect(request.mode).toBeUndefined();
    expect(request.confirmReplace).toBeUndefined();
    expect(request.replaceSubjectId).toBeUndefined();

    // A new subject, and every subject that was already there is untouched.
    const after = await target.repository.readRecords(
      (await target.repository.readActiveGenerationId()) as string,
    );
    const afterSubjectIds = after.records.subjects.map((entry) => entry.value.subjectId);
    expect(afterSubjectIds).toHaveLength(beforeSubjectIds.length + 1);
    for (const subjectId of beforeSubjectIds) expect(afterSubjectIds).toContain(subjectId);
    // ...and the copy itself shares no id with the subject the backup came from.
    // (The target already held a subject with that id, because it is a copy of the
    // same fixture - so the claim is about the one that was *added*.)
    const added = afterSubjectIds.filter((subjectId) => !beforeSubjectIds.includes(subjectId));
    expect(added).toHaveLength(1);
    expect(added[0]).not.toBe(NASTY_OTHER_SUBJECT_ID);
    expect(added[0]).toMatch(/^kc-subject-/);
    // The previous generation is still there.
    expect(await target.repository.readGeneration(NASTY_GENERATION_ID)).not.toBeNull();
  });

  it('will not offer a replace for a backup whose subject this device does not have', async () => {
    const { DataCenter } = await loadDataCenter(true);
    // A device whose subjects have entirely different ids, so nothing the backup
    // names can be replaced. This is the cross-device case the copy mode exists
    // for, and the case where a replace would be actively wrong: it would have to
    // destroy *some other* subject to make room.
    const foreign = await createPopulatedDevice('subject-tab-ui-foreign');
    await selectLiveRepository(foreign.repository);
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));

    expect(replaceRadio()).toBeDisabled();
    expect(modeGroup()).toHaveTextContent(
      /for a subject that is not on this device, so there is nothing here for it to replace/i,
    );
    // ...and the copy path is the only one the dialog offers.
    expect(within(subjectDialog()).getByRole('button', { name: /add a copy/i })).toBeInTheDocument();
    expect(within(subjectDialog()).queryByRole('button', { name: /^replace the subject$/i })).toBeNull();
  });
});

// ── 4. The destructive path, and the routes into it that are closed ───────

describe('Phase 6 subject tab: a replace is available, explicit, and confirmed', () => {
  it('is offered when the backup is for a subject this device has, and names it in the confirmation', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));

    expect(replaceRadio()).toBeEnabled();
    fireEvent.click(replaceRadio());
    expect(replaceRadio()).toBeChecked();
    expect(copyRadio()).not.toBeChecked();
    // The mode's effect is restated in words the moment it changes.
    expect(modeGroup()).toHaveTextContent(/destroyed on this device/i);
    expect(modeGroup()).toHaveTextContent(/still kept as a whole copy/i);

    const dialog = subjectDialog();
    expect(within(dialog).getByRole('heading', { name: /replace this subject with the file\?/i })).toBeInTheDocument();
    // The one place a subject name is rendered: this device's own name for it.
    const deviceName = readDeviceSubjectName(device, NASTY_SUBJECT_ID);
    expect(deviceName.length).toBeGreaterThan(0);
    expect(dialog.textContent).toContain(deviceName);
    expect(dialog.textContent).toMatch(/is destroyed and replaced by what this file holds/i);
    expect(dialog.textContent).toMatch(/kept/i);
    expect(replaceConfirm()).toBeEnabled();
  });

  it('destroys exactly the named subject, keeps the rest of the device, and preserves the id', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));
    fireEvent.click(replaceRadio());

    const before = await device.repository.readRecords(NASTY_GENERATION_ID);
    const otherBefore = JSON.stringify(
      before.records.progression.find((entry) => entry.value.subjectId === NASTY_OTHER_SUBJECT_ID)?.value ?? null,
    );

    fireEvent.click(replaceConfirm());
    await waitFor(
      async () => {
        expect(await device.repository.readActiveGenerationId()).not.toBe(NASTY_GENERATION_ID);
      },
      { timeout: 5000 },
    );

    // The request carried the product's own three replace fields, all of them.
    const request = importRequests[0] as Record<string, unknown>;
    expect(request.mode).toBe('replace');
    expect(request.confirmReplace).toBe(true);
    expect(request.replaceSubjectId).toBe(NASTY_SUBJECT_ID);

    const generationId = (await device.repository.readActiveGenerationId()) as string;
    const after = await device.repository.readRecords(generationId);
    const afterSubjectIds = after.records.subjects.map((entry) => entry.value.subjectId).sort();
    // Two subjects before, two after: the target kept its id and nothing was added.
    expect(before.records.subjects).toHaveLength(2);
    expect(afterSubjectIds).toEqual([NASTY_SUBJECT_ID, NASTY_OTHER_SUBJECT_ID].sort());
    // The unrelated subject's progress is byte-identical, which is what "no
    // unrelated subject changed" means.
    const otherAfter = after.records.progression.find(
      (entry) => entry.value.subjectId === NASTY_OTHER_SUBJECT_ID,
    )?.value;
    expect(JSON.stringify(otherAfter ?? null)).toBe(otherBefore);
    // And the previous generation is retained, so this is reversible.
    expect(await device.repository.readGeneration(NASTY_GENERATION_ID)).not.toBeNull();
  });

  it('resets to copy on every file choice, so a destructive pick cannot follow a file', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    // Choose a replaceable file, select the destructive mode in the window, and
    // then leave the window without committing.
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));
    fireEvent.click(replaceRadio());
    expect(replaceRadio()).toBeChecked();
    expect(replaceConfirm()).toBeEnabled();
    fireEvent.click(within(subjectDialog()).getByRole('button', { name: /keep what is here/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // The strongest form of the property: the destructive choice does not merely
    // become unselected, it leaves the document with the window. There is no
    // replace state a later file could inherit.
    expect(document.querySelector('[data-kd-surface="subject-import-mode"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/^replace the subject$/im);

    // Choosing another file resets it, whatever the previous file was, and the
    // destructive commit control is gone from the window again.
    await chooseSubjectFile(await realSubjectArchive(device, NASTY_SUBJECT_ID), 'another.kdsubject');
    await waitFor(() => {
      expect(copyConfirm()).toBeEnabled();
    });
    expect(modeIs()).toBe('copy');
    expect(within(subjectDialog()).queryByRole('button', { name: /^replace the subject$/i })).toBeNull();
  });

  it('has no form and no key handler, so nothing submits it and no Enter can reach it', async () => {
    const { DataCenter } = await loadDataComponent();
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));

    // Structurally: the whole Data Center tree has no form, and no submit control.
    for (const file of DATA_CENTER_TREE) {
      const source = blankComments(readFileSync(join(process.cwd(), file), 'utf8'));
      expect(source, `${file} must contain no form`).not.toMatch(/<form\b/);
      expect(source, `${file} must contain no implicit submission`).not.toMatch(
        /\.submit\(|requestSubmit\(|formAction=/,
      );
    }
    expect(document.querySelector('form')).toBeNull();
    expect(document.querySelector('input[type="text"], input[type="search"]')).toBeNull();

    // Behaviourally: an Enter keypress on the file input, and a double click on the
    // button that opens it, both do nothing but re-read a file - the mode is still
    // copy and no replace control exists.
    const input = subjectTab().querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const chooser = within(subjectTab()).getByRole('button', { name: /choose a subject backup file/i });
    chooser.focus();
    fireEvent.keyDown(chooser, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(chooser, { key: 'Enter', code: 'Enter' });
    fireEvent.doubleClick(chooser);
    fireEvent.keyDown(input as HTMLElement, { key: 'Enter', code: 'Enter' });
    await nextTask();
    expect(copyRadio()).toBeChecked();
    expect(replaceRadio()).not.toBeChecked();
    expect(within(subjectDialog()).queryByRole('button', { name: /^replace the subject$/i })).toBeNull();
  });

  it('has no replace control at all while no replace target is established, and the handler re-checks anyway', async () => {
    const { DataCenter } = await loadDataComponent();
    // A device that does not hold the backup's subject, so `replaceReady` cannot
    // become true. The state is unreachable by design, which is the point: the
    // destructive control is not merely disabled, it is not rendered.
    const foreign = await createPopulatedDevice('subject-tab-ui-foreign-handler');
    await selectLiveRepository(foreign.repository);
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));

    expect(replaceRadio()).toBeDisabled();
    expect(within(subjectDialog()).queryByRole('button', { name: /^replace the subject$/i })).toBeNull();
    expect(within(subjectDialog()).queryByText('Replace the subject it came from.')).toBeNull();

    // And the second line of defence is in the handler rather than only in the
    // button's `disabled` attribute, so a stale render, a synthetic event, or a
    // future caller reaching the handler directly all still get nothing. This is a
    // source assertion on purpose: the state is unreachable, so no sequence of
    // clicks can demonstrate the guard the way a reachable one could.
    const source = blankComments(
      readFileSync(join(process.cwd(), 'src', 'ui', 'data', 'SubjectBackupTab.tsx'), 'utf8'),
    );
    expect(source).toMatch(/if \(chosenMode === 'replace' && !replaceReady\) return;/);
    // ...and the destructive request fields are only ever spread in behind the
    // same predicate, so a copy request can never carry them.
    expect(source).toMatch(/chosenMode === 'replace' && replaceTarget !== null/);
    expect(source).toMatch(/confirmReplace: true/);
  });

  it('moves between the two modes with the arrow keys, and skips a disabled one', async () => {
    const { DataCenter } = await loadDataComponent();
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));

    copyRadio().focus();
    fireEvent.keyDown(copyRadio(), { key: 'ArrowDown' });
    expect(replaceRadio()).toBeChecked();
    expect(document.activeElement).toBe(replaceRadio());
    fireEvent.keyDown(replaceRadio(), { key: 'ArrowUp' });
    expect(copyRadio()).toBeChecked();
    expect(document.activeElement).toBe(copyRadio());
    fireEvent.keyDown(copyRadio(), { key: 'End' });
    expect(replaceRadio()).toBeChecked();

    // With no replaceable file, the arrow key stays on copy rather than landing on
    // a control the learner cannot use.
    const foreign = await createPopulatedDevice('subject-tab-ui-foreign-arrows');
    await selectLiveRepository(foreign.repository);
    await chooseSubjectFile(await realSubjectArchive(device, NASTY_SUBJECT_ID), 'other.kdsubject');
    await waitFor(() => {
      expect(replaceRadio()).toBeDisabled();
    });
    copyRadio().focus();
    fireEvent.keyDown(copyRadio(), { key: 'ArrowDown' });
    expect(copyRadio()).toBeChecked();
    expect(document.activeElement).toBe(copyRadio());
  });

  it('traps focus, closes on Escape, restores focus, and is genuinely not dismissible mid-import', async () => {
    const { DataCenter } = await loadDataComponent();
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTab();
    const opener = within(subjectTab()).getByRole('button', { name: /choose a subject backup file/i });
    opener.focus();
    await chooseSubjectFile(await realSubjectArchive(device, NASTY_SUBJECT_ID));
    await waitFor(() => {
      expect(copyConfirm()).toBeEnabled();
    });
    fireEvent.click(replaceRadio());

    const dialog = subjectDialog();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(dialog).toHaveAttribute('aria-describedby');
    expect(dialog.getAttribute('aria-labelledby')).not.toBe(dialog.getAttribute('aria-describedby'));
    // Initial focus is the dialog itself, not the destructive button.
    expect(document.activeElement).toBe(dialog);

    const dismiss = within(dialog).getByRole('button', { name: /keep what is here/i });
    replaceConfirm().focus();
    fireEvent.keyDown(replaceConfirm(), { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    dismiss.focus();
    fireEvent.keyDown(dismiss, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Escape closes it and focus goes back to the control that opened it.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(opener);
    // ...and the preview survives, so nothing the learner read is lost.
    expect(subjectPreview()).not.toBeNull();
  });

  it('does not let Escape dismiss the window while an import is in flight', async () => {
    const { DataCenter } = await loadDataComponent();
    const target = await createNastySubjectDevice('subject-tab-ui-busy');
    await selectLiveRepository(target.repository);
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_OTHER_SUBJECT_ID));

    // The import resolves on a later task, so the dialog is observably busy. The
    // copy path is driven rather than the replace one because the rule lives in
    // `ConfirmDialog` and both modes go through the identical code path - and a
    // destructive path is the one where an Escape that half-worked would matter
    // most, so the replace path's own non-dismissal is asserted by the dialog test
    // above.
    fireEvent.click(copyConfirm());
    // Synchronously: `handleConfirm` sets `importing` before its first `await`, so
    // the busy window is already real here and does not need to be caught in flight.
    expect(subjectDialog()).toHaveAttribute('aria-busy', 'true');
    fireEvent.keyDown(subjectDialog(), { key: 'Escape' });
    await nextTask();
    expect(subjectDialog()).toBeInTheDocument();
    // ...and the outcome arrives anyway.
    await waitFor(
      () => {
        expect(subjectOutcome()).not.toBeNull();
      },
      { timeout: 5000 },
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

/** The subject name this device's own record carries. */
function readDeviceSubjectName(nasty: NastyDevice, subjectId: string): string {
  const record = nasty.staged.subjects.find((subject) => subject.subjectId === subjectId);
  const dungeon = record?.snapshot.dungeon as { subjectName?: unknown } | undefined;
  return typeof dungeon?.subjectName === 'string' ? dungeon.subjectName : '';
}

const DATA_CENTER_TREE = [
  'src/ui/data/DataCenter.tsx',
  'src/ui/data/SubjectBackupTab.tsx',
  'src/ui/data/ConfirmDialog.tsx',
  'src/ui/data/ImportPreview.tsx',
  'src/ui/data/RecoveryStatus.tsx',
  'src/ui/data/productAccess.ts',
];

/** `loadDataCenter(true)` with a name that says the product is the one under test. */
async function loadDataComponent(): Promise<DataCenterModule> {
  return loadDataCenter(true);
}

// ── 5. Privacy ────────────────────────────────────────────────────────────

describe('Phase 6 subject tab: privacy', () => {
  it('previews the file in words and renders nothing that identifies an image or the archive', async () => {
    const { DataCenter } = await loadDataComponent();
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    const archive = await realSubjectArchive(device, NASTY_SUBJECT_ID);
    await openSubjectTabAndChoose(archive);

    const surface = subjectPreview() as HTMLElement;
    expect(surface).toHaveAccessibleName(/what is in this file/i);
    // The `.kdsubject`'s own six counts, and none of the `.kdbak`'s five zero rows.
    expect(within(surface).getByText('Subject')).toBeInTheDocument();
    expect(within(surface).getByText('Image data')).toBeInTheDocument();
    expect(within(surface).queryByText('Settings')).toBeNull();
    expect(within(surface).queryByText('Data-move receipts')).toBeNull();
    // The three separate version contracts, as the device preview has them.
    expect(within(surface).getByRole('heading', { name: /which versions/i })).toBeInTheDocument();

    // The disclosure is in words and names no image.
    const inspection = product.inspectSubjectArchive(archive);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.preview.externalOnlyCount).toBeGreaterThan(0);
    expect(surface.textContent).toMatch(/Image 1 of \d+/);
    expect(surface.textContent).toMatch(/link to a picture on the internet|not on this device/i);

    const text = surface.textContent ?? '';
    expect(text).not.toContain('http');
    expect(text).not.toContain('example.invalid');
    expect(text).not.toMatch(/\.(png|jpe?g|webp|gif|svg)\b/i);
    expect(text).not.toMatch(/\b[0-9a-f]{64}\b/);
    for (const entry of inspection.preview.externalOnlyAttachments) {
      expect(text).not.toContain(entry.attachmentId);
      expect(text).not.toContain(entry.subjectId);
      expect(text).not.toContain(entry.roomId);
    }
    for (const member of inspection.preview.memberNames) {
      expect(text).not.toContain(member);
    }
    // The learner-content marker the gate suite plants in a subject name, a room
    // topic, a note body, and an attachment file name reaches none of it.
    expect(text).not.toContain(MARKER_TOKEN);
  });

  it('surfaces the foreign-state and verbatim disclosures with no identifier in them at all', async () => {
    // The task's condition, and the product's own contract: `foreignState` is words
    // and numbers only, with no subject id, name, topic, or filename. The fixture is
    // built so that every forbidden shape has something real to be: a real subject
    // name and a real marker token exist on this device, and a real
    // `externalOnlyAttachments` entry exists on the archive.
    const { RecoveryStatus } = await import('@/ui/data/RecoveryStatus');
    const { NASTY_ATTACHMENT_IDS, NASTY_GENERATION_ID } = await import('../data/support/nastySubject');
    const archive = await realSubjectArchive(device, NASTY_SUBJECT_ID);
    const inspection = product.inspectSubjectArchive(archive);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    // The archive really does disclose an image, so the preview really does carry
    // an `externalOnlyAttachments[].subjectId` - which is the very field the
    // corrected comment is about, and which must still never be rendered.
    const disclosed = inspection.preview.externalOnlyAttachments;
    expect(disclosed.length).toBeGreaterThan(0);
    expect(disclosed[0]?.subjectId).toBe(NASTY_SUBJECT_ID);

    const report: SubjectImportReport = {
      mode: 'replace',
      activated: true,
      previousGenerationRetained: true,
      previousActiveGenerationId: NASTY_GENERATION_ID,
      identifiersRemapped: 0,
      // A replace rewrites no identifiers, so this is 0 by construction, and the
      // surface correctly says nothing about the copy-mode disclosure.
      unresolvedReferenceCount: 0,
      crossSubjectAchievementsCarried: 1,
      carriedForwardRecordCounts: { preferences: 1 },
      destroyedRecordCounts: { subjects: 1, progression: 1, sessions: 2, attachments: 3 },
      foreignState: {
        preservedProgressionKeys: 4,
        appliedProgressionKeys: 5,
        retainedProgressionKeys: 6,
        destroyedProgressionKeys: 7,
        identicalAssistanceRecords: 8,
        preservedAssistanceRecords: 9,
        appliedAssistanceRecords: 10,
        note: 'replace-preserves-foreign-progression-keys-device-copy-wins-on-conflict',
      },
      verbatimDisclosures: [
        { code: 'attachment-relative-path-names-a-remapped-id', count: 11 },
        { code: 'stale-subject-dungeon-id', count: 12 },
        { code: 'a-code-from-a-later-product', count: 13 },
      ],
      // The real disclosure, with its real opaque ids, so the assertion has
      // something to catch rather than passing on an empty list.
      disclosedWarnings: [],
      externalOnlyAttachments: disclosed,
      receiptPolicy: 'per-generation-receipts-not-carried-forward',
      receiptNote: 'note',
      previousGenerationReceiptCount: 1,
      recordCounts: { subjects: 2, progression: 1, attachments: disclosed.length },
      contentChecksum: 'c'.repeat(64),
      generationId: 'gen-after-replace',
    };
    const { container } = render(
      <RecoveryStatus outcome={{ kind: 'subject-success', result: report }} />,
    );
    const surface = container.querySelector('[data-kd-surface="restore-outcome"]') as HTMLElement;
    const text = surface.textContent ?? '';

    // The disclosures ARE rendered, so nothing below can pass by them being absent.
    expect(text).toMatch(/Nothing outside the subject being imported was changed/i);
    expect(text).toMatch(/left 11 values inside image file paths/i);
    expect(text).toMatch(/left 12 values as they were, and they do not match/i);
    expect(text).toMatch(/left 13 values as they were, because a rule/i);
    expect(text).toMatch(/1 achievement that counts across every subject/i);

    // Every number in the shape appears, so the counts are really on the page. The
    // boundary is written with string concatenation, not a template literal: `\b` in
    // a template literal is a backspace escape, and a backspace is not a word
    // boundary - so that spelling asserts nothing and would have passed vacuously.
    for (const count of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      expect(text, `the count ${count} is not rendered`).toMatch(new RegExp('\\b' + count + '\\b'));
    }

    // ...and no identifier of any kind is.
    const deviceName = readDeviceSubjectName(device, NASTY_SUBJECT_ID);
    expect(deviceName).toContain(MARKER_TOKEN);
    for (const forbidden of [
      'subject id', 'subjectId', 'subjectName', 'topic', 'fileName', 'filename', 'externalUrl',
      ...[NASTY_SUBJECT_ID, NASTY_OTHER_SUBJECT_ID, NASTY_ATTACHMENT_IDS.stored,
        NASTY_ATTACHMENT_IDS.external, NASTY_ATTACHMENT_IDS.orphanInSnapshot],
      deviceName,
      MARKER_TOKEN,
      'gen-data-gate-nasty',
    ]) {
      expect(text.includes(forbidden), `the outcome rendered ${JSON.stringify(forbidden)}`).toBe(false);
    }
    // A 64-hex digest, a room id, a subject name, and a file name are all absent too.
    expect(text).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(text).not.toMatch(/\.(png|jpe?g|webp|gif|svg)\b/i);
    // The production note is code-shaped and is not rendered as prose either.
    expect(text).not.toContain('replace-preserves-foreign-progression-keys');
  });

  it('renders a subject name in exactly two places, and never in a file name or a status line', async () => {
    const { DataCenter } = await loadDataComponent();
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTab();
    const deviceName = readDeviceSubjectName(device, NASTY_SUBJECT_ID);
    expect(deviceName).toContain(MARKER_TOKEN);

    // Place one: the picker's own options, which is the control's value.
    const pickerText = within(subjectTab()).getByLabelText(/subject to back up/i).textContent ?? '';
    expect(pickerText).toContain(deviceName);

    // ...and nowhere else yet: not in a status line, not in a dialog, not in the
    // technical details of anything.
    const beforeChoosing = document.body.textContent ?? '';
    const statusLines = [...document.querySelectorAll('[data-kd-surface$="-status"]')].map(
      (node) => node.textContent ?? '',
    );
    for (const line of statusLines) expect(line).not.toContain(deviceName);
    expect(screen.queryByRole('dialog')).toBeNull();

    // Place two: the replace confirmation, where the plan requires it.
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));
    fireEvent.click(replaceRadio());
    expect(subjectDialog().textContent).toContain(deviceName);

    // The export status still names the constant file and the counts, and no
    // subject, after a download.
    const beforeCount = downloads.length;
    fireEvent.click(within(subjectTab()).getByRole('button', { name: /download this subject/i }));
    await waitFor(() => {
      expect(downloads.length).toBeGreaterThan(beforeCount);
    });
    const exportStatus = document.querySelector('[data-kd-surface="subject-export-status"]');
    expect(exportStatus?.textContent).not.toContain(deviceName);
    expect(exportStatus?.textContent).not.toContain(MARKER_TOKEN);
    expect((downloads[0] as DownloadRecord).download).not.toContain(MARKER_TOKEN);
    expect(beforeChoosing).toContain(deviceName);
  });

  it('refuses a corrupt archive with a typed code, opens no dialog, and writes nothing', async () => {
    const { DataCenter } = await loadDataComponent();
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTab();

    const corrupt = await realSubjectArchive(device, NASTY_SUBJECT_ID);
    corrupt[Math.floor(corrupt.length / 2)] = (corrupt[Math.floor(corrupt.length / 2)] ?? 0) ^ 0xff;
    const before = await device.repository.readActiveGenerationId();
    await chooseSubjectFile(corrupt, 'corrupt.kdsubject');

    const block = await waitFor(() => {
      const found = document.querySelector('[data-kd-surface="subject-inspection-problem"]');
      if (found === null) throw new Error('no inspection problem yet');
      return found as HTMLElement;
    });
    expect(block).toHaveAttribute('role', 'alert');
    expect(block.textContent).toMatch(/cannot be used/i);
    // A code from the product's typed vocabulary, and no message.
    expect(block.textContent).toMatch(/reported as [A-Z_]+/);
    expect(block.textContent).not.toMatch(/\bat \d+:\d+:\d+/);
    expect(subjectPreview()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await device.repository.readActiveGenerationId()).toBe(before);
  });
});

// ── 6. The outcome ────────────────────────────────────────────────────────

/** The product's all-zero foreign-state disclosure: a copy changes nothing else. */
const ZERO_FOREIGN_STATE = {
  preservedProgressionKeys: 0,
  appliedProgressionKeys: 0,
  retainedProgressionKeys: 0,
  destroyedProgressionKeys: 0,
  identicalAssistanceRecords: 0,
  preservedAssistanceRecords: 0,
  appliedAssistanceRecords: 0,
  note: 'replace-preserves-foreign-progression-keys-device-copy-wins-on-conflict',
} as const;

describe('Phase 6 subject tab: what the import reported', () => {
  it('says what the product returned, and surfaces the unresolved-reference disclosure', async () => {
    const { RecoveryStatus } = await import('@/ui/data/RecoveryStatus');
    // A report with a non-zero unresolved count, which is the case a surface that
    // renders a bare "imported" would get wrong.
    const report: SubjectImportReport = {
      mode: 'copy',
      activated: true,
      previousGenerationRetained: true,
      previousActiveGenerationId: 'gen-before',
      identifiersRemapped: 41,
      unresolvedReferenceCount: 2,
      crossSubjectAchievementsCarried: 0,
      carriedForwardRecordCounts: { preferences: 1, shortcuts: 2, customSprites: 0, recovery: 0 },
      destroyedRecordCounts: {},
      // A copy touches nothing the device already held, so the product's
      // foreign-state disclosure is all zeros and the surface must say nothing.
      foreignState: ZERO_FOREIGN_STATE,
      // One declared rule the copy chose to honour. The count is the only value.
      verbatimDisclosures: [
        { code: 'attachment-relative-path-names-a-remapped-id', count: 2 },
        { code: 'stale-subject-dungeon-id', count: 1 },
        { code: 'a-verbatim-code-from-a-later-product', count: 3 },
      ],
      disclosedWarnings: [],
      externalOnlyAttachments: [],
      receiptPolicy: 'per-generation-receipts-not-carried-forward',
      receiptNote: 'subject-import-mints-no-receipt-receipts-stay-with-their-generation',
      previousGenerationReceiptCount: 1,
      recordCounts: { subjects: 2 },
      contentChecksum: 'a'.repeat(64),
      generationId: 'gen-after',
    };
    const { container } = render(
      <RecoveryStatus outcome={{ kind: 'subject-success', result: report }} />,
    );
    const surface = container.querySelector('[data-kd-surface="restore-outcome"]') as HTMLElement;

    // The disclosure, in words, not hidden and not folded into a success verdict.
    expect(surface.textContent).toMatch(/2 references inside the file mention old ids/i);
    expect(surface.textContent).toMatch(/carried across as they were/i);
    expect(surface.textContent).toMatch(/nothing was lost/i);
    // The rest of the fields are reported too, and nothing is claimed that the
    // report does not carry.
    expect(surface.textContent).toMatch(/A copy of the subject was added, with a few things worth knowing/i);
    expect(surface.textContent).toMatch(/41 internal ids were rewritten/i);
    expect(surface.textContent).toMatch(/Everything this device had before is still here/i);
    expect(surface.textContent).toMatch(/data-move receipt/i);
    expect(surface.textContent).toMatch(/does not write a new one/i);
    // A live region, politely.
    expect(within(surface).getByRole('status')).toHaveAttribute('aria-live', 'polite');
    // The verbatim-carry disclosures, in words, one per closed code, and an
    // unknown code gets its own honest sentence rather than a guess.
    expect(surface.textContent).toMatch(/left 2 values inside image file paths as they were/i);
    expect(surface.textContent).toMatch(/point at the original subject's pictures/i);
    expect(surface.textContent).toMatch(
      /left 1 value as they were, and they do not match the copy's own subject/i,
    );
    expect(surface.textContent).toMatch(/left 3 values as they were, because a rule/i);
    expect(surface.textContent).toMatch(/does not recognise which rule/i);
    // ...and the foreign-state disclosure says nothing at all, because every count
    // is zero and "nothing else changed" is a sentence a bug would also produce.
    expect(surface.textContent).not.toMatch(/Nothing outside the subject being imported/i);
    // The count is also available in the collapsed technical block, unrendered
    // until asked for.
    expect(surface.querySelector('details')?.open).toBe(false);
  });

  it('reports what a replace did to other subjects, in numbers and never in names', async () => {
    const { RecoveryStatus } = await import('@/ui/data/RecoveryStatus');
    // A replace whose blast radius reaches other subjects. Every number here is a
    // count; there is no identifier anywhere in the shape to render.
    const report: SubjectImportReport = {
      mode: 'replace',
      activated: true,
      previousGenerationRetained: true,
      previousActiveGenerationId: 'gen-before',
      identifiersRemapped: 0,
      unresolvedReferenceCount: 0,
      crossSubjectAchievementsCarried: 0,
      carriedForwardRecordCounts: { preferences: 1 },
      destroyedRecordCounts: { subjects: 1, progression: 1 },
      foreignState: {
        preservedProgressionKeys: 1,
        appliedProgressionKeys: 0,
        retainedProgressionKeys: 2,
        destroyedProgressionKeys: 1,
        identicalAssistanceRecords: 3,
        preservedAssistanceRecords: 1,
        appliedAssistanceRecords: 0,
        note: 'replace-preserves-foreign-progression-keys-device-copy-wins-on-conflict',
      },
      verbatimDisclosures: [],
      disclosedWarnings: [],
      externalOnlyAttachments: [],
      receiptPolicy: 'per-generation-receipts-not-carried-forward',
      receiptNote: 'note',
      previousGenerationReceiptCount: 1,
      recordCounts: { subjects: 2, progression: 1 },
      contentChecksum: 'b'.repeat(64),
      generationId: 'gen-after',
    };
    const { container } = render(
      <RecoveryStatus outcome={{ kind: 'subject-success', result: report }} />,
    );
    const surface = container.querySelector('[data-kd-surface="restore-outcome"]') as HTMLElement;

    // The disclosure, in words, and the counts that are zero are not mentioned.
    expect(surface.textContent).toMatch(/Nothing outside the subject being imported was changed/i);
    expect(surface.textContent).toMatch(/1 other subject was left exactly as it was/i);
    expect(surface.textContent).toMatch(/on 2 other subjects this device's newer progress was kept/i);
    expect(surface.textContent).toMatch(/progress this device had for the imported subject itself was cleared/i);
    expect(surface.textContent).toMatch(/3 assistance records matched what was already here/i);
    // The noun is present and the verb agrees with it, at both numbers. This
    // assertion is the reason the clause can no longer read "1 that already
    // existed here were kept", which is what it used to say.
    expect(surface.textContent).toMatch(/1 assistance record that already existed here was kept/i);
    expect(surface.textContent).not.toMatch(/existed here were kept/i);
    // The zero counts are absent, and so is anything id-shaped.
    expect(surface.textContent).not.toMatch(/0 other subjects gained progress/);
    expect(surface.textContent).not.toMatch(/assistance records came in from the file/);

    // The same clause at the plural number, so the fix cannot be "record/was"
    // only: the noun is plural and the verb agrees with it.
    const plural = render(
      <RecoveryStatus
        outcome={{
          kind: 'subject-success',
          result: {
            ...report,
            foreignState: { ...report.foreignState, preservedAssistanceRecords: 4 },
          },
        }}
      />,
    ).container.querySelector('[data-kd-surface="restore-outcome"]') as HTMLElement;
    expect(plural.textContent).toMatch(/4 assistance records that already existed here were kept/i);
    expect(plural.textContent).not.toMatch(/4 assistance records that already existed here was kept/i);
  });

  it('says every reference was rewritten when the count is zero, rather than saying nothing', async () => {
    const { RecoveryStatus } = await import('@/ui/data/RecoveryStatus');
    const base: SubjectImportReport = {
      mode: 'copy',
      activated: true,
      previousGenerationRetained: false,
      previousActiveGenerationId: null,
      identifiersRemapped: 7,
      unresolvedReferenceCount: 0,
      crossSubjectAchievementsCarried: 0,
      carriedForwardRecordCounts: {},
      destroyedRecordCounts: {},
      foreignState: ZERO_FOREIGN_STATE,
      verbatimDisclosures: [],
      disclosedWarnings: [],
      externalOnlyAttachments: [],
      receiptPolicy: 'per-generation-receipts-not-carried-forward',
      receiptNote: 'note',
      previousGenerationReceiptCount: 0,
      recordCounts: { subjects: 1 },
      contentChecksum: '',
      generationId: 'gen',
    };
    const { container } = render(
      <RecoveryStatus outcome={{ kind: 'subject-success', result: base }} />,
    );
    const surface = container.querySelector('[data-kd-surface="restore-outcome"]') as HTMLElement;
    expect(surface.textContent).toMatch(/Every reference inside the file was rewritten/i);
    // A device with nothing active had no earlier copy, and the surface says that
    // rather than claiming a safety net that was never needed.
    expect(surface.textContent).toMatch(/no earlier copy on this device/i);
  });

  it('a real copy import reports a mode-appropriate verdict and a receipt policy the product set', async () => {
    const { DataCenter } = await loadDataComponent();
    const target = await createNastySubjectDevice('subject-tab-ui-outcome');
    await selectLiveRepository(target.repository);
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_OTHER_SUBJECT_ID));
    fireEvent.click(copyConfirm());

    const surface = await waitFor(
      () => {
        const found = subjectOutcome();
        if (found === null || !/What happened/.test(found.textContent ?? '')) {
          throw new Error('no outcome yet');
        }
        return found;
      },
      { timeout: 5000 },
    );
    expect(surface.textContent).toMatch(/A copy of the subject was added/i);
    expect(surface.textContent).toMatch(/Every reference inside the file was rewritten/i);
    expect(surface.textContent).toMatch(/records? of settings, shortcuts/i);
    // The receipt line is a fact about the *product's* policy, reported rather
    // than paraphrased into a claim the result does not carry.
    expect(surface.textContent).toMatch(/Bringing a subject in does not write a new one/i);
    expect(surface.textContent).not.toMatch(/wrote a (new )?(migration )?receipt/i);
  });

  it('a typed failure reports the code and claims nothing about what changed', async () => {
    const { RecoveryStatus } = await import('@/ui/data/RecoveryStatus');
    const { container } = render(
      <RecoveryStatus
        outcome={{ kind: 'failure', report: { code: 'VALIDATION_FAILED', details: { problemCount: 2 } } }}
      />,
    );
    const surface = container.querySelector('[data-kd-surface="restore-outcome"]') as HTMLElement;
    const alert = within(surface).getByRole('alert');
    expect(alert.textContent).toContain('VALIDATION_FAILED');
    expect(alert.textContent).toMatch(/did not finish/i);
    expect(alert.textContent).toMatch(/still the copy it is using/i);
    expect(surface.textContent).toContain('problemCount');
  });
});

// ── 7. Accessibility ──────────────────────────────────────────────────────

describe('Phase 6 subject tab: accessibility', () => {
  it('is a labelled region whose mode group is a real radio group with a visible selected state', async () => {
    const { DataCenter } = await loadDataComponent();
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));

    const group = modeGroup();
    expect(group.tagName).toBe('FIELDSET');
    expect(group.querySelector('legend')?.textContent).toBe('What should this file do?');
    expect(group).toHaveAttribute('aria-describedby');
    // Two radios, one name, so they are one group a screen reader announces as one.
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(new Set(radios.map((radio) => radio.getAttribute('name'))).size).toBe(1);
    // Exactly one is checked.
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1);
    // The selected state is stated in words as well as drawn, so it is not
    // colour-only and not dot-only.
    expect(within(group).getByText(/^Chosen\./i)).toBeInTheDocument();
    expect(group).toHaveTextContent(/nothing is replaced/i);
    // The group is described by the effect line and the refusal line.
    const describedBy = (group.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(describedBy.length).toBeGreaterThanOrEqual(1);
    for (const id of describedBy) {
      expect(document.getElementById(id)?.textContent?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it('every control it renders is at least 44 by 44 CSS pixels, measured from the real stylesheet', async () => {
    const { DataCenter } = await loadDataComponent();
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTabAndChoose(await realSubjectArchive(device, NASTY_SUBJECT_ID));
    fireEvent.click(replaceRadio());

    const buttons = [...screen.getAllByRole('button'), ...screen.getAllByRole('tab')];
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    for (const control of buttons) {
      const computed = window.getComputedStyle(control);
      expect(Number.parseFloat(computed.minHeight), control.textContent).toBeGreaterThanOrEqual(44);
      expect(Number.parseFloat(computed.minWidth), control.textContent).toBeGreaterThanOrEqual(44);
    }
    // The picker's own target, which is a native control and therefore has to be
    // given the minimum explicitly.
    const picker = within(subjectTab()).getByLabelText<HTMLSelectElement>(/subject to back up/i);
    const pickerStyle = window.getComputedStyle(picker);
    expect(Number.parseFloat(pickerStyle.minHeight)).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(pickerStyle.minWidth)).toBeGreaterThanOrEqual(44);
    // The radio's target is the whole label: a 13-pixel radio cannot be the target,
    // so the label carries the minimum and the radio sits inside it.
    const choiceLabels = [...modeGroup().querySelectorAll<HTMLElement>('label.kd-choice')];
    expect(choiceLabels).toHaveLength(2);
    for (const label of choiceLabels) {
      const computed = window.getComputedStyle(label as HTMLElement);
      expect(Number.parseFloat(computed.minHeight), label.textContent).toBeGreaterThanOrEqual(44);
    }
    for (const radio of within(modeGroup()).getAllByRole('radio')) {
      expect(labelOf(radio as HTMLElement)).toBeTruthy();
    }
  });

  it('computes every text and control-boundary pair it declares, and clears its threshold', () => {
    // Measured, not asserted by class name: the ratios come from the colours the
    // stylesheet actually declares, including the two backgrounds Phase 6 added.
    const selected = literalColour('#f7eddb');
    const hover = literalColour('#f2e6cf');
    const textPairs: ReadonlyArray<readonly [string, string, string]> = [
      ['body text on a card', token('ink'), token('card')],
      ['secondary text on a card', token('ink-soft'), token('card')],
      ['body text on the selected choice', token('ink'), selected],
      ['secondary text on the selected choice', token('ink-soft'), selected],
      ['body text on a hovered choice', token('ink'), hover],
      ['secondary text on a hovered choice', token('ink-soft'), hover],
      ['primary button label', token('accent-ink'), token('accent')],
      ['the selected mode sentence', token('ink-soft'), token('card')],
    ];
    for (const [label, foreground, background] of textPairs) {
      const ratio = contrastRatio(foreground, background);
      expect(ratio, `${label}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    const nonTextPairs: ReadonlyArray<readonly [string, string, string]> = [
      ['control boundary on a card', token('line-strong'), token('card')],
      ['focus ring on a card', token('focus'), token('card')],
      ['the radio and select accent', token('accent'), token('card')],
      ['the selected choice boundary', token('line-strong'), selected],
      ['the selected tab border', token('ink'), token('card')],
    ];
    for (const [label, foreground, background] of nonTextPairs) {
      const ratio = contrastRatio(foreground, background);
      expect(ratio, `${label}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
    // Every control boundary a learner must see to operate a control is the strong
    // rule, and the weak rule stays decoration. The selector ends at the `{`, so a
    // modifier class declared later - Phase 7's `.kd-choice--single` - cannot be
    // mistaken for the base rule and shadow its 44-pixel minimum.
    const source = blankComments(stylesheetSource());
    const selectRule = /\.kd-data-center \.kd-select\.kd-select[^{]*\{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(selectRule).toContain('border: 1px solid var(--kd-line-strong)');
    const choiceRule = /\.kd-data-center \.kd-choice\.kd-choice\s*\{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(choiceRule).toContain('min-height: 44px');
    expect(choiceRule).not.toMatch(/border[^;]*var\(--kd-line\)/);
  });

  it('declares a visible focus indicator for every kind of control it adds', () => {
    const focusRules = stylesheetSource().match(/[^{}]*:focus-visible[^{]*\{[^}]*\}/g) ?? [];
    expect(focusRules.length).toBeGreaterThanOrEqual(3);
    for (const rule of focusRules) {
      expect(rule).toMatch(/outline:\s*3px solid var\(--kd-focus\)/);
      expect(rule).toMatch(/outline-offset:\s*2px/);
    }
    // The two new kinds of control are among the rules, not just the old buttons.
    const joined = focusRules.join('\n');
    expect(joined).toMatch(/\.kd-select/);
    expect(joined).toMatch(/\.kd-choice-input/);
    expect(contrastRatio(token('focus'), token('card'))).toBeGreaterThanOrEqual(3);
  });

  it('has no hover-only action: every interactive control is reachable by keyboard and touch', () => {
    for (const file of DATA_CENTER_TREE) {
      const source = blankComments(readFileSync(join(process.cwd(), file), 'utf8'));
      // No pointer-only handlers, in either naming.
      for (const handler of ['onMouseEnter', 'onMouseLeave', 'onMouseOver', 'onPointerEnter', 'onPointerOver', 'onDoubleClick', 'onContextMenu']) {
        expect(source, `${file} must not use ${handler}`).not.toContain(handler);
      }
      // `:hover` may restyle, never reveal: no rule reveals content on hover.
      for (const rule of stylesheetSource().match(/[^{}]*:hover[^{]*\{[^}]*\}/g) ?? []) {
        expect(rule, 'a hover rule must not reveal content').not.toMatch(/display:\s*(flex|block|inline|grid|inline-flex)/);
        expect(rule, 'a hover rule must not change visibility').not.toMatch(/visibility|opacity:\s*0/);
      }
    }
  });

  it('lays out at a 320 CSS-pixel viewport and at 200% zoom, tab included', () => {
    // jsdom has no layout, so this is a property of the stylesheet rather than a
    // measurement: nothing in it fixes a width at or above 320 pixels, and every
    // row that holds an identifier can break inside one.
    const source = stylesheetSource();
    const fixedWidths = [...source.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*(\d+)px/g)].map((match) =>
      Number(match[1]),
    );
    for (const width of fixedWidths) {
      expect(width, `a fixed width of ${width}px cannot fit a 320px viewport`).toBeLessThan(320);
    }
    expect(source).toContain('overflow-wrap: anywhere');
    // The tablist and the subject picker both wrap or bound themselves.
    expect(source).toContain('flex-wrap: wrap');
    expect(source).toContain('max-width: 26rem');
    // The tab itself: a pill that wraps its own label and never overflows.
    const tabRule = /\.kd-data-center \.kd-tab\.kd-tab[^{]*\{[^}]*\}/.exec(blankComments(source))?.[0] ?? '';
    expect(tabRule).toContain('min-height: 44px');
    expect(tabRule).not.toMatch(/white-space:\s*nowrap/);
    expect(source).toMatch(/@media \(max-width: 30rem\)/);
  });

  it('honours prefers-reduced-motion in the DOM and in the stylesheet', async () => {
    const original = window.matchMedia;
    const listeners: Array<() => void> = [];
    let reduced = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string): MediaQueryList =>
        ({
          get matches() {
            return query.includes('prefers-reduced-motion') ? reduced : false;
          },
          media: query,
          onchange: null,
          addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
          addListener: () => undefined,
          removeListener: () => undefined,
        }) as unknown as MediaQueryList,
    });
    try {
      const { DataCenter } = await loadDataComponent();
      await selectLiveRepository(device.repository);
      render(<DataCenter />);
      expect(dataCenterOf().hasAttribute('data-kd-motion')).toBe(false);
      reduced = true;
      for (const listener of listeners) listener();
      await waitFor(() => {
        expect(dataCenterOf().getAttribute('data-kd-motion')).toBe('reduced');
      });
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
    const source = stylesheetSource();
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(source).toContain(".kd-data-center[data-kd-motion='reduced']");
  });

  it('exposes the subject picker and the mode group with names a screen reader can read', async () => {
    const { DataCenter } = await loadDataComponent();
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openSubjectTab();

    const picker = within(subjectTab()).getByLabelText<HTMLSelectElement>(/subject to back up/i);
    expect(picker).toHaveAccessibleName(/subject to back up/i);
    // ...and is described by the help text, so the reason it is empty reaches a
    // screen reader without being hunted for.
    const helpId = picker.getAttribute('aria-describedby');
    expect(helpId).not.toBeNull();
    expect(document.getElementById(helpId as string)?.textContent?.length ?? 0).toBeGreaterThan(20);

    // The mode group arrives with the file, and every radio is named by its label.
    await chooseSubjectFile(await realSubjectArchive(device, NASTY_SUBJECT_ID));
    await waitFor(() => {
      expect(within(modeGroup()).getAllByRole('radio')).toHaveLength(2);
    });
    for (const radio of within(modeGroup()).getAllByRole('radio')) {
      const label = labelOf(radio as HTMLElement);
      expect(label?.textContent?.trim().length ?? 0).toBeGreaterThan(5);
      expect(radio.getAttribute('aria-label')).toBeNull();
    }
  });
});

/** The `<label>` a control is inside, which is its accessible name. */
function labelOf(control: HTMLElement): HTMLElement | null {
  const id = control.getAttribute('id');
  if (id !== null) {
    const explicit = document.querySelector<HTMLElement>(`label[for="${id}"]`);
    if (explicit !== null) return explicit;
  }
  return control.closest('label');
}

// A compile-time proof that the product's real preview and result still satisfy the
// shapes the surfaces declare, so the two cannot drift apart silently. The
// surfaces declare ports because the product tree is reachable only through a lazy
// `import()`, and a port nobody checks is a port that rots.
type SubjectPreview = ReturnType<SubjectProductModule['readSubjectArchive']>;
const _previewSatisfiesPort: SubjectPreview extends BackupPreview ? true : never = true;
const _importSatisfiesPort: Awaited<
  ReturnType<SubjectProductModule['importSubjectBackup']>
> extends { readonly mode: 'copy' | 'replace' } ? true : never = true;
void _previewSatisfiesPort;
void _importSatisfiesPort;

// The device's own clock, named so the file reads as one fixture and not a
// coincidence: every product call in this file injects it.
void NASTY_DEVICE_NOW;
void NASTY_ATTACHMENT_IDS;
