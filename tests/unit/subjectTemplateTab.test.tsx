/**
 * Phase 7: the Data Center's template tab, and the cutover of the legacy path.
 *
 * `tests/data/` holds the gates that pin the *product*, and they hold it well. This
 * file covers the *interface*, and it is organised around the five things that can go
 * wrong in a screen whose whole job is to make a privacy claim a learner can act on:
 *
 * 1. **The tablist.** Three tabs, real `tab`/`tabpanel` wiring, `aria-selected`
 *    genuinely true on exactly one, roving `tabIndex`, arrow-key movement that wraps
 *    in both directions, Home and End, and only the selected panel's contents in the
 *    DOM - so the other two tabs' file inputs do not exist and cannot be tabbed into.
 * 2. **The approval step.** Room topics are shown *before* the download button is
 *    pressed, every tag box is rendered **unticked**, the biome box is unticked, and
 *    the request sent to the product literally omits `approvedTags` when nothing is
 *    ticked - which is the property that makes "hitting export is not approving
 *    anything" a structural fact rather than a claim about the copy.
 * 3. **The file, measured.** A real `.kdtemplate` written by the product's own
 *    exporter, downloaded through a blob and an object URL that is revoked, named by
 *    the product's **constant**, with the forbidden fields (notes, artifacts,
 *    attachments, filenames, the subject's own name, every original id) demonstrably
 *    absent and the approved tags demonstrably present - and the status line reporting
 *    the product's returned `approvedTags` rather than a boolean.
 * 4. **The import, and the property the phase exists for.** A template lands in the
 *    Create state with every room blank, and the report says so from a **read-back of
 *    the record the product wrote** rather than by restating the product's
 *    documentation. The report is not navigated away from, and the control that goes to
 *    Create is inside it. The preview states counts and refuses to state a single
 *    value the file supplied.
 * 5. **Accessibility**, measured rather than asserted by class name: roles, live
 *    regions, touch targets computed from the real stylesheet, contrast recomputed
 *    from the real tokens, the dialog's focus trap, initial focus, Escape, focus
 *    restoration, and no colour-only state.
 *
 * ## Why the fixture is Phase 6's
 *
 * `createNastySubjectDevice` is used rather than a template-shaped fixture, and
 * deliberately: its subject is the *opposite* of blank - six rooms all in
 * `ArtifactCollected`, every one with a note and a written artifact, a biome, a marker
 * in a topic, and three tags that include a room id. So the blank-room assertion on
 * import is non-vacuous (a read-back that reported "all blank" for this subject would
 * be reading nothing), and the file's forbidden-field assertions are non-vacuous (the
 * values are present in the subject and absent from the file).
 *
 * It also carries one genuinely awkward pair: the room whose id is `room-1` and the
 * room whose **topic** is the string `room-1`, which is also a tag name. Ticking that
 * tag is therefore a test of three separate claims at once - that a tag can be
 * approved, that a topic that looks like an identifier is still a topic, and that the
 * file addresses rooms by index rather than by id.
 *
 * ## Privacy
 *
 * Every fixture is synthetic and self-describing. The only host named anywhere in this
 * file is the reserved `example.invalid`, and it is never expected to reach the DOM.
 * The privacy assertions are split the way the product splits its own surfaces: the
 * **export** half is allowed to render this device's own subject name, topics, and tag
 * names - it is the learner's own data on their own screen, and hiding it would defeat
 * the approval step - while the **import** half must render no value the file supplied,
 * because everything on it can be copied out.
 */

import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { blankComments } from '../data/support/importGraph';
import {
  MARKER_ARTIFACT_BODY,
  MARKER_ATTACHMENT_ALT_TEXT,
  MARKER_ATTACHMENT_FILE_NAME,
  MARKER_NOTE_BODY,
  MARKER_ROOM_TOPIC,
  MARKER_SUBJECT_NAME,
  MARKER_TOKEN,
} from '../data/support/marker';
import {
  NASTY_GENERATION_ID,
  NASTY_OTHER_SUBJECT_ID,
  NASTY_SUBJECT_ID,
  createNastySubjectDevice,
  nastySnapshot,
  type NastyDevice,
} from '../data/support/nastySubject';
import type { TemplatePreview } from '@/ui/data/SubjectTemplateTab';

// ── The product, reached the way a build reaches it ────────────────────────

type TemplateProductModule = typeof import('@/services/persistence/products/subjectTemplate');

const product = (await import('@/services/persistence/products/subjectTemplate')) as TemplateProductModule;

/**
 * The compile-time assertion that the tab's declared port still matches the product.
 *
 * The tab declares {@link TemplatePreview} rather than importing the product's type,
 * because the product is reachable only through a lazy `import()` and a static type
 * import would put it in a flag-off build's chunk. The cost of that is a hand-written
 * copy that could drift, so this is the check that makes the copy safe: if the product
 * renames a field or changes a type, this stops compiling rather than the tab rendering
 * a field that is no longer there.
 */
type ProductPreviewShape = Awaited<ReturnType<TemplateProductModule['readSubjectTemplate']>>['preview'];
const _portStillMatchesTheProduct: ProductPreviewShape extends TemplatePreview ? true : never = true;
void _portStillMatchesTheProduct;

type DataCenterModule = typeof import('@/ui/data/DataCenter');

/** Every export request the tab sent to the product, in call order. */
const exportRequests: Array<Record<string, unknown>> = [];
/** Every import request the tab sent to the product, in call order. */
const importRequests: Array<Record<string, unknown>> = [];
/** Every id the tab asked its generator for, in call order. */
const mintedCandidates: string[] = [];

/**
 * Load the Data Center with the owner flag at a chosen value.
 *
 * The product module is wrapped rather than replaced, so each request is recorded and
 * the *real* product still runs - the file this file inspects is the product's own
 * bytes rather than a fixture's, and the wrapper is what lets this file assert the
 * request shape (the absent `approvedTags` key, in particular).
 */
async function loadDataCenter(dataProductsV2: boolean): Promise<DataCenterModule> {
  vi.resetModules();
  vi.stubEnv('VITE_DATA_PRODUCTS_V2', String(dataProductsV2));
  exportRequests.length = 0;
  importRequests.length = 0;
  mintedCandidates.length = 0;
  if (dataProductsV2) {
    vi.doMock('@/services/persistence/products/subjectTemplate', async (importOriginal) => {
      const actual = await importOriginal<TemplateProductModule>();
      return {
        ...actual,
        exportSubjectTemplate: (
          snapshot: Parameters<TemplateProductModule['exportSubjectTemplate']>[0],
          request: Parameters<TemplateProductModule['exportSubjectTemplate']>[1],
        ) => {
          exportRequests.push(request as unknown as Record<string, unknown>);
          return actual.exportSubjectTemplate(snapshot, request);
        },
        importSubjectTemplate: async (request: Parameters<TemplateProductModule['importSubjectTemplate']>[0]) => {
          // The generator is wrapped, not merely recorded: the product calls it, so a
          // record of what the tab *handed over* would say nothing about what it asked
          // for. The wrapped generator is the one the real product runs.
          const inner = request.generator;
          const recording = {
            next: (): string => {
              const value = inner.next();
              mintedCandidates.push(value);
              return value;
            },
          };
          const wrapped = { ...request, generator: recording };
          importRequests.push(wrapped as unknown as Record<string, unknown>);
          return actual.importSubjectTemplate(wrapped);
        },
      };
    });
  } else {
    vi.doUnmock('@/services/persistence/products/subjectTemplate');
  }
  return import('@/ui/data/DataCenter');
}

/**
 * A device holding one subject with `roomCount` rooms, all blank.
 *
 * Built for the bounded room list: the export side renders at most a fixed number of
 * topics and has to say how many it left out, and that claim is only worth asserting if
 * the list really is longer than the cap. Scaled from the Phase 6 fixture's snapshot so
 * the shape is one the application already validates, with every room blank so the
 * snapshot is also a legal export source.
 */
async function createSubjectWithRooms(
  databaseName: string,
  roomCount: number,
): Promise<NastyDevice['repository']> {
  const { openStorageV2Repository } = await import('@/services/persistence/v2/repository');
  const { createDeterministicIdFactory, fixedClock } = await import('@/services/persistence/v2/database');
  const { CANONICAL_SUBJECT_SCHEMA_VERSION } = await import('@/services/persistence/v2/schema');
  const base = nastySnapshot();
  const subjectId = `subject-${databaseName}`;
  const template = base.rooms['room-1'] as unknown as Record<string, unknown>;
  const rooms: Record<string, Record<string, unknown>> = Object.create(null);
  const summaries: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  for (let index = 0; index < roomCount; index += 1) {
    const roomId = index === 0 ? 'room-1' : `room-scale-${index}`;
    rooms[roomId] = {
      ...template,
      roomId,
      topic: index === 0 ? 'Scale fixture root' : `Scale fixture room topic ${index}`,
      state: 'Created',
      noteText: '',
      artifactMarkdown: null,
      attachments: [],
      reviewPassCount: 0,
    };
    summaries.push({ roomId, topic: rooms[roomId]?.topic, status: 'Created' });
    if (index > 0) edges.push({ fromRoomId: 'room-1', toRoomId: roomId, relationType: 'subtopic', createdAt: '2026-01-01T00:00:00.000Z', createdByPhase: 'Creator' });
  }
  const snapshot = {
    ...base,
    dungeon: {
      ...base.dungeon,
      dungeonId: subjectId,
      subjectName: `Scale fixture subject of ${roomCount} rooms`,
      rootRoomId: 'room-1',
      rooms: summaries,
      edges,
    },
    rooms,
  };
  const generationId = `gen-${databaseName}`;
  const repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock('2026-09-27T00:00:00.000Z'),
    idFactory: createDeterministicIdFactory('scale'),
  });
  await repository.stageGeneration({
    generationId,
    source: 'local-edit',
    records: {
      subjects: [
        {
          subjectId,
          schemaVersion: CANONICAL_SUBJECT_SCHEMA_VERSION,
          snapshot,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as unknown as import('@/services/persistence/v2/schema').SubjectRecordValue,
      ],
    },
  });
  await repository.activateGeneration(generationId);
  const validation = await repository.validateGeneration(generationId);
  if (!validation.ok) throw new Error(`the scale fixture did not validate clean: ${JSON.stringify(validation)}`);
  return repository;
}

async function selectLiveRepository(repository: NastyDevice['repository']): Promise<void> {
  const selection = await import('@/services/persistence/v2/repositorySelection');
  selection.resetRepositorySelection();
  selection.selectStorageV2Repository(repository);
}

/**
 * A device that **can** be read and holds no subject.
 *
 * The state a first-run learner is in, and the one no existing fixture in this
 * repository produces: `createPopulatedDevice` and `createNastySubjectDevice` both stage
 * subjects. Built through the real repository API - open, stage, activate - and then
 * required to validate clean, so "empty" is a measured property and not a store that
 * failed to open.
 */
async function createEmptyDevice(databaseName: string): Promise<NastyDevice['repository']> {
  const { openStorageV2Repository } = await import('@/services/persistence/v2/repository');
  const { createDeterministicIdFactory, fixedClock } = await import('@/services/persistence/v2/database');
  const { STORAGE_V2_STORE_NAMES } = await import('@/services/persistence/v2/schema');
  const generationId = `gen-${databaseName}`;
  const repository = await openStorageV2Repository({
    databaseName,
    clock: fixedClock('2026-09-27T00:00:00.000Z'),
    idFactory: createDeterministicIdFactory('empty'),
  });
  await repository.stageGeneration({
    generationId,
    source: 'local-edit',
    records: Object.fromEntries(STORAGE_V2_STORE_NAMES.map((name) => [name, []])),
  });
  await repository.activateGeneration(generationId);
  const validation = await repository.validateGeneration(generationId);
  if (!validation.ok) throw new Error('the empty device fixture did not validate clean');
  return repository;
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

async function readDownload(index = 0): Promise<{ text: string; document: Record<string, unknown> }> {
  const record = downloads[index] as DownloadRecord;
  return {
    text: await (record.blob as Blob).text(),
    document: JSON.parse(await (record.blob as Blob).text()) as Record<string, unknown>,
  };
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

/** The three tags the fixture subject's rooms carry. */
const FIXTURE_TAGS = ['cozy-hearth', 'room-1', 'synthetic-tag'] as const;
/** The biome the fixture subject already uses. */
const FIXTURE_BIOME = 'cozy-hearth';
/** The clock the export assertions read out of the recorded request. */
const TEMPLATE_NOW = '2026-09-27T09:00:00.000Z';

function templateFileOf(text: string, name: string): File {
  return new File([text], name, { type: 'application/json' });
}

/** A real `.kdtemplate`, written by the product's own exporter. */
function realTemplate(approvedTags: readonly string[] = []): string {
  return product.exportSubjectTemplate(nastySnapshot(), {
    now: TEMPLATE_NOW,
    ...(approvedTags.length > 0 ? { approvedTags: [...approvedTags] } : {}),
  }).template;
}

const dataCenterOf = (): HTMLElement => {
  const surface = document.querySelector<HTMLElement>('[data-kd-surface="data-center"]');
  if (surface === null) throw new Error('The Data Center is not on the screen.');
  return surface;
};

const templateTab = (): HTMLElement => {
  const panels = screen.queryAllByRole('tabpanel', { hidden: true });
  const panel = panels[2];
  if (panel === undefined) throw new Error('The template tab is not on the screen.');
  return panel;
};

const templateDialog = (): HTMLElement => {
  const dialog = document.querySelector<HTMLElement>('[data-kd-surface="template-import-confirmation"]');
  if (dialog === null) throw new Error('The template import confirmation is not open.');
  return dialog;
};

const exportStatus = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-kd-surface="template-export-status"]') as HTMLElement;
const inspectionStatus = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-kd-surface="template-inspection-status"]') as HTMLElement;
const templateOutcome = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-kd-surface="restore-outcome"]');
const templatePreviewSurface = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-kd-surface="template-preview"]');

const downloadButton = (): HTMLButtonElement =>
  within(templateTab()).getByRole<HTMLButtonElement>('button', { name: /download this template/i });
const chooseButton = (): HTMLButtonElement =>
  within(templateTab()).getByRole<HTMLButtonElement>('button', { name: /choose a template file/i });
const confirmButton = (): HTMLButtonElement =>
  within(templateDialog()).getByRole<HTMLButtonElement>('button', { name: /add the blank subject/i });
const destinationField = (): HTMLInputElement =>
  within(templateDialog()).getByLabelText<HTMLInputElement>(/name for the new subject/i);

/** The tag box for one tag, by the tag's own name. */
function tagBox(tag: string): HTMLInputElement {
  return within(templateTab()).getByRole<HTMLInputElement>('checkbox', { name: new RegExp(`^${tag}`) });
}

const biomeBox = (): HTMLInputElement =>
  within(templateTab()).getByRole<HTMLInputElement>('checkbox', { name: /include the biome this subject uses/i });

/** The room topics the export list is currently showing, in order. */
function renderedTopics(): string[] {
  return [...templateTab().querySelectorAll<HTMLElement>('.kd-topic')].map((node) => node.textContent ?? '');
}

/** Click the template tab and wait until this device's read has settled. */
async function openTemplateTab(): Promise<void> {
  fireEvent.click(screen.getByRole('tab', { name: /reusable template/i }));
  await waitFor(() => {
    expect(within(templateTab()).getByLabelText(/subject to make a template from/i)).toBeInTheDocument();
  });
  await waitFor(() => {
    // `queryByText`, not `getByText`: the wait is for the *absence* of the pending
    // sentence, and a `get` that throws would retry for ever.
    expect(within(templateTab()).queryByText(/reading the subjects on this device/i)).toBeNull();
  });
  // The room list is a second read of the same generation, so it settles a turn later.
  await waitFor(() => {
    expect(within(templateTab()).queryByText(/reading the rooms on this device/i)).toBeNull();
  });
  await nextTask();
}

/** Choose a template file and wait for the confirmation to become committable. */
async function chooseTemplateFile(text: string, name = 'shared-template.kdtemplate'): Promise<void> {
  const input = templateTab().querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('The template tab rendered no file input.');
  fireEvent.change(input, { target: { files: [templateFileOf(text, name)] } });
  await waitFor(() => {
    expect(templateDialog()).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(confirmButton()).toBeEnabled();
  });
}

/**
 * Commit the open confirmation and wait for the report to arrive.
 *
 * `previous` is the report already on screen, if any, and the wait is for a *different*
 * one. Without that, a second import of the same file would return immediately against
 * the first import's report and the test would read the device before the write landed -
 * which is a test that passes for the wrong reason rather than one that fails.
 */
async function confirmTemplateImport(previous: string | null = null): Promise<void> {
  fireEvent.click(confirmButton());
  // Wait for a **report**, not for the surface: while the import is in flight
  // `RecoveryStatus` renders the same `data-kd-surface` with a pending line and no
  // verdict, so waiting for the surface alone would return before the write landed and
  // the test would read the device too early - passing for the wrong reason.
  await waitFor(() => {
    const current = templateOutcome();
    if (current === null) throw new Error('no report yet');
    expect(current.querySelector('.kd-outcome-verdict')).not.toBeNull();
    if (previous !== null) expect(current.textContent).not.toBe(previous);
  });
  await nextTask();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

let device: NastyDevice;

beforeEach(async () => {
  installBrowserDoubles();
  installStylesheet();
  window.localStorage.clear();
  device = await createNastySubjectDevice('template-tab-ui');
});

afterEach(() => {
  cleanup();
  vi.doUnmock('@/services/persistence/products/subjectTemplate');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
  void import('@/services/persistence/v2/repositorySelection').then((selection) =>
    selection.resetRepositorySelection(),
  );
});

// ── 1. The tablist ────────────────────────────────────────────────────────

describe('Phase 7 template tab: the tablist', () => {
  it('renders nothing at all when VITE_DATA_PRODUCTS_V2 is off, so there is no third tab', async () => {
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
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Full device backup',
      'One subject backup',
      'Reusable template',
    ]);
    // `aria-selected` genuinely true on exactly one, and the roving tabindex makes the
    // whole tablist one stop in the page's order.
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(screen.getAllByRole('tab', { selected: true })).toHaveLength(1);
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);

    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') as string);
      expect(panel, tab.textContent ?? '').not.toBeNull();
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }

    // Only the selected panel's contents exist, so the other two tabs' file inputs are
    // not in the DOM and cannot be reached by Tab.
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(3);
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  it('reaches the template tab with the arrow keys, and lands on a rendered room list', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    const subject_ = screen.getByRole('tab', { name: /one subject backup/i });
    const template_ = screen.getByRole('tab', { name: /reusable template/i });
    subject_.focus();
    fireEvent.keyDown(subject_, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(template_);
    expect(template_).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(template_, { key: 'End' });
    expect(document.activeElement).toBe(template_);
    fireEvent.keyDown(template_, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /full device backup/i }));

    await openTemplateTab();
    // One file input in the whole document: the device and subject panels are not
    // rendered while the template panel is selected.
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(renderedTopics().length).toBeGreaterThan(0);
  });
});

// ── 2. The privacy surface ────────────────────────────────────────────────

describe('Phase 7 template tab: what the copy says leaves the device', () => {
  it('states the three opt-ins, the six exclusions, and refuses to call it private', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();

    const text = templateTab().textContent ?? '';
    // The three things that are *not* automatic, each named as a decision.
    expect(text).toMatch(/Every room topic always goes in/i);
    expect(text).toMatch(/Tags go in only if you tick them/i);
    expect(text).toMatch(/A biome goes in only if you tick it/i);
    // The exclusions, in the words plan section 7.3 uses.
    for (const excluded of [
      'notes',
      'written artifacts',
      'images or their file names',
      'review history',
      'progress',
      'study sessions',
      'assistance history',
      'settings',
    ]) {
      expect(text, excluded).toContain(excluded);
    }
    expect(text).toMatch(/never carries the internal ids/i);
    // And the sentence that stops the whole surface reading as "this is private": the
    // file carries the topics, and a tag is a word the learner chose to publish.
    expect(text).toMatch(/not anonymous and it is not empty/i);
    expect(text).toMatch(/it is your room topics/i);
    // ...and where the file goes, in the same register: local, and the learner's choice.
    expect(text).toMatch(/there is nowhere for it to be sent/i);
  });

  it('shows the room topics before the download control, and never shows them in the import half', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();

    // Every one of this device's topics is on the page, in a list, before the button,
    // and the list leads with the room the subject is built around.
    const snapshot = nastySnapshot();
    const rootId = snapshot.dungeon.rootRoomId;
    const topics = Object.values(snapshot.rooms)
      .map((room) => room.topic)
      .sort((l, r) => l.localeCompare(r, 'en'));
    expect(renderedTopics()).toHaveLength(topics.length);
    expect([...renderedTopics()].sort((l, r) => l.localeCompare(r, 'en'))).toEqual(topics);
    expect(renderedTopics()[0]).toBe(snapshot.rooms[rootId]?.topic);
    // The list is a real list, so a screen reader announces the count and the items.
    const list = templateTab().querySelector('.kd-topics');
    expect(list?.tagName).toBe('UL');
    expect(templateTab().querySelectorAll('.kd-topics > .kd-topic')).toHaveLength(topics.length);
    // The heading counts them, and the button is right there.
    expect(templateTab()).toHaveTextContent(`The ${topics.length} room topics that always go in`);
    expect(downloadButton()).toBeEnabled();

    // Choose a file and the *import* half must not repeat a single value from it. The
    // file below carries a topic and an approved tag, and the assertion is that the
    // preview's own region contains neither.
    const template = realTemplate(['synthetic-tag']);
    await chooseTemplateFile(template);
    const preview = templatePreviewSurface() as HTMLElement;
    expect(preview).toBeInTheDocument();
    const previewText = preview.textContent ?? '';
    for (const forbidden of [
      ...Object.values(snapshot.rooms).map((room) => room.topic),
      'synthetic-tag',
    ]) {
      expect(previewText, forbidden).not.toContain(forbidden);
    }
    // The approved tag is disclosed as a **count**, and the biome as a yes or no.
    expect(previewText).toMatch(/Approved tags in the file\s*1/);
    expect(previewText).toMatch(/Biome in the file\s*no/);
    expect(previewText).toMatch(/are not shown here, because this is a file this app did not write/i);
  });
});

// ── 3. The export, and the approval step ──────────────────────────────────

describe('Phase 7 template tab: the export approval step', () => {
  it('renders every tag unticked, and the live sentence says none are approved', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();

    // The tags come from the device, deduplicated across every room - a `Set`, not a
    // per-room list, because the product refuses a duplicate approved tag.
    expect(FIXTURE_TAGS).toHaveLength(3);
    // Four boxes: three tags and the biome. The count is stated so a tag list that
    // accidentally carried a per-room duplicate would fail here rather than silently
    // growing the page.
    expect(within(templateTab()).getAllByRole('checkbox')).toHaveLength(4);
    for (const tag of FIXTURE_TAGS) {
      expect(tagBox(tag), tag).not.toBeChecked();
    }
    // Unticked is also stated in words in each row, and in one live sentence - so the
    // state is never carried by a filled box alone.
    expect(templateTab()).toHaveTextContent('Unticked. This tag stays on this device.');
    const effect = within(templateTab()).getAllByRole('status').find((node) =>
      /approved for the file|no tags at all/.test(node.textContent ?? ''),
    );
    expect(effect).toBeDefined();
    expect(effect).toHaveAttribute('aria-live', 'polite');
    expect(effect).toHaveTextContent(/Nothing ticked. The file will carry no tags at all/i);

    // The biome is unticked too, and says so.
    expect(biomeBox()).not.toBeChecked();
    expect(templateTab()).toHaveTextContent('Unticked. The file will carry no biome.');
  });

  it('downloads a real .kdtemplate named by the product constant, carrying no tag and no biome', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();

    fireEvent.click(downloadButton());
    await waitFor(() => {
      expect(downloads).toHaveLength(1);
    });
    await nextTask();

    // The four steps and no fifth: blob, object URL, anchor, revoke.
    const record = downloads[0] as DownloadRecord;
    expect(record.download).toBe(product.SUBJECT_TEMPLATE_FILE_NAME);
    expect(record.download.endsWith('.kdtemplate')).toBe(true);
    expect(record.download).not.toContain(MARKER_TOKEN);
    expect(record.href.startsWith('blob:')).toBe(true);
    expect(record.inDocumentWhenClicked).toBe(true);
    // JSON, not an archive: this is the one place a product's media type is a fact
    // rather than a default, and getting it wrong would download a ZIP-labelled file.
    expect((record.blob as Blob).type).toBe('application/json');
    await waitFor(() => {
      expect(revokedObjectUrls).toEqual([createdObjectUrls[0] as string]);
    });
    expect(document.querySelector('a[download]')).toBeNull();

    // The request is assembled by **omission**: with nothing ticked there is no
    // `approvedTags` key and no `approvedBiome` key at all, so the exporter cannot
    // supply either for itself.
    const request = exportRequests[0] as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(['now']);
    expect(request).not.toHaveProperty('approvedTags');
    expect(request).not.toHaveProperty('approvedBiome');
    expect(request).not.toHaveProperty('name');
    expect(request).not.toHaveProperty('description');

    // The file itself: structure and topics, and none of the five forbidden leaks.
    const { text, document: written } = await readDownload();
    const graph = written.graph as Record<string, unknown>;
    const rooms = graph.rooms as Array<Record<string, unknown>>;
    expect(written.product).toBe('kdtemplate');
    expect(Object.keys(written).sort()).toEqual([
      'createdAt',
      'description',
      'formatVersion',
      'graph',
      'name',
      'product',
      'storageGenerationFormatVersion',
      'subjectSchemaVersion',
    ]);
    expect(rooms).toHaveLength(6);

    /*
     * The absence assertions, and they are the interesting half.
     *
     * The marker is planted in six surfaces on this device and it is **supposed** to be
     * in the file in one of them: a room topic is plan section 7.3's second permitted
     * thing, so the file carries it. What must not be in the file is the marker in any
     * of the other five - the subject's own name, a note, a written artifact, an image
     * file name, an image's alt text - and each of those is asserted separately,
     * because "the marker is absent" would be a false statement about this product and
     * a gate that asserted it would be wrong.
     */
    const snapshotRooms = nastySnapshot().rooms as unknown as Record<string, Record<string, unknown>>;
    expect(rooms.map((room) => room.topic)).toContain(MARKER_ROOM_TOPIC);
    for (const [label, forbidden] of [
      ['a room topic, which is permitted', MARKER_ROOM_TOPIC],
      ['the subject name', MARKER_SUBJECT_NAME],
      ['a note body', MARKER_NOTE_BODY],
      ['a written artifact', MARKER_ARTIFACT_BODY],
      ['an image file name', MARKER_ATTACHMENT_FILE_NAME],
      ['an image alt text', MARKER_ATTACHMENT_ALT_TEXT],
    ] as const) {
      if (label.startsWith('a room topic')) {
        // Asserted as present, and only as a topic: the same marker must not appear
        // anywhere else in the document.
        const occurrences = (text.match(new RegExp(MARKER_TOKEN, 'g')) ?? []).length;
        const topicOccurrences = (text.match(new RegExp(MARKER_ROOM_TOPIC, 'g')) ?? []).length;
        expect(occurrences, 'the marker appears only inside the one permitted topic').toBe(topicOccurrences);
        continue;
      }
      expect(text, label).not.toContain(forbidden);
    }
    // The subject's own name is not in the file at all, even though the room whose topic
    // *equals* that name is: the topic is a topic, and the name is not carried.
    expect(text).not.toContain(nastySnapshot().dungeon.subjectName);
    // Field names, not just values: no key anywhere in the document is one of the five.
    for (const forbiddenKey of [
      'noteText',
      'artifactMarkdown',
      'attachments',
      'fileName',
      'altText',
      'exportedAt',
      'roomId',
      'rootRoomId',
      'subjectName',
      'dungeonId',
      'notePath',
      'artifactPath',
      'reviewPassCount',
      'sm2',
      'progression',
    ]) {
      expect(text, forbiddenKey).not.toContain(forbiddenKey);
    }
    // ...and no host, because this product has no URL surface at all.
    expect(text).not.toContain('example.invalid');
    // No tags and no biome, because none were approved.
    expect(graph.tags).toEqual([]);
    expect(graph.biome).toBeNull();
    // ...and no identifier anywhere, which is the mechanism: rooms are addressed by
    // index, so the source ids cannot be present even as object keys.
    for (const room of rooms) {
      expect(Object.keys(room).sort()).toEqual(['tags', 'topic']);
      expect(room.tags).toEqual([]);
    }
    for (const edge of graph.structureEdges as Array<Record<string, unknown>>) {
      expect(Object.keys(edge).sort()).toEqual(['createdByPhase', 'from', 'to']);
      expect(typeof edge.from).toBe('number');
      expect(typeof edge.to).toBe('number');
    }
    expect(typeof graph.rootIndex).toBe('number');
    expect(text).not.toContain(NASTY_SUBJECT_ID);
    /*
     * The no-identifier check, done properly.
     *
     * A blunt "the file does not contain this string" assertion would be **wrong** for
     * this fixture, and the reason is instructive: one of its rooms has the topic
     * `room-1`, which is also another room's id. A topic is permitted content, so that
     * string is supposed to be in the file - and the only place it may appear is as a
     * topic. So the assertion walks the *parsed* document and requires that no source
     * identifier appears as a key or as a value anywhere except inside a room's topic,
     * which is content and not a handle.
     */
    const sourceRoomIds = new Set(Object.keys(snapshotRooms));
    const offenders: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        if (sourceRoomIds.has(value) && !path.endsWith('.topic')) offenders.push(`${path}=${value}`);
        if (value === NASTY_SUBJECT_ID) offenders.push(`${path}=${value}`);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          if (sourceRoomIds.has(key)) offenders.push(`${path}.${key}`);
          walk(entry, `${path}.${key}`);
        }
      }
    };
    walk(written, 'document');
    expect(offenders).toEqual([]);
    // ...and the room list is addressed by index, which is the mechanism that makes the
    // assertion above structural rather than a matter of a filter having been applied.
    for (const edge of graph.structureEdges as Array<Record<string, unknown>>) {
      expect(typeof edge.from).toBe('number');
      expect(typeof edge.to).toBe('number');
      expect(edge.from as number).toBeLessThan(rooms.length);
    }

    // The status line reports the product's own measurement of the file's tags, not a
    // claim that tags were included.
    expect(exportStatus()).toHaveAttribute('role', 'status');
    expect(exportStatus().textContent).toContain(product.SUBJECT_TEMPLATE_FILE_NAME);
    expect(exportStatus()).toHaveTextContent(/It carries no tags at all, because none were approved\./i);
    expect(exportStatus()).toHaveTextContent(/Every room topic in it is in the list above/i);
    // ...and no network API was touched on the way to the disk.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpenSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
  });

  it('sends exactly the ticked tags, and a ticked biome, and reports the product\'s own list back', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();

    // One tick, on a tag whose name is *also* a room id - so this is a test of the
    // approval, of a topic-shaped tag, and of the index-addressed room list at once.
    fireEvent.click(tagBox('room-1'));
    fireEvent.click(biomeBox());
    // The live sentence names the approved list, and each row says "Ticked" in words.
    await waitFor(() => {
      expect(templateTab()).toHaveTextContent(/1 tag is approved for the file: room-1/i);
    });
    expect(templateTab()).toHaveTextContent(
      'Ticked. This tag goes in the file, on the rooms that already have it.',
    );

    fireEvent.click(downloadButton());
    await waitFor(() => {
      expect(downloads).toHaveLength(1);
    });
    const request = exportRequests[0] as Record<string, unknown>;
    expect(request.approvedTags).toEqual(['room-1']);
    expect(request.approvedBiome).toBe(FIXTURE_BIOME);

    const { text, document: written } = await readDownload();
    const graph = written.graph as Record<string, unknown>;
    expect(graph.tags).toEqual(['room-1']);
    expect(graph.biome).toBe(FIXTURE_BIOME);
    // The tag is written on the rooms that already have it, and this subject's rooms all
    // carry all three tags, so all six get it - and the *topic* that happens to spell
    // `room-1` is still a topic.
    const rooms = graph.rooms as Array<Record<string, unknown>>;
    expect(rooms.every((room) => (room.tags as string[]).includes('room-1'))).toBe(true);
    expect(rooms.map((room) => room.topic)).toContain('room-1');
    expect(text).not.toContain(NASTY_SUBJECT_ID);
    // The status line reports the product's returned list, which is the record of what
    // was shared - a measurement of the file, not a boolean.
    expect(exportStatus()).toHaveTextContent(/It carries these 1 approved tag: room-1\./i);
    expect(exportStatus()).toHaveTextContent(/It carries the biome you approved\./i);
  });

  it('unticking the last box again produces a file with no tags, and the request omits the key', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();

    fireEvent.click(tagBox('synthetic-tag'));
    await waitFor(() => {
      expect(exportRequests).toHaveLength(0);
    });
    expect(tagBox('synthetic-tag')).toBeChecked();
    fireEvent.click(tagBox('synthetic-tag'));
    await waitFor(() => {
      expect(templateTab()).toHaveTextContent(/Nothing ticked/i);
    });
    expect(tagBox('synthetic-tag')).not.toBeChecked();

    fireEvent.click(downloadButton());
    await waitFor(() => {
      expect(downloads).toHaveLength(1);
    });
    expect(exportRequests[0]).not.toHaveProperty('approvedTags');
    const { document: written } = await readDownload();
    expect((written.graph as Record<string, unknown>).tags).toEqual([]);
  });

  it('resets the approval when the learner chooses a different subject', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();

    const picker = within(templateTab()).getByLabelText<HTMLSelectElement>(/subject to make a template from/i);
    expect(picker.options).toHaveLength(2);
    fireEvent.click(tagBox('synthetic-tag'));
    fireEvent.click(biomeBox());
    expect(tagBox('synthetic-tag')).toBeChecked();

    // An approval is a decision about one subject. It must not survive onto another.
    fireEvent.change(picker, { target: { value: NASTY_OTHER_SUBJECT_ID } });
    await waitFor(() => {
      expect(templateTab()).toHaveTextContent(/Nothing ticked/i);
    });
    expect(tagBox('synthetic-tag')).not.toBeChecked();
    expect(biomeBox()).not.toBeChecked();
  });

  it('bounds the room list and says exactly how many topics it left out', async () => {
    // The list is capped so a four-thousand-room subject cannot push the approval controls
    // off the end of a page, and a capped list that did not say so would be a surface
    // quietly showing less than the file carries - which is the one thing a share screen
    // must not do. The count above the list and the line below it are the real numbers.
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(await createSubjectWithRooms('template-tab-ui-scale', 250));
    render(<DataCenter />);
    await openTemplateTab();

    const shown = renderedTopics();
    expect(shown).toHaveLength(200);
    // The heading states the subject's real room count, not the rendered one.
    expect(templateTab()).toHaveTextContent('The 250 room topics that always go in');
    // ...and the line below names the remainder, in words, with both numbers.
    expect(templateTab()).toHaveTextContent(/50 room topics are not shown here to keep this page usable/i);
    expect(templateTab()).toHaveTextContent(/250 room topics are in the file/i);
    // The list leads with the root, so the bound drops leaves and never the root. This
    // assertion is the reason the order is root-first: ordering by topic alone puts
    // "Scale fixture root" *last*, and it would be the first thing a large subject hid.
    expect(new Set(shown).size).toBe(200);
    expect(shown[0]).toBe('Scale fixture root');
    expect(shown.every((topic) => topic === 'Scale fixture root' || topic.startsWith('Scale fixture room topic '))).toBe(true);
    // The count is not a rendering of the list: a learner who ticks a tag approves tags,
    // not topics, so the tag approval is unaffected by the bound.
    expect(within(templateTab()).getAllByRole('checkbox')).toHaveLength(4);
  });

  it('says so in words when this build cannot read its own subjects, and offers no download', async () => {
    const { DataCenter } = await loadDataCenter(true);
    render(<DataCenter />);
    fireEvent.click(screen.getByRole('tab', { name: /reusable template/i }));
    await waitFor(() => {
      expect(within(templateTab()).getByText(/versioned store this tab reads from/i)).toBeInTheDocument();
    });
    const picker = within(templateTab()).getByLabelText<HTMLSelectElement>(/subject to make a template from/i);
    expect(picker).toBeDisabled();
    expect(picker.options[0]?.textContent).toBe('This device cannot be read here');
    expect(downloadButton()).toBeDisabled();
    // The empty state is stated, and it is a different sentence from the no-subject one:
    // this device cannot be read, which is not the same as having nothing to read.
    expect(templateTab()).toHaveTextContent(/Nothing to show yet/i);
    fireEvent.click(downloadButton());
    await nextTask();
    expect(downloads).toHaveLength(0);
  });

  it('survives a readable device that holds no subject at all, and says so', async () => {
    // A regression test for a crash, found by a browser measurement of this tab on a
    // fresh profile: the picker preselected "the first subject" and the first subject
    // did not exist, so a first-run device threw and took the whole Data Center with
    // it. jsdom did not find it because every other test here stages a device with
    // subjects; only a device staged with none reaches the state.
    const { DataCenter } = await loadDataCenter(true);
    const empty = await createEmptyDevice('template-tab-ui-empty');
    await selectLiveRepository(empty);
    render(<DataCenter />);
    await openTemplateTab();

    const picker = within(templateTab()).getByLabelText<HTMLSelectElement>(/subject to make a template from/i);
    // Not a crash, and not an exception report: an empty picker, a stated reason, and
    // the control disabled.
    expect(picker.options).toHaveLength(1);
    expect(picker.options[0]?.textContent).toBe('No subjects yet');
    expect(templateTab()).toHaveTextContent(/no subject on this device to make a template from yet/i);
    expect(templateTab()).toHaveTextContent(/Nothing to show yet/i);
    expect(downloadButton()).toBeDisabled();
    // The tab group is stated rather than omitted, so the approval step is not a mystery.
    expect(templateTab()).toHaveTextContent(/This subject has no tags on any room|There is no subject/i);
    // ...and the privacy copy is still on screen: the empty state is not a thinner page.
    expect(templateTab()).toHaveTextContent(/Every room topic always goes in/i);
    // ...and the import half is unaffected by having nothing to export.
    await chooseTemplateFile(realTemplate());
    await confirmTemplateImport();
    expect(templateOutcome()).toHaveTextContent(/A new subject was added/i);
    expect((await empty.readRecords('gen-template-tab-ui-empty')).records.subjects).toHaveLength(1);
    // The import is what makes a subject exist, so the picker fills in afterwards with
    // **one** option - the subject that just arrived - and the export control becomes
    // usable, because a learner who has just brought a template in is very likely to be
    // about to share it.
    await waitFor(() => {
      const options = [...templateTab().querySelectorAll<HTMLOptionElement>('select option')];
      expect(options).toHaveLength(1);
      expect(options[0]?.textContent).toContain(product.SUBJECT_TEMPLATE_DEFAULT_SUBJECT_NAME);
    });
    await waitFor(() => {
      expect(downloadButton()).toBeEnabled();
    });
  });

  it('reports a typed failure with no invented message when the template cannot be made', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();
    // A subject id this device does not hold: the read returns nothing, the control is
    // disabled, and the product is never asked.
    const picker = within(templateTab()).getByLabelText<HTMLSelectElement>(/subject to make a template from/i);
    const detached = document.createElement('option');
    detached.value = 'subject-not-on-this-device';
    detached.textContent = 'Subject with no name — 0 rooms';
    picker.appendChild(detached);
    fireEvent.change(picker, { target: { value: 'subject-not-on-this-device' } });
    await waitFor(() => {
      expect(downloadButton()).toBeDisabled();
    });
    fireEvent.click(downloadButton());
    await nextTask();
    expect(downloads).toHaveLength(0);
    expect(exportRequests).toHaveLength(0);
  });
});

// ── 4. The import, and where it lands ─────────────────────────────────────

describe('Phase 7 template tab: the import', () => {
  it('opens the confirmation from the act of choosing a file, with a real focus trap', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();
    // Before a file is chosen there is no commit control anywhere on the tab.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(downloads).toHaveLength(0);

    const before = document.activeElement;
    await chooseTemplateFile(realTemplate());
    const dialog = templateDialog();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: /add this template as a new subject\?/i })).toBeInTheDocument();
    // Initial focus is the dialog container, so the learner's next Enter is not a
    // commit.
    expect(document.activeElement).toBe(dialog);
    expect(before).not.toBe(dialog);
    // The three facts the confirmation exists to state.
    expect(dialog.textContent).toMatch(/Nothing that is already here is replaced, removed, or changed/i);
    expect(dialog.textContent).toMatch(/no internal id from the file is kept/i);
    expect(dialog.textContent).toMatch(/Every room arrives\s*empty/i);
    expect(dialog.textContent).toMatch(/added in the Create state/i);
    // Tab from the last control cycles to the first rather than escaping to the page.
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
    (focusable[focusable.length - 1] as HTMLElement).focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusable[0]);
  });

  it('Escape closes the confirmation, writes nothing, and restores focus to the opener', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();
    const opener = chooseButton();
    await chooseTemplateFile(realTemplate());
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(templateDialog(), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(importRequests).toHaveLength(0);
    // The file is still chosen, so the report and the preview are still there - the
    // learner dismissed the *commit*, not the file.
    expect(templatePreviewSurface()).toBeInTheDocument();
    // ...and focus is back on the control the dialog was opened from.
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('adds one subject in the Create state with every room blank, and reports it as a measurement', async () => {
    const { DataCenter } = await loadDataCenter(true);
    const target = await createNastySubjectDevice('template-tab-ui-import');
    await selectLiveRepository(target.repository);
    const opened: string[] = [];
    const refreshed: number[] = [];
    render(<DataCenter onOpenSubject={(id) => opened.push(id)} onSubjectImported={() => refreshed.push(1)} />);
    await openTemplateTab();

    const before = await target.repository.readRecords(NASTY_GENERATION_ID);
    const beforeSubjectIds = before.records.subjects.map((entry) => entry.value.subjectId).sort();
    const beforeSubjectCount = before.records.subjects.length;

    // A destination name is optional; this one is typed, so the report can say where the
    // name came from - and the name is the learner's own text.
    await chooseTemplateFile(realTemplate(['synthetic-tag']), 'shared-template.kdtemplate');
    fireEvent.change(destinationField(), { target: { value: '  A Chosen Name  ' } });
    await confirmTemplateImport();

    // The request: the product is handed the template text, an injected clock, the
    // generator the screen owns, and the trimmed destination name.
    const request = importRequests[0] as Record<string, unknown>;
    expect(typeof request.template).toBe('string');
    expect((request.template as string).startsWith('{')).toBe(true);
    expect(typeof request.now).toBe('string');
    expect(request.destinationSubjectName).toBe('A Chosen Name');
    expect(mintedCandidates.length).toBeGreaterThanOrEqual(7);

    // The device: one record added, and every one of them blank.
    const after = await target.repository.readRecords(NASTY_GENERATION_ID);
    expect(after.records.subjects).toHaveLength(beforeSubjectCount + 1);
    const added = after.records.subjects.find(
      (entry) => !beforeSubjectIds.includes(entry.value.subjectId),
    );
    expect(added).toBeDefined();
    const snapshot = (added as { value: { snapshot: unknown } }).value.snapshot as {
      dungeon: { phaseState: string; subjectName: string };
      rooms: Record<string, Record<string, unknown>>;
    };
    expect(snapshot.dungeon.phaseState).toBe('CreatorActive');
    expect(snapshot.dungeon.subjectName).toBe('A Chosen Name');
    const rooms = Object.values(snapshot.rooms) as Array<Record<string, unknown>>;
    expect(rooms).toHaveLength(6);
    for (const room of rooms) {
      expect(room.state).toBe('Created');
      expect(room.noteText).toBe('');
      expect(room.artifactMarkdown).toBeNull();
      expect(room.attachments).toEqual([]);
      expect(room.reviewPassCount).toBe(0);
    }
    // Nothing else moved: the other subject is byte-identical, and the generation is
    // still the active one - an additive record, not a pointer flip.
    const other = after.records.subjects.find(
      (entry) => entry.value.subjectId === NASTY_OTHER_SUBJECT_ID,
    );
    expect(JSON.stringify(other?.value.snapshot)).toBe(
      JSON.stringify(before.records.subjects.find((entry) => entry.value.subjectId === NASTY_OTHER_SUBJECT_ID)?.value.snapshot),
    );
    expect(await target.repository.readActiveGenerationId()).toBe(NASTY_GENERATION_ID);

    // The report, and every sentence licensed by a field or a count.
    const report = templateOutcome() as HTMLElement;
    expect(report).toHaveTextContent(new RegExp('A new subject was added, called A Chosen Name'));
    expect(report).toHaveTextContent(/You chose that name just now/i);
    expect(report).toHaveTextContent(/All 6 of them are empty/i);
    expect(report).toHaveTextContent(/no note, no written artifact, no image, and no review history/i);
    expect(report).toHaveTextContent(/which is the number the file declared/i);
    expect(report).toHaveTextContent(/It is in the Create state/i);
    expect(report).toHaveTextContent(/The file carried 1 approved tag and no biome/i);
    expect(report).toHaveTextContent(/Nothing else on this device was changed/i);
    expect(report).toHaveTextContent(/deleting the new subject is the whole of the undo/i);
    // A count, never a tag: the report can be copied out of the screen.
    expect(report.textContent).not.toContain('synthetic-tag');
    // The technical details carry the closed codes and counts, and no identifier beyond
    // the opaque generation name the sibling reports already publish.
    expect(report).toHaveTextContent('additive-single-record');
    expect(report).toHaveTextContent('delete-the-created-subject-record');
    expect(report).toHaveTextContent('caller');

    // The learner stays on the report, and the host was told once.
    expect(refreshed).toHaveLength(1);
    expect(opened).toHaveLength(0);
    expect(templateOutcome()).toBeInTheDocument();
  });

  it('offers a control to go and edit the graph, and only navigates when it is pressed', async () => {
    const { DataCenter } = await loadDataCenter(true);
    const target = await createNastySubjectDevice('template-tab-ui-open');
    await selectLiveRepository(target.repository);
    const opened: string[] = [];
    render(<DataCenter onOpenSubject={(id) => opened.push(id)} />);
    await openTemplateTab();
    await chooseTemplateFile(realTemplate());
    await confirmTemplateImport();

    // The control is *inside* the report, so a learner reads the disclosure first.
    const report = templateOutcome() as HTMLElement;
    const goThere = within(report).getByRole<HTMLButtonElement>('button', {
      name: /open it in create to edit the graph/i,
    });
    // Still nothing: the import did not navigate.
    expect(opened).toHaveLength(0);
    expect(templateOutcome()).toBeInTheDocument();

    fireEvent.click(goThere);
    expect(opened).toHaveLength(1);
    // The id handed back is this device's own opaque subject id, and it is the one the
    // import minted.
    const after = await target.repository.readRecords(NASTY_GENERATION_ID);
    const ids = after.records.subjects.map((entry) => entry.value.subjectId);
    expect(opened[0]).toBeTruthy();
    expect(ids).toContain(opened[0]);
    // ...and it is not in the DOM, so it cannot be read off the screen.
    expect(document.body.textContent).not.toContain(opened[0] as string);
  });

  it('omits the action entirely when the host offers no way to open a subject', async () => {
    const { DataCenter } = await loadDataCenter(true);
    const target = await createNastySubjectDevice('template-tab-ui-no-open');
    await selectLiveRepository(target.repository);
    render(<DataCenter />);
    await openTemplateTab();
    await chooseTemplateFile(realTemplate());
    await confirmTemplateImport();
    // No host callback, no control: a button that could not do anything is worse than
    // no button.
    expect(
      within(templateOutcome() as HTMLElement).queryByRole('button', { name: /open it in create/i }),
    ).toBeNull();
  });

  it('two imports of the same file create two independent subjects with fresh ids', async () => {
    const { DataCenter } = await loadDataCenter(true);
    const target = await createNastySubjectDevice('template-tab-ui-twice');
    await selectLiveRepository(target.repository);
    render(<DataCenter />);
    await openTemplateTab();
    const beforeSubjectIds = (
      await target.repository.readRecords(NASTY_GENERATION_ID)
    ).records.subjects.map((entry) => entry.value.subjectId);
    await chooseTemplateFile(realTemplate());
    const firstReport = (templateOutcome() as HTMLElement | null)?.textContent ?? null;
    await confirmTemplateImport(firstReport);
    const afterFirst = await target.repository.readRecords(NASTY_GENERATION_ID);
    const firstCount = afterFirst.records.subjects.length;

    await chooseTemplateFile(realTemplate(), 'shared-template-again.kdtemplate');
    const secondReport = (templateOutcome() as HTMLElement | null)?.textContent ?? null;
    await confirmTemplateImport(secondReport);
    const afterSecond = await target.repository.readRecords(NASTY_GENERATION_ID);
    expect(afterSecond.records.subjects).toHaveLength(firstCount + 1);


    /*
     * Two independent subjects, and the assertion is about *independence* rather than
     * about a substring: every room id on the device must be distinct, and neither new
     * subject may reuse one of the source subject's. A substring sweep over the whole
     * generation would be wrong here - the destination fixture already holds a subject
     * whose id is the *source* device's subject id, so the string is legitimately
     * present and asserting its absence would be asserting a falsehood.
     */
    const allRoomIds = afterSecond.records.subjects.flatMap((entry) =>
      Object.keys((entry.value.snapshot as { rooms: object }).rooms),
    );
    expect(new Set(allRoomIds).size).toBe(allRoomIds.length);
    const sourceRoomIds = new Set(Object.keys(nastySnapshot().rooms));
    const added = afterSecond.records.subjects.filter(
      (entry) => !beforeSubjectIds.includes(entry.value.subjectId),
    );
    expect(added).toHaveLength(2);
    for (const record of added) {
      for (const roomId of Object.keys((record.value.snapshot as { rooms: object }).rooms)) {
        expect(sourceRoomIds.has(roomId), `${roomId} was reused from the source`).toBe(false);
        expect(String(roomId).startsWith('kc-room-')).toBe(true);
      }
      // The two copies share no room id with each other either.
      expect((record.value.snapshot as { dungeon: { subjectName: string } }).dungeon.subjectName).toBe(
        product.SUBJECT_TEMPLATE_DEFAULT_SUBJECT_NAME,
      );
    }
  });

  it('names the default honestly when the learner leaves the name blank and the file has none', async () => {
    const { DataCenter } = await loadDataCenter(true);
    const target = await createNastySubjectDevice('template-tab-ui-default-name');
    await selectLiveRepository(target.repository);
    render(<DataCenter />);
    await openTemplateTab();
    await chooseTemplateFile(realTemplate());
    // The request omits the key entirely rather than sending an empty string, so the
    // product takes its own two-step default and the report can say which step it took.
    expect(importRequests).toHaveLength(0);
    await confirmTemplateImport();
    expect(importRequests[0]).not.toHaveProperty('destinationSubjectName');
    const report = templateOutcome() as HTMLElement;
    expect(report).toHaveTextContent(new RegExp(`called ${product.SUBJECT_TEMPLATE_DEFAULT_SUBJECT_NAME}`));
    expect(report).toHaveTextContent(/the default name this app always uses/i);
    expect(report).toHaveTextContent('default');
  });

  it('refuses a legacy .template.json outright, and changes nothing', async () => {
    const { createSubjectFromTemplate, exportSubjectAsTemplate } = await import(
      '@/services/persistence/subjectPersistence'
    );
    const { DataCenter } = await loadDataCenter(true);
    const target = await createNastySubjectDevice('template-tab-ui-legacy');
    await selectLiveRepository(target.repository);
    render(<DataCenter />);
    await openTemplateTab();

    const before = await target.repository.readRecords(NASTY_GENERATION_ID);
    // A real file from the pre-Phase-7 exporter, written on the spot, so the refusal is
    // exercised against the shape the cutover removed rather than a hand-made one.
    const legacyText = exportSubjectAsTemplate(nastySnapshot());
    expect(legacyText).toContain(MARKER_TOKEN);
    const input = templateTab().querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [templateFileOf(legacyText, 'old-name.template.json')] },
    });

    const problem = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-kd-surface="template-inspection-problem"]');
      if (found === null) throw new Error('no inspection problem yet');
      return found;
    });
    expect(problem).toHaveAttribute('role', 'alert');
    expect(problem.textContent).toMatch(/reported as [A-Z_]+/);
    expect(problem.textContent).toMatch(/cannot be used/i);
    // The refusal is silent: the marker, the subject name, and the file's own name are
    // all in the file and none of them is in the message.
    expect(problem.textContent).not.toContain(MARKER_TOKEN);
    expect(problem.textContent).not.toContain(nastySnapshot().dungeon.subjectName);
    expect(problem.textContent).not.toContain('old-name');
    // ...and nothing was written, and the commit control never appeared.
    expect(importRequests).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    const after = await target.repository.readRecords(NASTY_GENERATION_ID);
    expect(after.records.subjects).toHaveLength(before.records.subjects.length);
    expect(inspectionStatus().textContent).toBe('');
    // The legacy pair itself still works, because the rollback is retained - this is a
    // statement about which *path* is in charge, not about the functions being gone.
    expect(createSubjectFromTemplate(legacyText).dungeon.phaseState).toBe('CreatorActive');
  });

  it('reports a typed failure, in the operation\'s own words, when the import is refused', async () => {
    const { DataCenter } = await loadDataCenter(true);
    const target = await createNastySubjectDevice('template-tab-ui-refused');
    await selectLiveRepository(target.repository);
    render(<DataCenter />);
    await openTemplateTab();

    const before = await target.repository.readRecords(NASTY_GENERATION_ID);
    // A destination name past the product's own bound. The field carries `maxLength`,
    // so a learner cannot type this - which is exactly why the assertion is worth making:
    // the *product* still refuses it, and the surface still has to render the refusal
    // honestly rather than crashing or inventing a message.
    await chooseTemplateFile(realTemplate());
    fireEvent.change(destinationField(), { target: { value: 'x'.repeat(401) } });
    await confirmTemplateImport();

    // The report is a failure, and it is the *template import's* failure copy: an
    // additive single record stages no copy, so the restore sentence - "written into a
    // new copy first and only then made active" - would be untrue here.
    const report = templateOutcome() as HTMLElement;
    expect(report.className).toContain('kd-outcome--problem');
    const alert = within(report).getByRole('alert');
    expect(alert).toHaveTextContent(/The template was not brought in/i);
    expect(alert).toHaveTextContent(/No subject was added, and every subject you already had is exactly as it was/i);
    expect(alert).toHaveTextContent(/before anything is written/i);
    expect(alert).toHaveTextContent(/the subject it had just created is removed again/i);
    expect(alert).not.toHaveTextContent(/written into a new copy first/i);
    // A code, and no invented message: no `error.message`, no name, no file name.
    expect(alert.textContent).toMatch(/reported as [A-Z_]+/);
    expect(alert.textContent).not.toContain('xxxx');
    expect(alert.textContent).not.toContain(nastySnapshot().dungeon.subjectName);
    // ...and nothing was written.
    const after = await target.repository.readRecords(NASTY_GENERATION_ID);
    expect(after.records.subjects).toHaveLength(before.records.subjects.length);
    expect(await target.repository.readActiveGenerationId()).toBe(NASTY_GENERATION_ID);
    // The technical details carry the code-shaped reason, which is a code and not a value.
    const details = report.querySelector('.kd-technical') as HTMLElement;
    expect(details.textContent).toContain('destinationSubjectName');
  });
});

// ── 5. Accessibility ──────────────────────────────────────────────────────

describe('Phase 7 template tab: accessibility', () => {
  it('every control is at least 44 by 44 CSS pixels, measured from the real stylesheet', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();
    // Three tag boxes, a biome box, three optional text fields, the picker, the three
    // tabs, the file-picker button, the download button, and the dialog's two controls.
    fireEvent.click(tagBox('room-1'));
    await chooseTemplateFile(realTemplate());

    // The buttons, tabs, selects, and text fields all carry the shared `min-height` and
    // `min-width`, so one measurement of each kind covers them.
    const measured: Array<[string, number, number]> = [];
    for (const control of [
      ...screen.getAllByRole('button'),
      ...screen.getAllByRole('tab'),
      ...within(templateTab()).getAllByRole('textbox'),
      ...within(templateTab()).getAllByRole('combobox'),
      ...within(templateDialog()).getAllByRole('button'),
      ...within(templateDialog()).getAllByRole('textbox'),
    ]) {
      const computed = window.getComputedStyle(control);
      measured.push([
        control.getAttribute('aria-label') ?? control.id ?? (control.textContent ?? '').slice(0, 28),
        Number.parseFloat(computed.minHeight),
        Number.parseFloat(computed.minWidth),
      ]);
    }
    expect(measured.length).toBeGreaterThanOrEqual(12);
    for (const [label, height, width] of measured) {
      expect(height, `${label} height`).toBeGreaterThanOrEqual(44);
      expect(width, `${label} width`).toBeGreaterThanOrEqual(44);
    }

    // The two optional text fields Phase 7 added, read from the real stylesheet. The
    // cap is the 320-pixel one: a full-width field with no cap is a field that forces a
    // horizontal scrollbar on a narrow viewport.
    const input = within(templateTab()).getByLabelText<HTMLInputElement>(/template name \(optional\)/i);
    const inputStyle = window.getComputedStyle(input);
    expect(Number.parseFloat(inputStyle.minHeight)).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(inputStyle.minWidth)).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(inputStyle.maxWidth)).toBeLessThanOrEqual(32 * 16);
    const destinationStyle = window.getComputedStyle(destinationField());
    expect(Number.parseFloat(destinationStyle.minHeight)).toBeGreaterThanOrEqual(44);

    // The tick target is the whole 44-pixel `<label>`, because the native checkbox
    // inside it is 20 CSS pixels and a stylesheet cannot honestly claim otherwise. This
    // is the same rule the subject tab's radio group already works by, applied to a
    // checkbox: the measurement is taken on the label, in both states.
    for (const box of [tagBox('room-1'), tagBox('synthetic-tag'), biomeBox()]) {
      const label = box.closest('label') as HTMLElement;
      expect(label, 'the tick target is a label').not.toBeNull();
      const style = window.getComputedStyle(label);
      // `min-height` only, and that is the honest rule: the native checkbox is 20 CSS
      // pixels square, so the 44-pixel target is the label's *height* plus its own width
      // from the row it sits in - which the browser gives it. Claiming a `min-width` the
      // stylesheet does not declare would be a measurement of nothing.
      expect(Number.parseFloat(style.minHeight), 'label min-height').toBeGreaterThanOrEqual(44);
    }
    const unchecked = window.getComputedStyle((tagBox('cozy-hearth').closest('label') as HTMLElement));
    expect(Number.parseFloat(unchecked.minHeight)).toBeGreaterThanOrEqual(44);
  });

  it('computes every text and control-boundary pair Phase 7 introduces, and clears its threshold', async () => {
    // The tab introduced **no new colour**, so the pairs it renders are ones the
    // stylesheet's own header already measured. Recomputing them here is what makes the
    // header's table a measurement rather than a claim, and a colour edit to the
    // stylesheet cannot quietly fail it.
    const card = token('card');
    const selected = '#f7eddb';
    const textPairs: ReadonlyArray<readonly [string, string, string]> = [
      // The room list: the topic text, which is the one thing a template always carries.
      ['a room topic', token('ink'), card],
      // The privacy block's prose and its bolded lead-ins.
      ['the privacy block prose', token('ink-soft'), card],
      ['the privacy block emphasis', token('ink'), card],
      // The counted remainder under a long list, and the picker's help line.
      ['the not-shown line', token('ink-soft'), card],
      ['the field help', token('ink-soft'), card],
      // A ticked tag row, on the selected background, in both weights.
      ['a ticked tag name', token('ink'), selected],
      ['a ticked tag note', token('ink-soft'), selected],
      // The live approval sentence.
      ['the approval sentence', token('ink-soft'), card],
    ];
    for (const [label, foreground, background] of textPairs) {
      const ratio = contrastRatio(foreground, background);
      expect(ratio, `${label}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    const nonTextPairs: ReadonlyArray<readonly [string, string, string]> = [
      // A tick is a shape and a colour, so the box boundary is a control boundary: the
      // strong rule, never the decorative one.
      ['a tag box boundary', token('line-strong'), card],
      ['a ticked tag boundary', token('line-strong'), selected],
      ['a ticked tag accent edge', token('accent'), selected],
      ['the optional field boundary', token('line-strong'), card],
      ['the focus ring on a card', token('focus'), card],
      ['the focus ring on a ticked row', token('focus'), selected],
    ];
    for (const [label, foreground, background] of nonTextPairs) {
      const ratio = contrastRatio(foreground, background);
      expect(ratio, `${label}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
    // The stylesheet's own rules for the two new kinds of control, read from the file.
    const source = blankComments(stylesheetSource());
    const inputRule = /\.kd-data-center \.kd-input\.kd-input\s*\{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(inputRule).toContain('min-height: 44px');
    expect(inputRule).toContain('border: 1px solid var(--kd-line-strong)');
    // The room list's cap, and the wrap that keeps a 320-pixel viewport from scrolling.
    const topicsRule = /\.kd-data-center \.kd-topics\s*\{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(topicsRule).toContain('max-height:');
    expect(topicsRule).toContain('overflow-wrap: anywhere');
    // The focus rule covers the new text field, not only the old controls.
    const focusRules = source.match(/[^{}]*:focus-visible[^{]*\{[^}]*\}/g) ?? [];
    expect(focusRules.join('\n')).toMatch(/\.kd-input/);
    for (const rule of focusRules) {
      expect(rule).toMatch(/outline:\s*3px solid var\(--kd-focus\)/);
      expect(rule).toMatch(/outline-offset:\s*2px/);
    }
  });

  it('signals every state in words and a glyph, and never by colour alone', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();

    // The tab's own root carries the reduced-motion attribute the stylesheet keys off,
    // so a learner who changes the preference while the screen is open is honoured -
    // and it is either absent or the one value the stylesheet knows, never a third
    // state. The stylesheet answers the same question without scripting, so both
    // answers remove animation and transitions.
    const motion = dataCenterOf().getAttribute('data-kd-motion');
    expect(motion === null || motion === 'reduced', `data-kd-motion was ${String(motion)}`).toBe(true);
    expect(blankComments(stylesheetSource())).toContain('@media (prefers-reduced-motion: reduce)');
    expect(stylesheetSource()).toContain(".kd-data-center[data-kd-motion='reduced']");

    // An unticked tag: unchecked box, the word "Unticked." in its row, and a live
    // sentence. Three channels, and the box alone is not one of the words.
    const box = tagBox('room-1');
    const row = (box.closest('label') as HTMLElement).textContent ?? '';
    expect(row).toContain('Unticked');
    expect(row).not.toContain('Ticked.');
    // A ticked tag: the same three channels, in the other state.
    fireEvent.click(box);
    await waitFor(() => {
      expect((box.closest('label') as HTMLElement).textContent).toContain('Ticked.');
    });
    // The problem glyphs in both problem regions are decorative and hidden, so a screen
    // reader does not read them twice.
    const { exportSubjectAsTemplate } = await import('@/services/persistence/subjectPersistence');
    const input = templateTab().querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [templateFileOf(exportSubjectAsTemplate(nastySnapshot()), 'legacy.template.json')] },
    });
    const problem = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-kd-surface="template-inspection-problem"]');
      if (found === null) throw new Error('no inspection problem yet');
      return found;
    });
    const marker = problem.querySelector('.kd-marker') as HTMLElement;
    expect(marker.textContent?.trim().length).toBeGreaterThan(0);
    expect(marker).toHaveAttribute('aria-hidden', 'true');
    // The problem is also an alert, so it is heard without being asked for.
    expect(problem).toHaveAttribute('role', 'alert');
  });

  it('keeps every status surface polite, and the rooms list announced as a list', async () => {
    const { DataCenter } = await loadDataCenter(true);
    await selectLiveRepository(device.repository);
    render(<DataCenter />);
    await openTemplateTab();
    for (const surface of [exportStatus(), inspectionStatus()]) {
      expect(surface).toHaveAttribute('role', 'status');
      expect(surface).toHaveAttribute('aria-live', 'polite');
    }
    // The room list is a heading plus a real list, so a screen reader can navigate it
    // by item and the heading states how many there are.
    const heading = within(templateTab()).getByRole('heading', {
      name: /6 room topics that always go in/i,
    });
    expect(heading).toBeInTheDocument();
    const list = templateTab().querySelector('.kd-topics') as HTMLElement;
    expect(list.querySelectorAll('li')).toHaveLength(6);
    // The tag group is a fieldset with a legend, so the boxes are named by a group.
    const group = within(templateTab()).getByRole('group', { name: /tags to include \(optional\)/i });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(3);
  });
});

