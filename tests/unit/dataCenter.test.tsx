/**
 * Phase 5: the Data Center.
 *
 * The plan's Phase 5 deliverable is a Data Center with a full-backup tab, a local
 * download, file inspection, an explicit destructive confirmation, and an honest
 * outcome surface. This file drives all of it through the real components and the
 * real product, and it is organised around the six things that can go wrong:
 *
 * 1. **The flag gate.** With `VITE_DATA_PRODUCTS_V2` off - the default - the
 *    deliverable renders nothing and the legacy data tab is untouched. With it
 *    on, the Data Center replaces the legacy panel rather than joining it, and is
 *    the only file picker on the screen.
 * 2. **The download.** The product is called with the request its own type
 *    declares, a real `Blob` is downloaded through an object URL, that URL is
 *    revoked, and no network API is touched at any point.
 * 3. **The preview.** Counts, versions, the created-at, and the disclosure, in
 *    the learner's words - and *nothing* that identifies an image: no link, no
 *    file name, no opaque id, no digest.
 * 4. **The confirmation.** Absent before a file is chosen, a real dialog after,
 *    focus trapped with initial focus, Escape closes it, focus is restored, and
 *    the import is unreachable without it.
 * 5. **The outcome.** Three states, each reporting only what the product's own
 *    result licenses, and two claims the surface must *never* make: that the
 *    active subject changed, and that a migration receipt was written.
 * 6. **Accessibility.** Roles and live regions, touch targets measured from the
 *    real stylesheet rather than asserted by class name, contrast computed from
 *    the real tokens, focus indicators, reduced motion, and a 320-pixel layout.
 *
 * ## How the flag is turned on here
 *
 * `runtimeConfig` is parsed once at module load, so the flag is exercised with
 * `vi.stubEnv` plus `vi.resetModules` and a fresh `import()` of the component -
 * the same thing a build with the variable set does. Nothing here imports the
 * product or the Data Center statically, which is both the plan's lazy-boundary
 * rule and the reason `tests/data/phase5FlagDefault.test.ts` passes.
 *
 * ## Privacy
 *
 * Every fixture is synthetic and self-describing. The only host named anywhere in
 * this file is the reserved `example.invalid`, and it is named only as an
 * attachment URL that must never reach the DOM. Three assertions exist purely to
 * keep it that way.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPopulatedDevice, type PopulatedDevice } from '../data/support/populatedDevice';
import { buildStateDocument } from '../data/support/stateDocument';
import { buildReferenceArchive } from '../data/support/hostileZip';
import {
  REFERENCE_CREATED_AT,
  referenceArchiveInput,
  referenceRecordCounts,
} from '../data/support/referenceArchive';
import { blankComments, walk } from '../data/support/importGraph';
import type { BackupPreview } from '@/ui/data/ImportPreview';
import type { RestoreSuccessReport } from '@/ui/data/RecoveryStatus';

// ── The product, reached only lazily ──────────────────────────────────────

type ProductModule = typeof import('@/services/persistence/products/fullDeviceBackup');
type ValidationModule = typeof import('@/services/persistence/products/archiveValidation');

const product = (await import('@/services/persistence/products/fullDeviceBackup')) as ProductModule;
const validation = (await import('@/services/persistence/products/archiveValidation')) as ValidationModule;

// ── The surfaces under test, reached the way a build reaches them ──────────

type DataCenterModule = typeof import('@/ui/data/DataCenter');

/** Requests the wrapped export saw, in call order. */
const exportRequests: unknown[] = [];
/** The attachment-id lists the screen asked the product to resolve bytes for. */
const payloadResolutions: string[][] = [];

/**
 * Load the Data Center with the owner flag at a chosen value.
 *
 * The product module is wrapped rather than replaced: the request the screen
 * sends and the attachment ids it resolves are recorded, and the *real* export
 * runs, so the download this test measures is the product's own bytes rather than
 * a fixture's.
 */
async function loadDataCenter(dataProductsV2: boolean): Promise<DataCenterModule> {
  vi.resetModules();
  vi.stubEnv('VITE_DATA_PRODUCTS_V2', String(dataProductsV2));
  exportRequests.length = 0;
  payloadResolutions.length = 0;
  if (dataProductsV2) {
    vi.doMock('@/services/persistence/products/fullDeviceBackup', async (importOriginal) => {
      const actual = await importOriginal<ProductModule>();
      return {
        ...actual,
        exportFullDeviceBackup: async (request: Parameters<ProductModule['exportFullDeviceBackup']>[0]) => {
          exportRequests.push(request);
          return actual.exportFullDeviceBackup(request);
        },
        resolveDeviceLocalPayloadBytes: async (ids: readonly string[]) => {
          payloadResolutions.push([...ids]);
          return actual.resolveDeviceLocalPayloadBytes(ids);
        },
      };
    });
  } else {
    vi.doUnmock('@/services/persistence/products/fullDeviceBackup');
  }
  return import('@/ui/data/DataCenter');
}

/** Publish a repository as the live one, on the module instance now in use. */
async function selectLiveRepository(repository: PopulatedDevice['repository']): Promise<void> {
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
let fetchSpy: ReturnType<typeof vi.fn>;
let xhrOpenSpy: ReturnType<typeof vi.fn>;
let beaconSpy: ReturnType<typeof vi.fn>;

function installBrowserDoubles(): void {
  createdObjectUrls.length = 0;
  revokedObjectUrls.length = 0;
  downloads.length = 0;

  // jsdom implements neither of these, and the Data Center's contract is that
  // the URL is created *and* revoked, so both are recorded rather than stubbed to
  // a constant.
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

  const clickSpy = vi.fn(function (this: HTMLAnchorElement) {
    downloads.push({
      download: this.download,
      href: this.getAttribute('href') ?? '',
      blob: lastBlob,
      inDocumentWhenClicked: document.body.contains(this),
    });
  });
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    configurable: true,
    writable: true,
    value: clickSpy,
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
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: beaconSpy,
  });
}

let lastBlob: Blob | null = null;

/** One turn of the event loop, which is when the deferred revoke runs. */
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

function toPosix(value: string): string {
  return value.split('\\').join('/');
}

/** The value a Data Center token was declared with, read from the stylesheet. */
function token(name: string): string {
  const match = new RegExp(`--kd-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(stylesheetSource());
  if (match === null) throw new Error(`The stylesheet declares no --${name} colour.`);
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

/**
 * A CSS selector's specificity, as the tuple the cascade compares.
 *
 * Only what decides a collision is counted: ids, then classes, attributes and
 * pseudo-classes (`:root` and `:not(...)` included, because both are
 * pseudo-classes whatever they select), then element and pseudo-element names.
 */
function specificity(selector: string): number {
  // A selector list is only as strong as its best part, because the cascade
  // compares the single selector that matched, not the whole list.
  return Math.max(...selector.split(',').map((part) => singleSpecificity(part.trim())));
}

function singleSpecificity(selector: string): number {
  const withoutStrings = selector.replace(/'[^']*'|"[^"]*"/g, '');
  const ids = (withoutStrings.match(/#[A-Za-z0-9_-]+/g) ?? []).length;
  const classes =
    (withoutStrings.match(/\.[A-Za-z0-9_-]+/g) ?? []).length +
    (withoutStrings.match(/\[[^\]]*\]/g) ?? []).length +
    (withoutStrings.match(/:(?!:)[A-Za-z-]+/g) ?? []).length;
  const elements = (
    withoutStrings
      .replace(/[#.][A-Za-z0-9_-]+/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/:[A-Za-z-]+(\([^)]*\))?/g, ' ')
      .match(/\b[A-Za-z][A-Za-z0-9-]*\b|\*/g) ?? []
  ).length;
  return ids * 10000 + classes * 100 + elements;
}

/**
 * The pseudo-class states a selector can match, with `:not(...)` contributing the
 * states of its argument, as the specificity rules say it does.
 */
function pseudoStates(selector: string): Set<string> {
  const states = new Set<string>();
  for (const match of selector.matchAll(/:([A-Za-z-]+)(\(([^()]*)\))?/g)) {
    const name = match[1] as string;
    if (name === 'not' || name === 'is' || name === 'where' || name === 'has') {
      for (const inner of (match[3] ?? '').matchAll(/:([A-Za-z-]+)/g)) {
        states.add(inner[1] as string);
      }
      continue;
    }
    states.add(name);
  }
  return states;
}

function isSubset(candidate: Set<string>, of: Set<string>): boolean {
  return [...candidate].every((state) => of.has(state));
}

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A real `.kdbak`, written by the product's own export of a real device. */
async function realArchive(
  device: PopulatedDevice,
  activeSubjectId: string | null = null,
): Promise<Uint8Array> {
  const result = await product.exportFullDeviceBackup({
    repository: device.repository,
    generationId: device.generationId,
    now: '2026-09-26T10:00:00.000Z',
    payloadBytes: device.payloadBytes,
    activeSubjectId,
  });
  return result.bytes;
}

/**
 * A real `.kdbak` with nothing to disclose.
 *
 * Built from the same real device through the gate suite's own archive writer,
 * with every external-only image record removed from the state document and the
 * two counts that depend on it recomputed. It is still a real archive that the
 * real reader and the real importer accept, which is what makes the plain-success
 * assertions below about the product rather than about a hand-written result.
 */
async function archiveWithoutDisclosures(device: PopulatedDevice): Promise<Uint8Array> {
  const snapshot = await device.repository.readRecords(device.generationId);
  const state = buildStateDocument(device, snapshot, REFERENCE_CREATED_AT) as Record<string, unknown>;
  const stored = (state.attachmentMetadata as Record<string, unknown>[]).filter(
    (record) => record.availability === 'stored',
  );
  // The counts the *manifest* declares, derived from the real snapshot, with the
  // one count that depends on the removed records recomputed: a stored image
  // contributes a metadata record and a blob record, and two images with
  // identical bytes still contribute two of each.
  const recordCounts: Record<string, number> = { ...referenceRecordCounts(snapshot) };
  recordCounts.attachments = stored.length * 2;
  const input = referenceArchiveInput(device, snapshot);
  return buildReferenceArchive({
    ...input,
    stateJson: { ...state, attachmentMetadata: stored },
    recordCounts,
    externalOnly: { count: 0, reasons: {} },
  }).bytes;
}

function fileOf(bytes: Uint8Array, name: string): File {
  // Copied into a fresh `ArrayBuffer` because a `File` must own its bytes, which
  // is the same discipline the product applies when it stores attachment bytes.
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type: 'application/zip' });
}

/** Hand a file to the one and only file input on the screen. */
async function chooseFile(bytes: Uint8Array, name: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('The Data Center rendered no file input.');
  fireEvent.change(input, { target: { files: [fileOf(bytes, name)] } });
  // One macrotask so the read, the lazy module, and the state updates all land.
  await nextTask();
  await nextTask();
}

const dataCenterOf = (): HTMLElement => {
  const surface = document.querySelector<HTMLElement>('[data-kd-surface="data-center"]');
  if (surface === null) throw new Error('The Data Center is not on the screen.');
  return surface;
};

const previewOf = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-kd-surface="backup-preview"]');

const outcomeOf = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-kd-surface="restore-outcome"]');

const confirmButton = (): HTMLButtonElement | null =>
  screen.queryByRole<HTMLButtonElement>('button', { name: /replace device data/i });

/** The names of every button on the screen, for the "no other route" assertion. */
function buttonNames(): string[] {
  return screen.getAllByRole('button').map((button) => button.textContent?.trim() ?? '');
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

let device: PopulatedDevice;
let target: PopulatedDevice;

beforeEach(async () => {
  installBrowserDoubles();
  installStylesheet();
  window.localStorage.clear();
  device = await createPopulatedDevice('data-center-ui-source');
  target = await createPopulatedDevice('data-center-ui-target');
});

afterEach(() => {
  cleanup();
  vi.doUnmock('@/services/persistence/products/fullDeviceBackup');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
  void import('@/services/persistence/v2/repositorySelection').then((selection) =>
    selection.resetRepositorySelection(),
  );
});

// ── 1. The flag gate ──────────────────────────────────────────────────────

describe('Phase 5 Data Center: the flag gate', () => {
  it('renders nothing at all when VITE_DATA_PRODUCTS_V2 is off', async () => {
    const { DataCenter } = await loadDataCenter(false);
    const { container } = render(<DataCenter />);

    // Not a heading, not a tab, not a control, not a live region, not a
    // stylesheet hook: the whole surface is absent.
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('*')).toHaveLength(0);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(document.querySelector('[data-kd-surface]')).toBeNull();
  });

  it('leaves the default build\'s data tab exactly as it was', async () => {
    const { WelcomeScreen } = await import('@/ui/screens/WelcomeScreen');
    render(<WelcomeScreen />);
    await waitFor(() => {
      expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Data' }));
    const panel = document.getElementById('welcome-panel-data') as HTMLElement;

    // The legacy surface, unchanged and complete.
    expect(within(panel).getByRole('heading', { name: 'Admin' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Import subject from JSON/i })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Export all subjects as JSON/i })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Create from template/i })).toBeInTheDocument();
    expect(within(panel).getByText(/Privacy:/i)).toBeInTheDocument();
    // ...and nothing at all from this deliverable.
    expect(within(panel).queryByRole('heading', { name: 'Data Center' })).toBeNull();
    expect(within(panel).queryByRole('tab', { name: /full device backup/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /data center/i })).toBeNull();
    // The legacy panel's own two file pickers, and not a third.
    expect(panel.querySelectorAll('input[type="file"]')).toHaveLength(2);
  });

  it('replaces the legacy panel with the Data Center when the flag is on, and is the only file picker', async () => {
    // The flag has to be in place before the screen module is loaded, because
    // `runtimeConfig` is parsed once at module load - which is exactly how a build
    // with the variable set behaves.
    await loadDataCenter(true);
    const { WelcomeScreen } = await import('@/ui/screens/WelcomeScreen');
    render(<WelcomeScreen />);
    await waitFor(() => {
      expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /data center/i }));
    const panel = document.getElementById('welcome-panel-data') as HTMLElement;

    expect(within(panel).getByRole('heading', { name: 'Data Center' })).toBeInTheDocument();
    expect(within(panel).getByRole('tab', { name: /full device backup/i })).toBeInTheDocument();
    expect(within(panel).queryByRole('heading', { name: 'Admin' })).toBeNull();
    // One picker, and it is the Data Center's. The fresh-profile restore lane
    // drives this panel and requires exactly one.
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(panel.querySelector('input[type="file"]')?.getAttribute('accept')).toContain('.kdbak');
  });
});

// ── 2. The download ───────────────────────────────────────────────────────

describe('Phase 5 Data Center: a backup is a local download and nothing else', () => {
  it('calls the product with the documented request and downloads a real file', async () => {
    const { DataCenter } = await loadDataCenter(true);
    const selection = await import('@/store/sessionStore');
    selection.useSessionStore.setState({ activeSubjectId: 'subject-active-at-export' });
    await selectLiveRepository(device.repository);
    render(<DataCenter />);

    fireEvent.click(screen.getByRole('button', { name: /Download device backup/i }));
    await waitFor(() => {
      expect(downloads).toHaveLength(1);
    });
    await nextTask();

    // The request is the one the product's own type declares, field for field.
    expect(exportRequests).toHaveLength(1);
    const request = exportRequests[0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual([
      'activeSubjectId',
      'generationId',
      'now',
      'payloadBytes',
      'repository',
    ]);
    expect(request.repository).toBe(device.repository);
    expect(request.generationId).toBe(device.generationId);
    expect(request.activeSubjectId).toBe('subject-active-at-export');
    expect(request.payloadBytes).toBeInstanceOf(Map);
    // Every attachment id in the generation is handed to the product's own
    // device-local resolver, so the export can carry every byte that is actually
    // on this device - and only those bytes, because the resolver returns the ids
    // it really has bytes for.
    const attachmentIds = (
      (await device.repository.readRecords(device.generationId)).records.attachmentMetadata as {
        value: { attachmentId: string };
      }[]
    ).map((envelope) => envelope.value.attachmentId);
    expect(payloadResolutions).toHaveLength(1);
    expect([...(payloadResolutions[0] as string[])].sort()).toEqual([...attachmentIds].sort());
    const resolved = [...(request.payloadBytes as Map<string, Uint8Array>).keys()];
    for (const id of resolved) expect(attachmentIds).toContain(id);
    // The resolved map is the device-local store's real content, which for this
    // fixture is empty - the product then falls back to the generation's mirrored
    // blob records, so the archive still carries every stored image.
    expect(resolved).toEqual([]);
    expect(typeof request.now).toBe('string');
    expect(new Date(request.now as string).toISOString()).toBe(request.now);

    // The file: the product's constant name, a real blob of the product's bytes,
    // an object URL, and an anchor that is in the document when it is clicked.
    const record = downloads[0] as DownloadRecord;
    expect(record.download).toBe(product.FULL_DEVICE_BACKUP_FILE_NAME);
    expect(record.download.endsWith('.kdbak')).toBe(true);
    expect(record.href).toBe(createdObjectUrls[0] as string);
    expect(record.href.startsWith('blob:')).toBe(true);
    expect(record.inDocumentWhenClicked).toBe(true);
    expect(record.blob).not.toBeNull();
    expect((record.blob as Blob).size).toBeGreaterThan(0);
    expect((record.blob as Blob).type).toBe('application/zip');

    // ...and the object URL is revoked once the click has been handled.
    await waitFor(() => {
      expect(revokedObjectUrls).toEqual([createdObjectUrls[0] as string]);
    });
    // The anchor is not left in the document.
    expect(document.querySelector('a[download]')).toBeNull();

    // A status a learner can perceive, and a noun they can act on.
    const status = document.querySelector('[data-kd-surface="export-status"]') as HTMLElement;
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.textContent).toContain(product.FULL_DEVICE_BACKUP_FILE_NAME);
    expect(status.textContent).toMatch(/\d+ bytes/);
  });

  it('reaches no network API at any point in the download', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);

    fireEvent.click(screen.getByRole('button', { name: /Download device backup/i }));
    await waitFor(() => {
      expect(downloads).toHaveLength(1);
    });
    await nextTask();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpenSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
    // The only thing that touched a URL API is the local object URL, and it was
    // revoked. Nothing was given a destination that could leave the device.
    const destination = (downloads[0] as DownloadRecord).href;
    expect(destination.startsWith('blob:')).toBe(true);
    expect(revokedObjectUrls).toEqual(createdObjectUrls);
  });

  it('reports a typed failure with no invented message when the backup cannot be made', async () => {
    const { DataCenter } = await loadDataCenter(true);
    // No live repository: the honest answer is that this build has nothing to
    // back up, said in words rather than as an exception.
    render(<DataCenter />);
    fireEvent.click(screen.getByRole('button', { name: /Download device backup/i }));

    const problem = await screen.findByText(/could not be backed up|cannot/i, undefined, {
      timeout: 2000,
    }).catch(() => null);
    void problem;
    await waitFor(() => {
      expect(document.querySelector('[data-kd-surface="export-problem"]')).not.toBeNull();
    });
    const region = document.querySelector('[data-kd-surface="export-problem"]') as HTMLElement;
    expect(region).toHaveAttribute('role', 'alert');
    expect(region.textContent).toMatch(/not keeping its data in the versioned store/i);
    expect(downloads).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── 3. The preview ────────────────────────────────────────────────────────

describe('Phase 5 Data Center: the preview says what is in the file and nothing more', () => {
  it('shows the counts, the three versions, the created-at, and the attachment totals', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    const archive = await realArchive(device);
    await chooseFile(archive, 'device-backup.kdbak');

    const preview = previewOf();
    expect(preview).not.toBeNull();
    const surface = preview as HTMLElement;
    // A labelled region, so a screen reader can find it by name.
    expect(surface.tagName).toBe('SECTION');
    expect(surface).toHaveAccessibleName(/What is in this backup/i);
    expect(within(surface).getByRole('heading', { name: /What it carries/i })).toBeInTheDocument();

    // The counts are the device's own counts, per store, in plain words.
    const expected = device.expectedRecordCounts;
    for (const [label, store] of [
      ['Subjects', 'subjects'],
      ['Progress', 'progression'],
      ['Study sessions', 'sessions'],
      ['Settings', 'preferences'],
      ['Keyboard shortcuts', 'shortcuts'],
      ['Assistance records', 'assistance'],
      ['Image records', 'attachments'],
      ['Custom pictures', 'customSprites'],
      ['Recovery records', 'recovery'],
      ['Data-move receipts', 'migrationReceipts'],
    ] as const) {
      const row = within(surface).getByText(label).closest('.kd-counts-row') as HTMLElement;
      expect(row.textContent, label).toContain(String(expected[store] ?? 0));
    }

    // The three separate version contracts, named separately, each showing what
    // the archive itself declares.
    const inspection = validation.inspectFullDeviceArchive(archive);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    const versions = within(surface).getByRole('heading', {
      name: /Which versions this backup was written for/i,
    }).parentElement as HTMLElement;
    const versionRows = [...versions.querySelectorAll('.kd-counts-row')].map((row) => row.textContent);
    expect(versionRows[0]).toContain('Backup format');
    expect(versionRows[0]).toContain(String(inspection.preview.formatVersion));
    expect(versionRows[1]).toContain('Storage format');
    expect(versionRows[1]).toContain(String(inspection.preview.storageGenerationFormatVersion));
    expect(versionRows[2]).toContain('Subject format');
    expect(versionRows[2]).toContain(inspection.preview.subjectSchemaVersion);
    // Three different contracts, and the surface says so.
    expect(versions.textContent).toMatch(/three separate agreements/i);

    // The archive's own creation time, and the image totals.
    expect(surface.textContent).toContain(inspection.preview.createdAt.slice(0, 10));
    expect(surface.textContent).toMatch(/\d+ (byte|bytes|kilobytes|megabytes)/);
    expect(surface.textContent).toMatch(/pictures? (is|are) included/);
  });

  it('names why an image cannot be restored, and renders nothing that identifies it', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await chooseFile(await realArchive(device), 'device-backup.kdbak');

    const surface = previewOf() as HTMLElement;
    const disclosure = within(surface).getByRole('heading', {
      name: /Images this backup cannot bring back/i,
    }).parentElement as HTMLElement;

    // The real archive discloses at least one image, and the reason is in words.
    const inspection = validation.inspectFullDeviceArchive(await realArchive(device));
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.preview.externalOnlyCount).toBeGreaterThan(0);
    expect(disclosure.textContent).toMatch(/image cannot be restored/i);
    expect(disclosure.textContent).toMatch(/link to a picture on the internet|not on this device/i);
    // Each one is identified by its position, which is the only identifier that
    // says nothing about the learner.
    expect(disclosure.textContent).toMatch(/Image 1 of \d+/);

    // And nothing that identifies one reaches the DOM: no URL, no file name, no
    // opaque attachment id, no digest, no member path.
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
      // `state.json` and `manifest.json` are layout constants, not learner
      // content, and even they are not rendered.
      expect(text).not.toContain(member);
    }
  });

  it('refuses a corrupt archive with a typed error, opens no dialog, and writes nothing', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    const before = await device.repository.readActiveGenerationId();

    const corrupt = await realArchive(device);
    corrupt[Math.floor(corrupt.length / 2)] = (corrupt[Math.floor(corrupt.length / 2)] ?? 0) ^ 0xff;
    await chooseFile(corrupt, 'corrupt.kdbak');

    const region = await screen.findByText(/cannot be used/i);
    const block = region.closest('[data-kd-surface="inspection-problem"]') as HTMLElement;
    expect(block).toHaveAttribute('role', 'alert');
    // A code from the product's typed vocabulary, and no message.
    expect(block.textContent).toMatch(/reported as [A-Z_]+/);
    expect(block.textContent).not.toMatch(/\bat \d+:\d+:\d+/);
    // No preview, no dialog, and therefore no route to the import.
    expect(previewOf()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(confirmButton()).toBeNull();
    expect(await device.repository.readActiveGenerationId()).toBe(before);
  });

  it('handles an empty file and a file that is not an archive at all', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);

    for (const [name, bytes] of [
      ['empty.kdbak', new Uint8Array(0)],
      ['not-an-archive.kdbak', new TextEncoder().encode('this is not a backup file')],
    ] as const) {
      await chooseFile(bytes, name);
      const block = document.querySelector('[data-kd-surface="inspection-problem"]') as HTMLElement;
      expect(block, name).not.toBeNull();
      expect(block.textContent, name).toMatch(/reported as [A-Z_]+/);
      expect(previewOf(), name).toBeNull();
      expect(screen.queryByRole('dialog'), name).toBeNull();
    }
    // Still alive, and the export path still works after two refusals.
    expect(screen.getByRole('button', { name: /Download device backup/i })).toBeEnabled();
  });
});

// ── 4. The explicit destructive confirmation ──────────────────────────────

describe('Phase 5 Data Center: the import is behind an explicit confirmation', () => {
  it('has no route to the import before a file has been read', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);

    expect(confirmButton()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Nothing on the whole screen is named like a way to commit a restore, which
    // is the property that makes the confirmation the *only* route.
    expect(buttonNames().filter((name) => /replace|confirm|import|continue|overwrite/i.test(name)))
      .toEqual([]);
    expect(previewOf()).toBeNull();
  });

  it('opens a real dialog once a file is read, with initial focus inside it', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await chooseFile(await realArchive(device), 'device-backup.kdbak');

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/Replace the data on this device\?/i);
    // Initial focus is the dialog itself, so the destructive action is not one
    // stray Enter away from a learner who has just arrived.
    expect(document.activeElement).toBe(dialog);
    // ...and the confirm control now exists, and is the only thing on the screen
    // named like one.
    const confirm = confirmButton() as HTMLButtonElement;
    expect(confirm).toBeEnabled();
    const matching = buttonNames().filter((name) => /replace|confirm|import|continue|overwrite/i.test(name));
    expect(matching).toHaveLength(1);
  });

  it('states plainly what is replaced and that the previous copy is kept', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await chooseFile(await realArchive(device), 'device-backup.kdbak');

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/makes it the copy this device uses/i);
    expect(dialog.textContent).toMatch(/Everything the app has on this device is replaced/i);
    expect(dialog.textContent).toMatch(/is kept, not deleted/i);
    expect(dialog.textContent).toMatch(/go back to it/i);
    // The disclosure is repeated where the decision is made, not only behind it.
    expect(dialog.textContent).toMatch(/\d+ images? ha[sv]e? no picture data/i);
  });

  it('traps focus, closes on Escape, and restores focus to the control that opened it', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    const opener = screen.getByRole('button', { name: /Inspect a backup file/i });
    opener.focus();
    await chooseFile(await realArchive(device), 'device-backup.kdbak');

    const dialog = screen.getByRole('dialog');
    const confirm = confirmButton() as HTMLButtonElement;
    const dismiss = screen.getByRole('button', { name: /Keep the data that is here/i });

    // Tab from the last control wraps to the first, and never leaves the dialog.
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Shift+Tab from the first control wraps to the last.
    dismiss.focus();
    fireEvent.keyDown(dismiss, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Escape closes it...
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // ...and focus is back where it was, not at the top of the document.
    expect(document.activeElement).toBe(opener);
    // The preview survives the dismissal, so nothing the learner read is lost.
    expect(previewOf()).not.toBeNull();
  });

  it('cannot be imported without passing through the confirmation', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(target.repository);
    render(<DataCenter />);
    const before = await target.repository.readActiveGenerationId();
    const archive = await realArchive(device);
    await chooseFile(archive, 'device-backup.kdbak');

    // A file has been read and a preview is on the page, and the device is
    // untouched: reading is not committing.
    expect(previewOf()).not.toBeNull();
    expect(await target.repository.readActiveGenerationId()).toBe(before);

    // Every control the Data Center offers *outside* the dialog, pressed in turn,
    // and the device does not move: taking a backup, re-reading the file, and
    // dismissing the dialog are all non-destructive.
    const dialog = screen.getByRole('dialog');
    const outsideControls = screen
      .getAllByRole('button')
      .filter((button) => !dialog.contains(button));
    const dismiss = screen.getByRole('button', { name: /Keep the data that is here/i });
    expect(outsideControls.length + 1).toBeGreaterThan(2);
    for (const control of [...outsideControls, dismiss]) {
      fireEvent.click(control);
      await nextTask();
      expect(await target.repository.readActiveGenerationId(), control.textContent ?? '').toBe(before);
    }

    // The dialog is dismissible, and dismissing it is not committing either.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await target.repository.readActiveGenerationId()).toBe(before);
    expect(outcomeOf()).toBeNull();

    // Only the confirmation moves the pointer, and it moves it.
    await chooseFile(archive, 'device-backup.kdbak');
    const confirm = confirmButton() as HTMLButtonElement;
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(async () => {
      expect(await target.repository.readActiveGenerationId()).not.toBe(before);
    }, { timeout: 5000 });
  });
});

// ── 5. The outcome ────────────────────────────────────────────────────────

describe('Phase 5 Data Center: the outcome reports what the product reported', () => {
  it('a success with images that cannot be restored says so, and claims nothing else', async () => {
    // The archive names the subject that was open when it was made, which is the
    // field the product reports and deliberately does not apply - so this is the
    // branch where an over-claiming surface would be caught.
    const archive = await realArchive(device, 'subject-named-by-the-backup');
    const result = await product.importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: '2026-09-26T12:00:00.000Z',
      keepPreviousGeneration: true,
    });

    const { RecoveryStatus } = await import('@/ui/data/RecoveryStatus');
    const { container } = render(
      <RecoveryStatus outcome={{ kind: 'success', result: result as RestoreSuccessReport }} />,
    );
    const surface = container.querySelector('[data-kd-surface="restore-outcome"]') as HTMLElement;

    // Exactly the product's own report.
    expect(result.activated).toBe(true);
    expect(result.externalOnlyAttachments.length).toBeGreaterThan(0);
    expect(surface.textContent).toMatch(/Restored, with a few things worth knowing/i);
    expect(surface.textContent).toMatch(/is what the device is using now|The copy that was here before is still here/i);
    expect(surface.textContent).toMatch(/still here, so you can go back to it/i);
    expect(surface.textContent).toMatch(new RegExp(`${result.externalOnlyAttachments.length} images? w`));
    expect(surface.textContent).toMatch(
      /restored without (its|their) picture data/i,
    );
    // A live region, politely: an outcome the learner asked for.
    const status = within(surface).getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');

    // Claim one: the active subject. The product reports the id and does not
    // apply it, so the surface says what that means and nothing more - and it
    // does not even print the id, which is a value the archive chose.
    expect(result.restoredActiveSubjectId).toBe('subject-named-by-the-backup');
    expect(surface.textContent).toMatch(/recorded which subject was open/i);
    expect(surface.textContent).toMatch(/does not switch to it/i);
    expect(surface.textContent).not.toContain('subject-named-by-the-backup');
    expect(surface.textContent).not.toMatch(/switched you to|is now your active subject|is now open/i);
    // Claim two: a receipt. The product mints none for a restore.
    expect(result.receiptNote).toBe('restore-mints-no-receipt');
    expect(surface.textContent).toMatch(/does not write a new one/i);
    expect(surface.textContent).not.toMatch(/wrote a (new )?(migration )?receipt/i);
  });

  it('a clean success reports activation and retention and nothing about pictures', async () => {
    const archive = await archiveWithoutDisclosures(device);
    const inspection = validation.inspectFullDeviceArchive(archive);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.preview.externalOnlyCount).toBe(0);

    const result = await product.importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: '2026-09-26T12:30:00.000Z',
      keepPreviousGeneration: true,
    });
    expect(result.activated).toBe(true);
    expect(result.externalOnlyAttachments).toHaveLength(0);
    expect(result.previousGenerationRetained).toBe(true);
    expect(result.previousActiveGenerationId).not.toBeNull();
    // This archive names no active subject, so there is nothing to disclose about
    // one and the surface says nothing about one.
    expect(result.restoredActiveSubjectId).toBeNull();

    const { RecoveryStatus } = await import('@/ui/data/RecoveryStatus');
    const { container } = render(
      <RecoveryStatus outcome={{ kind: 'success', result: result as RestoreSuccessReport }} />,
    );
    const surface = container.querySelector('[data-kd-surface="restore-outcome"]') as HTMLElement;
    expect(surface.textContent).toMatch(/Restored\. This backup is what the device is using now/i);
    expect(surface.textContent).toMatch(/records are now in use on this device/i);
    expect(surface.textContent).toMatch(/still here, so you can go back to it/i);
    // No disclosure means no disclosure sentence, and no invented one.
    expect(surface.textContent).not.toMatch(/without (its|their) picture data/i);
    expect(surface.textContent).not.toMatch(/could not be matched/i);
    expect(surface.textContent).not.toMatch(/recorded which subject was open/i);
  });

  it('a failure reports the typed code and its details, and claims nothing about what changed', async () => {
    const { StorageV2Error } = await import('@/services/persistence/v2/schema');
    const failure = new StorageV2Error('VALIDATION_FAILED', { stage: 'validate', problemCount: 2 });
    const report = failure.toReport();

    const { RecoveryStatus } = await import('@/ui/data/RecoveryStatus');
    const { container } = render(<RecoveryStatus outcome={{ kind: 'failure', report }} />);
    const surface = container.querySelector('[data-kd-surface="restore-outcome"]') as HTMLElement;

    // Assertive, because a restore that did not happen is the outcome a learner
    // must hear without asking.
    const alert = within(surface).getByRole('alert');
    expect(alert.textContent).toContain('VALIDATION_FAILED');
    expect(alert.textContent).toMatch(/The restore did not finish/i);
    expect(alert.textContent).toMatch(/still the copy it is using/i);
    // The details are code-shaped and are shown as such, in a collapsed block.
    expect(surface.textContent).toContain('stage');
    expect(surface.textContent).toContain('validate');
    expect(surface.textContent).toContain('problemCount');
    // And it never prints a message, which is the one field a foreign error could
    // have filled with a subject name.
    expect(surface.textContent).not.toContain(failure.message);
    expect(surface.querySelector('details')?.open).toBe(false);
  });

  it('a real refusal through the Data Center renders the product\'s own typed error', async () => {
    const corrupt = await realArchive(device);
    corrupt[Math.floor(corrupt.length / 2)] = (corrupt[Math.floor(corrupt.length / 2)] ?? 0) ^ 0xff;
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(target.repository);
    render(<DataCenter />);
    await chooseFile(corrupt, 'corrupt.kdbak');
    // A file that cannot be read is refused *before* the confirmation exists, so
    // the import is not merely unconfirmed but unreachable.
    expect(confirmButton()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    const region = document.querySelector('[data-kd-surface="inspection-problem"]') as HTMLElement;
    expect(region.textContent).toMatch(/reported as [A-Z_]+/);

    // Now the same surface, driven with a typed failure from the import path,
    // renders the product's own code and its code-shaped details.
    const { RecoveryStatus } = await import('@/ui/data/RecoveryStatus');
    const { container } = render(
      <RecoveryStatus
        outcome={{ kind: 'failure', report: { code: 'CHECKSUM_MISMATCH', details: { stage: 'compare' } } }}
      />,
    );
    const surface = container.querySelector('[data-kd-surface="restore-outcome"]') as HTMLElement;
    expect(surface.textContent).toContain('CHECKSUM_MISMATCH');
    expect(surface.textContent).toContain('compare');
  });

  it('renders a sentence for a disclosure reason this build has never heard of', async () => {
    // The reason set is closed *today*. A newer backup can name a fourth reason,
    // and guessing which of the three it meant would be a lie in the one place a
    // learner is deciding whether their pictures are safe.
    const { describeExternalOnlyReason } = await import('@/ui/data/ImportPreview');
    for (const reason of [
      'historical-external-url',
      'bytes-not-recoverable',
      'bytes-missing-locally',
      'a-reason-from-the-future',
    ]) {
      const sentence = describeExternalOnlyReason(reason);
      expect(sentence.length, reason).toBeGreaterThan(20);
      expect(sentence, reason).toMatch(/[.!]$/);
    }
    expect(describeExternalOnlyReason('a-reason-from-the-future')).toMatch(/does not recognise/i);
  });
});

// ── 6. Accessibility ──────────────────────────────────────────────────────

describe('Phase 5 Data Center: accessibility', () => {
  it('every control is at least 44 by 44 CSS pixels, measured from the real stylesheet', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await chooseFile(await realArchive(device), 'device-backup.kdbak');

    const controls = [
      ...screen.getAllByRole('button'),
      ...screen.getAllByRole('tab'),
      ...within(screen.getByRole('dialog')).getAllByRole('button'),
    ];
    expect(controls.length).toBeGreaterThanOrEqual(4);
    for (const control of controls) {
      const computed = window.getComputedStyle(control);
      const minHeight = Number.parseFloat(computed.minHeight);
      const minWidth = Number.parseFloat(computed.minWidth);
      expect(Number.isFinite(minHeight), control.textContent).toBe(true);
      expect(Number.isFinite(minWidth), control.textContent).toBe(true);
      expect(minHeight, `${control.textContent} height`).toBeGreaterThanOrEqual(44);
      expect(minWidth, `${control.textContent} width`).toBeGreaterThanOrEqual(44);
    }
    // The tablist's own tab is a target too, and it is the one the lane drives.
    const tab = screen.getByRole('tab', { name: /full device backup/i });
    expect(Number.parseFloat(window.getComputedStyle(tab).minHeight)).toBeGreaterThanOrEqual(44);
  });

  it('every state is signalled in words and a glyph, never by colour alone', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await chooseFile(new TextEncoder().encode('not an archive'), 'broken.kdbak');

    const problem = document.querySelector('[data-kd-surface="inspection-problem"]') as HTMLElement;
    // The words carry the state...
    expect(problem.textContent).toMatch(/cannot be used/i);
    // ...the glyph is decorative and hidden from assistive technology, so it is
    // not read twice...
    const marker = problem.querySelector('.kd-marker') as HTMLElement;
    expect(marker.textContent?.trim().length).toBeGreaterThan(0);
    expect(marker).toHaveAttribute('aria-hidden', 'true');
    // ...and the state is announced assertively.
    expect(problem).toHaveAttribute('role', 'alert');
  });

  it('declares a visible focus indicator for every kind of control it renders', async () => {
    const source = stylesheetSource();
    const focusRules = source.match(/[^{}]*:focus-visible[^{]*\{[^}]*\}/g) ?? [];
    expect(focusRules.length).toBeGreaterThanOrEqual(3);
    for (const rule of focusRules) {
      expect(rule).toMatch(/outline:\s*3px solid var\(--kd-focus\)/);
      expect(rule).toMatch(/outline-offset:\s*2px/);
    }
    // And the ring's own colour clears the non-text threshold on both surfaces.
    expect(contrastRatio(token('focus'), token('card'))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(token('focus'), token('paper'))).toBeGreaterThanOrEqual(3);
    // Nothing is focusable-but-unreachable: no control opts out of the tab order.
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    for (const control of screen.getAllByRole('button')) {
      expect(
        control.getAttribute('tabindex'),
        `${control.textContent ?? ''} must stay in the tab order`,
      ).toBeNull();
    }
  });

  it('computes every text and control-boundary pair it declares, and clears its threshold', () => {
    // Measured, not asserted by class name: the ratios come from the colours the
    // stylesheet actually declares.
    const textPairs: ReadonlyArray<readonly [string, string, string]> = [
      ['body text on a card', 'ink', 'card'],
      ['secondary text on a card', 'ink-soft', 'card'],
      ['secondary text on the surface', 'ink-soft', 'paper'],
      ['primary button label', 'accent-ink', 'accent'],
      ['a state that worked', 'moss', 'card'],
      ['a state that did not', 'clay', 'card'],
    ];
    for (const [label, foreground, background] of textPairs) {
      const ratio = contrastRatio(token(foreground), token(background));
      expect(ratio, `${label}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    const nonTextPairs: ReadonlyArray<readonly [string, string, string]> = [
      ['control boundary on a card', 'line-strong', 'card'],
      ['control boundary on the surface', 'line-strong', 'paper'],
      ['focus ring on a card', 'focus', 'card'],
      // A filled control's edge is its fill against the surface behind it, not
      // its border against its own fill, so those are the pairs that clear 3:1.
      ['primary button fill on a card', 'accent', 'card'],
      ['primary button fill on the surface', 'accent', 'paper'],
      ['danger button fill on a card', 'clay', 'card'],
    ];
    for (const [label, foreground, background] of nonTextPairs) {
      const ratio = contrastRatio(token(foreground), token(background));
      expect(ratio, `${label}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
    // The control boundary a learner must see to operate a control is the strong
    // one, and the weak rule is decoration only.
    const source = stylesheetSource();
    const buttonRule = /\.kd-data-center \.kd-button[^{]*\{[^}]*\}/.exec(blankComments(source))?.[0] ?? '';
    expect(buttonRule).toContain('border: 1px solid var(--kd-line-strong)');
    expect(buttonRule).not.toMatch(/border[^;]*var\(--kd-line\)/);
  });

  it('honours prefers-reduced-motion, in the DOM and in the stylesheet', async () => {
    const original = window.matchMedia;
    const listeners: Array<() => void> = [];
    // A live view of the preference, so flipping it is what a browser does when
    // the learner changes the setting.
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
      const { DataCenter } = await loadDataCenter(true);
      await selectLiveRepository(device.repository);
      render(<DataCenter />);
      // Motion allowed: the hook says nothing, and the stylesheet's own media
      // query is the rule that applies.
      expect(dataCenterOf().hasAttribute('data-kd-motion')).toBe(false);

      // The preference changes while the screen is open, which a stylesheet alone
      // would not notice until the next reload.
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

    // ...and both reduced-motion rules are in the stylesheet, so a browser with
    // scripting unavailable is covered too.
    const source = stylesheetSource();
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(source).toContain(".kd-data-center[data-kd-motion='reduced']");
    expect(source.match(/animation: none !important/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/transition: none !important/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('outranks the shell stylesheet it is mounted inside', () => {
    // A real defect, found by measuring the real build in a real browser rather
    // than by reading this file: the shell's stylesheet ends with
    // `:root[data-graphics='rpg'] button`, which is (0,2,1) and therefore beats a
    // plain `.kd-data-center .kd-button` at (0,2,0). Chromium duly painted every
    // Data Center button with the shell's gradient, border and text colour, so
    // the component's own contrast figures were not the ones that shipped.
    //
    // jsdom loads no stylesheet of its own, so it cannot see that collision. What
    // it *can* do is compare the two specificity values, which is the property
    // that decides it - and that comparison is against the real shell file, not
    // against a number written down here.
    // The gate suite's own comment stripper, so a comment in either file cannot
    // be mistaken for a selector - which is exactly the mistake this test would
    // otherwise make on its own documentation.
    const shell = blankComments(readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8'));
    const shellButtonRules = [...shell.matchAll(/([^{}]+)\{/g)]
      .map((match) => (match[1] as string).trim())
      .flatMap((selector) => selector.split(',').map((part) => part.trim()))
      // A rule that names a class, an id, or an attribute somewhere other than
      // the document root can never match the Data Center's markup, so it is not
      // a competitor. An attribute on the root is a condition every button shares:
      // the application sets `data-graphics` on `<html>`.
      .filter((part) => {
        const bare = part.replace(/^(?::root|html)\[[^\]]*\]/, '');
        return !/[.#[]/.test(bare) && /(^|[\s>+~])button\b/.test(bare);
      });
    expect(shellButtonRules.length).toBeGreaterThan(0);
    // Sanity: the rule this test exists for is among them.
    expect(shellButtonRules.map(specificity)).toContain(
      specificity(":root[data-graphics='rpg'] button"),
    );

    const own = blankComments(stylesheetSource());
    const ownControlRules = [...own.matchAll(/([^{}]+)\{/g)]
      .map((match) => (match[1] as string).trim())
      .flatMap((selector) => selector.split(',').map((part) => part.trim()))
      .filter((part) => /(^|[\s>+~,(])\.kd-(button|tab)(?![\w-])/.test(part));
    expect(ownControlRules.length).toBeGreaterThanOrEqual(8);

    for (const part of ownControlRules) {
      // A stateful competitor only competes in its own state: `:hover` cannot
      // outrank a resting declaration, so each rule is measured against the shell
      // rules whose pseudo-class states are a subset of its own.
      const mine = pseudoStates(part);
      const bar = Math.max(
        ...shellButtonRules
          .filter((candidate) => isSubset(pseudoStates(candidate), mine))
          .map((candidate) => specificity(candidate)),
      );
      expect(
        specificity(part),
        `${part} (${specificity(part)}) must beat the shell's ${bar} for the same state`,
      ).toBeGreaterThan(bar);
    }
  });

  it('is committable, which a bare `data/` ignore rule would have silently prevented', () => {
    // `.gitignore` carries a bare `data/` pattern, which in gitignore semantics
    // matches a directory named `data` at *any* depth. Without a negation,
    // `src/ui/data/` is invisible to git: every gate in this file passes, the
    // build ships the component, and the repository has none of the source. The
    // same trap already cost `tests/data/` its tracking once, and the same fix -
    // a `!` negation - is what keeps this deliverable landable.
    const files = [
      'src/ui/data/DataCenter.tsx',
      'src/ui/data/ImportPreview.tsx',
      'src/ui/data/RecoveryStatus.tsx',
      'src/ui/data/dataCenter.css',
    ];
    for (const file of files) {
      expect(existsSync(join(process.cwd(), file)), file).toBe(true);
    }
    // `git check-ignore` exits 0 for an ignored path and 1 for a tracked one, so
    // a non-zero status across the whole list is the assertion.
    const check = spawnSync('git', ['check-ignore', '--quiet', '--', ...files], { cwd: process.cwd() });
    expect(
      check.status,
      'git check-ignore reported the Data Center as ignored. `src/ui/data/` needs a ' +
        '`!src/ui/data/` negation in .gitignore or the deliverable cannot be committed.',
    ).not.toBe(0);
  });

  it('lays out at a 320 CSS-pixel viewport and at 200% zoom', async () => {
    // jsdom has no layout, so this is a property of the stylesheet rather than a
    // measurement: nothing in it fixes a width at or above 320 pixels, every
    // row that holds an identifier can break inside it, and the one media query
    // only reduces padding.
    const source = stylesheetSource();
    const fixedWidths = [...source.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*(\d+)px/g)].map(
      (match) => Number(match[1]),
    );
    for (const width of fixedWidths) {
      expect(width, `a fixed width of ${width}px cannot fit a 320px viewport`).toBeLessThan(320);
    }
    expect(source).toContain('overflow-wrap: anywhere');
    // The grid that holds the counts collapses rather than overflowing.
    expect(source).toContain('minmax(min(100%, 15rem), 1fr)');
    expect(source).toContain('flex-wrap: wrap');
    // The dialog is bounded by the viewport on both axes.
    expect(source).toContain('width: min(34rem, 100%)');
    expect(source).toContain('max-height: calc(100vh - 24px)');
    // 200% zoom of a 1280px window is a 640 CSS-pixel viewport, and the only
    // breakpoint in the file is below that, so both sizes get the stacked layout
    // or the wrapping one - never a fixed one.
    expect(source).toMatch(/@media \(max-width: 30rem\)/);
  });

  it('has no hover-only action, and its own surface is a labelled region', async () => {
    const source = stylesheetSource();
    // `:hover` only ever changes how a control *looks*; no rule reveals or hides
    // content, so nothing a learner has to do is reachable only with a pointer.
    for (const rule of source.match(/[^{}]*:hover[^{]*\{[^}]*\}/g) ?? []) {
      expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:\s*0\b/);
    }
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    const surface = dataCenterOf();
    expect(surface).toHaveAccessibleName('Data Center');
    expect(within(surface).getByRole('tablist', { name: /Data products/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /full device backup/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(surface).getByRole('button', { name: /Inspect a backup file/i })).toBeInTheDocument();
  });
});

// ── 7. The lazy boundary ──────────────────────────────────────────────────

/** The first-party modules under a directory, recursively, sorted. */
function firstPartyModulesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), directory), { withFileTypes: true })) {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...firstPartyModulesUnder(relativePath));
      continue;
    }
    if (/\.(?:ts|tsx|js|jsx|mjs|css)$/.test(entry.name)) found.push(relativePath);
  }
  return found.sort();
}

const STORAGE_V2_PREFIX = 'src/services/persistence/v2/';
const PRODUCTS_PREFIX = 'src/services/persistence/products/';
const CODEC_MODULE = 'src/services/persistence/v2/archive';

/**
 * Every specifier a module names, with the kind of edge each one is.
 *
 * The four forms are the ones a bundler has to resolve, and they are the ones
 * `tests/data/phase5FlagDefault.test.ts` and `tests/migrations/qaHardening.test.ts`
 * each classify for themselves. The comment stripper is the data gate's own, so a
 * module that *mentions* a storage-v2 path in prose is not mistaken for one that
 * imports it - which is the difference between `migrationStateCopy.ts` (prose) and
 * a real seam.
 */
function specifierEdges(
  source: string,
  fromFile: string,
): ReadonlyArray<{ readonly specifier: string; readonly kind: 'static' | 'dynamic' | 'require' }> {
  const code = blankComments(source);
  const edges: Array<{ specifier: string; kind: 'static' | 'dynamic' | 'require' }> = [];
  for (const [pattern, kind] of [
    [/\bfrom\s*['"]([^'"]+)['"]/g, 'static'],
    [/\bimport\s*['"]([^'"]+)['"]/g, 'static'],
    [/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, 'dynamic'],
    [/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, 'require'],
  ] as const) {
    for (const match of code.matchAll(pattern)) edges.push({ specifier: match[1] as string, kind });
  }
  // `import type {...} from '...'` is a static edge for every purpose that matters
  // here: it is a named dependency on a module, and the gates count it as one.
  void fromFile;
  return edges;
}

/** Resolve a first-party specifier the way Vite and the gates do, extensionless. */
function resolveFirstParty(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(join(process.cwd(), 'src'), specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(join(process.cwd(), fromFile)), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toPosix(relative(process.cwd(), candidate)).replace(/\.(ts|tsx)$/, '');
    }
  }
  return null;
}

describe('Phase 5 Data Center: the lazy boundary', () => {
  it('names no storage-v2 module anywhere under src/ui/data/', () => {
    // The invariant, in the gate's own words: only something that is itself a
    // data product may reach into storage-v2, and `STORAGE_V2_SEAMS` in
    // `tests/migrations/qaHardening.test.ts` is the closed list of the files
    // permitted to say otherwise. A screen that reached `repositorySelection`
    // itself would have to be an entry on that list; reaching the product's
    // published accessor means no UI file is on it at all.
    const files = firstPartyModulesUnder('src/ui/data');
    expect(files).toEqual([
      'src/ui/data/DataCenter.tsx',
      'src/ui/data/ImportPreview.tsx',
      'src/ui/data/RecoveryStatus.tsx',
      'src/ui/data/dataCenter.css',
    ]);
    const offenders: string[] = [];
    for (const file of files) {
      for (const edge of specifierEdges(readFileSync(join(process.cwd(), file), 'utf8'), file)) {
        const target = resolveFirstParty(file, edge.specifier);
        if (target !== null && target.startsWith(STORAGE_V2_PREFIX)) {
          offenders.push(`${file} ${edge.kind} ${edge.specifier}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('tells a mention in prose from an import, so the assertion above is about imports', () => {
    // `src/ui/components/migrationStateCopy.ts` names two storage-v2 paths, and it
    // is a Phase 4 file this deliverable must not edit. Both mentions are inside
    // its header comment, and the comment says why they are transcribed rather
    // than imported: "the Phase 4 seam allowlist permits exactly one module outside
    // the storage-v2 tree to name it and the surface must not be that module".
    // Proving that here means the scan above is measuring imports, not text.
    const file = 'src/ui/components/migrationStateCopy.ts';
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    // Written without the `src/` prefix, as prose in a header comment.
    expect(source).toContain('services/persistence/v2/');
    expect(source.split('\n').filter((line) => line.includes('services/persistence/v2/')).every((line) =>
      /^\s*(\*|\/\/|\/\*)/.test(line),
    )).toBe(true);
    // It does import one thing - the application's published contract, which is
    // the right direction for a surface to depend on - and it is not a storage-v2
    // module. So the claim to check is that no *edge* of that file points into
    // storage-v2, which is exactly what the directory scan above asserts.
    const edges = specifierEdges(source, file);
    expect(
      edges.filter((edge) => (resolveFirstParty(file, edge.specifier) ?? '').startsWith(STORAGE_V2_PREFIX)),
    ).toEqual([]);
    expect(edges.map((edge) => edge.specifier)).toEqual(['@/application/bootstrap']);
  });

  it('reaches the product only through a lazy edge, which keeps the ZIP codec off the eager path', () => {
    // Non-vacuity first: the classifier has to be able to tell the two apart, or
    // "no eager edge" could be satisfied by a detector that matches nothing.
    const synthetic = [
      "import { writeArchive } from '@/services/persistence/products/fullDeviceBackup';",
      'const product = await import("@/services/persistence/products/fullDeviceBackup");',
      "const alsoLazy = await import('@/services/persistence/products/archiveValidation');",
    ].join('\n');
    const kinds = specifierEdges(synthetic, 'src/ui/data/DataCenter.tsx').map((edge) => edge.kind);
    expect(kinds).toEqual(['static', 'dynamic', 'dynamic']);

    // The real file, over the real import graph from the real entry module.
    const paths = walk().modules.map((module) => module.path);
    expect(paths).toContain('src/ui/data/DataCenter.tsx');

    const productEdges = specifierEdges(
      readFileSync(join(process.cwd(), 'src/ui/data/DataCenter.tsx'), 'utf8'),
      'src/ui/data/DataCenter.tsx',
    ).filter((edge) => (edge.specifier.startsWith('@/') ? edge.specifier : edge.specifier).includes('/products/'));
    expect(productEdges.length).toBeGreaterThanOrEqual(3);
    for (const edge of productEdges) {
      expect(edge.kind, `${edge.specifier} must be a lazy edge`).toBe('dynamic');
    }

    // The consequence that matters, stated over the whole graph rather than over
    // one file: nothing outside the product tree may reach the archive codec
    // eagerly, because the codec is only useful to a product and its presence in
    // an entry chunk would give a build with the flag off a ZIP writer it has no
    // reason to contain.
    const eagerCodecImporters: string[] = [];
    for (const path of paths) {
      if (path.startsWith(PRODUCTS_PREFIX)) continue;
      for (const edge of specifierEdges(readFileSync(join(process.cwd(), path), 'utf8'), path)) {
        if (edge.kind === 'dynamic') continue;
        if (resolveFirstParty(path, edge.specifier) === CODEC_MODULE) eagerCodecImporters.push(path);
      }
    }
    expect(eagerCodecImporters, eagerCodecImporters.join('\n')).toEqual([]);
    // ...and the codec is only reachable at all because the product is, which is
    // the boundary this file exists to keep: present in the graph, absent from
    // the eager path.
    expect(paths).toContain('src/services/persistence/products/fullDeviceBackup.ts');
    expect(paths).toContain('src/services/persistence/products/archiveValidation.ts');
  });
});

// ── 8. The ports cannot drift from the product ────────────────────────────

describe('Phase 5 Data Center: the declared ports still match the product', () => {
  it('a real preview and a real result satisfy the shapes the surfaces render', async () => {
    const archive = await realArchive(device);
    const inspection = validation.inspectFullDeviceArchive(archive);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    const result = await product.importFullDeviceBackup({
      repository: target.repository,
      bytes: archive,
      now: '2026-09-26T13:00:00.000Z',
      keepPreviousGeneration: true,
    });

    // These two assignments are the drift check. They are compile-time: if the
    // product renames a field this surface renders, or changes its type, `tsc`
    // fails here rather than the surface quietly rendering `undefined`. If the
    // product *adds* a field, this still compiles and the surface still does not
    // render it, which is the direction that is safe.
    const preview: BackupPreview = inspection.preview;
    const report: RestoreSuccessReport = result;
    expect(preview.formatVersion).toBe(inspection.preview.formatVersion);
    expect(report.activated).toBe(result.activated);
    // The fields the surfaces are forbidden from rendering are the ones the
    // product documents as absent, and the test says so out loud.
    expect(JSON.stringify(preview)).not.toContain('http');
    expect(JSON.stringify(preview)).not.toMatch(/subjectName|topic|noteText|fileName|externalUrl/);
  });
});
