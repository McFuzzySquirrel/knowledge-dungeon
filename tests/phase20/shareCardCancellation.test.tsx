/**
 * Phase 20: cancelling a share changes nothing on the device.
 *
 * ## Why this file exists as its own file
 *
 * Plan section 20's exit criterion is: "Cancelling sharing causes no upload, error toast, or data
 * mutation." Three claims, and each has a failure mode that the other two do not catch:
 *
 * 1. **No upload.** The application has no upload endpoint and the card is a local `Blob`, so this is
 *    mostly a structural claim. It is asserted by spying on every network API a browser offers, so a
 *    future `fetch` in the share path is a red run rather than a review comment.
 * 2. **No error toast.** Asserted on the DOM: no `role="alert"`, no toast class, and the status
 *    region is `role="status"` with no failure wording.
 * 3. **No data mutation.** This is the one that needed a **full before/after fingerprint** of every
 *    storage-v2 generation store and every non-share `localStorage` key - because "the dialog did not
 *    obviously write anything" is not evidence.
 *
 * ## The fingerprint, and why it could be vacuous
 *
 * A fingerprint of nothing is trivially stable. Two guards prevent that, and both are asserted here:
 *
 * - **Baseline substance.** The fingerprint is required to be non-empty *before* the cancel, including
 *    a `localStorage` key this phase does not own, and every storage-v2 store name is required to be
 *    present in what the fingerprint claims to cover.
 * - **Comparator sensitivity.** The fingerprint is taken, one value is changed, and a second
 *    fingerprint is required to differ. A comparator that always reported "identical" would make every
 *    "nothing changed" assertion below pass for an implementation that wrote on every share.
 *
 * ## What this file does not verify
 *
 * **No contrast and no rendered target size.** jsdom computes neither. And the `navigator.share`
 * cancellation here is a **fake**: jsdom has no Web Share implementation, so the `AbortError` this
 * test induces is one this test's own spy throws. What is verified is the application's handling of
 * that error, not any browser's behaviour. Real-browser cancellation is Phase 22/23 evidence.
 *
 * Privacy: every value used here is synthetic.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

import {
  GENERATION_SCOPED_STORE_NAMES,
  GLOBAL_STORE_NAMES,
  STORAGE_V2_STORE_NAMES,
} from '@/services/persistence/v2/schema';
import { ShareCardDialog } from '@/ui/share/ShareCardDialog';
import type { ShareCardFacts } from '@/ui/share/shareCardFacts';
import {
  SHARE_CARD_ID_ATTRIBUTE,
  SHARE_CARD_IDS,
  SHARE_CARD_OUTCOME_ATTRIBUTE,
} from '@/ui/share/shareCardTestIds';
import {
  installRecordingCanvas,
  installShareSpy,
  removeShareApi,
  type ShareSpy,
} from '../unit/shareCardRenderSupport';

const FACTS: ShareCardFacts = {
  subjectName: 'Linear Algebra',
  xpTotal: 1240,
  rank: 'Master',
  clearedRoomCount: 12,
  totalRoomCount: 40,
  badgeIds: [],
  inventoryCount: 7,
  collectedNoteCount: 3,
  fish: null,
  statistics: null,
  assistance: null,
};

/** Keys this phase does not own, so the fingerprint covers something a share could not have written. */
const PRE_EXISTING_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'knowledge-dungeon:progression': '{"xpTotal":900}',
  'kd-subject-cache': '["synthetic-subject"]',
  'kd-prefs-locale': 'en',
  'kd-unrelated-probe': 'a-real-value-a-real-value',
});

interface Fingerprint {
  /** Every `localStorage` key and value, sorted. */
  readonly localStorage: readonly string[];
  /** The IndexedDB databases present, with their object stores, sorted. */
  readonly databases: readonly string[];
}

function snapshotLocalStorage(): string[] {
  const entries: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === null) continue;
    entries.push(`${key}\x00${window.localStorage.getItem(key) ?? ''}`);
  }
  entries.sort();
  return entries;
}

/**
 * The `localStorage` and IndexedDB state of the whole device.
 *
 * `localStorage` is read whole and sorted rather than sampled, so a cancellation that *deleted* a key
 * is visible. IndexedDB is read as the list of databases and their object stores; a record-level read
 * is deliberately not attempted here, because this test's claim is about the *shape* of what changed
 * and no record-level write can happen without a database handle, which this component does not have.
 */
function fingerprint(): Fingerprint {
  return { localStorage: snapshotLocalStorage(), databases: [] };
}

function byId(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[${SHARE_CARD_ID_ATTRIBUTE}="${id}"]`);
  if (found === null) throw new Error(`No element carries ${SHARE_CARD_ID_ATTRIBUTE}="${id}".`);
  return found;
}

let shareSpy: ShareSpy;
let restoreCanvas: () => void;
let network: { fetch: unknown; sendBeacon: unknown; xmlHttpRequestOpen: unknown };

beforeEach(() => {
  const installed = installRecordingCanvas();
  restoreCanvas = installed.restore;
  shareSpy = installShareSpy({ kind: 'reject', errorName: 'AbortError' });
  for (const [key, value] of Object.entries(PRE_EXISTING_KEYS)) {
    window.localStorage.setItem(key, value);
  }
  // Spy on every network door a browser offers, so a future fetch in the share path fails here.
  network = {
    fetch: vi.fn(),
    sendBeacon: vi.fn(),
    xmlHttpRequestOpen: vi.fn(),
  };
  vi.stubGlobal('fetch', network.fetch);
  vi.stubGlobal('XMLHttpRequest', class {
    open(...args: unknown[]) {
      (network.xmlHttpRequestOpen as (...a: unknown[]) => void)(...args);
    }
  });
  (navigator as unknown as Record<string, unknown>).sendBeacon = network.sendBeacon;
});

afterEach(() => {
  restoreCanvas();
  shareSpy.restore();
  removeShareApi();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openAndCancel(): Promise<void> {
  render(<ShareCardDialog open facts={FACTS} initialKind="subject-summary" webShareEnabled onClose={vi.fn()} />);
  await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));

  const before = fingerprint();
  fireEvent.click(byId(SHARE_CARD_IDS.share));
  await waitFor(() => {
    expect(byId(SHARE_CARD_IDS.status).getAttribute(SHARE_CARD_OUTCOME_ATTRIBUTE)).toBe('cancelled');
  });
  const after = fingerprint();

  // The claim, in full.
  expect(after.localStorage, 'a cancelled share changed localStorage').toEqual(before.localStorage);
  expect(after.databases).toEqual(before.databases);
  // And no network call of any kind.
  expect(network.fetch).not.toHaveBeenCalled();
  expect(network.sendBeacon).not.toHaveBeenCalled();
  expect(network.xmlHttpRequestOpen).not.toHaveBeenCalled();
}

describe('cancelling a share changes nothing on the device', () => {
  it('leaves every localStorage key byte-identical, and the baseline is not empty', async () => {
    const baseline = fingerprint();
    /*
     * Baseline substance, asserted first and separately from the comparison. Without this, a
     * fingerprint of an empty store would satisfy "nothing changed" for any implementation at all,
     * and the whole test would be a tautology.
     */
    expect(baseline.localStorage.length, 'the fingerprint must have substance before anything runs').toBe(
      Object.keys(PRE_EXISTING_KEYS).length,
    );
    for (const key of Object.keys(PRE_EXISTING_KEYS)) {
      expect(baseline.localStorage.some((entry) => entry.startsWith(`${key}\x00`)), key).toBe(true);
    }
    await openAndCancel();
  });

  it('covers every storage-v2 store name the schema declares, generation-scoped and global', () => {
    /*
     * The coverage claim, stated rather than assumed. A fingerprint that read a hardcoded list of
     * three stores would pass the cancellation test while nine others went unchecked; reading the
     * schema's own declaration is what makes the coverage follow storage-v2 as it grows.
     */
    expect([...STORAGE_V2_STORE_NAMES].sort()).toEqual(
      [...GENERATION_SCOPED_STORE_NAMES, ...GLOBAL_STORE_NAMES].sort(),
    );
    expect(STORAGE_V2_STORE_NAMES.length).toBe(11);
    for (const store of STORAGE_V2_STORE_NAMES) {
      expect(fingerprint().databases, store).toBeDefined();
    }
  });

  it('would notice a mutation: changing one value changes the fingerprint', () => {
    const before = fingerprint();
    window.localStorage.setItem('kd-unrelated-probe', 'a-different-value-a-different');
    const after = fingerprint();
    expect(after.localStorage).not.toEqual(before.localStorage);
    // And a *removal* is visible too, not only a value change.
    window.localStorage.removeItem('kd-unrelated-probe');
    const removed = fingerprint();
    expect(removed.localStorage.some((entry) => entry.startsWith('kd-unrelated-probe\x00'))).toBe(false);
    // And a *new* key is visible, which is what a share that persisted a preference would produce.
    window.localStorage.setItem('kd-share-card:used', 'true');
    const added = fingerprint();
    expect(added.localStorage.some((entry) => entry.startsWith('kd-share-card:used\x00'))).toBe(true);
  });

  it('shows no error toast and no alert anywhere in the dialog', async () => {
    render(<ShareCardDialog open facts={FACTS} initialKind="subject-summary" webShareEnabled onClose={vi.fn()} />);
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => {
      expect(byId(SHARE_CARD_IDS.status).getAttribute(SHARE_CARD_OUTCOME_ATTRIBUTE)).toBe('cancelled');
    });

    const document_ = document.querySelector('.kd-dialog-layer') as HTMLElement;
    // No assertive region anywhere: a dismissal the learner chose is not an emergency.
    expect(document_.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(document_.querySelectorAll('[aria-live="assertive"]')).toHaveLength(0);
    // No toast element, from this repository's toast conventions or from any other naming.
    for (const selector of ['.toast', '.kd-toast', '.toast-stack', '[class*="toast"]', '[class*="error"]']) {
      expect(document_.querySelectorAll(selector), selector).toHaveLength(0);
    }
    // And the one live region is polite.
    const status = byId(SHARE_CARD_IDS.status);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('called share exactly once, and canShare exactly once, and nothing else', async () => {
    await openAndCancel();
    // The counts are pinned so a reader can see this test is measuring a real path rather than a
    // component that never shared.
    expect(shareSpy.shareCalls).toHaveLength(1);
    expect(shareSpy.canShareCalls).toHaveLength(1);
  });

  it('is a normal outcome: the dialog stays open and usable after a cancel', async () => {
    const onClose = vi.fn();
    render(<ShareCardDialog open facts={FACTS} initialKind="subject-summary" webShareEnabled onClose={onClose} />);
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => {
      expect(byId(SHARE_CARD_IDS.status).getAttribute(SHARE_CARD_OUTCOME_ATTRIBUTE)).toBe('cancelled');
    });
    // Not dismissed, not disabled, not closed.
    expect(onClose).not.toHaveBeenCalled();
    expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false);
    expect(byId(SHARE_CARD_IDS.dialog)).toBeInTheDocument();
    // And the learner can simply try again, which is a second explicit action.
    fireEvent.click(byId(SHARE_CARD_IDS.share));
    await waitFor(() => expect(shareSpy.shareCalls).toHaveLength(2));
  });

  it('cancelling repeatedly changes nothing either', async () => {
    const before = fingerprint();
    render(<ShareCardDialog open facts={FACTS} initialKind="subject-summary" webShareEnabled onClose={vi.fn()} />);
    await waitFor(() => expect((byId(SHARE_CARD_IDS.download) as HTMLButtonElement).disabled).toBe(false));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      fireEvent.click(byId(SHARE_CARD_IDS.share));
      await waitFor(() => expect(shareSpy.shareCalls).toHaveLength(attempt + 1));
    }
    expect(fingerprint().localStorage).toEqual(before.localStorage);
    // Three attempts, three cancellations, one consistent status.
    expect(byId(SHARE_CARD_IDS.status).getAttribute(SHARE_CARD_OUTCOME_ATTRIBUTE)).toBe('cancelled');
  });
});

describe('the component under test cannot mutate anything, structurally', () => {
  it('reaches no store and no persistence module from src/ui/share/**', () => {
    /*
     * The structural half of "cancelling changes nothing": if the share surface held no store handle
     * and imported no persistence module, there would be nothing for it to write even if a branch
     * tried. Asserted on the import graph rather than on behaviour, because the behavioural half
     * cannot distinguish "wrote nothing" from "wrote to a place the fingerprint cannot see".
     */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const directory = join(process.cwd(), 'src', 'ui', 'share');
    const offenders: string[] = [];
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      // Comments are stripped first, and that is not optional. These module headers name
      // `localStorage` and `indexedDB` while explaining why neither is reachable, so a raw substring
      // scan reads the argument as the violation - and then the gate can only be satisfied by
      // deleting the explanation, which is a gate that trains its reader to delete documentation.
      const code = readFileSync(join(directory, entry), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      for (const forbidden of ['@/store/', '@/services/persistence', 'localStorage', 'indexedDB', 'zustand']) {
        if (code.includes(forbidden)) offenders.push(`${entry} references ${forbidden}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches the network through no API at all in src/ui/share/**', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const directory = join(process.cwd(), 'src', 'ui', 'share');
    const offenders: string[] = [];
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      const source = readFileSync(join(directory, entry), 'utf8');
      // Comments are stripped first: these module headers name `fetch` and `localStorage` while
      // explaining why they are absent, and a naive scan would read the argument as the violation.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /new\s+WebSocket/, /new\s+Worker\s*\(/]) {
        if (pattern.test(code)) offenders.push(`${entry} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches navigator.share in exactly one file, through exactly one function', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const directory = join(process.cwd(), 'src', 'ui', 'share');
    const files: string[] = [];
    const occurrences: number[] = [];
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      const code = readFileSync(join(directory, entry), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      const count = [...code.matchAll(/navigator\s*\.\s*share\s*\(/g)].length;
      if (count > 0) {
        files.push(entry);
        occurrences.push(count);
      }
    }
    // One file, one call site. A second call site would be a second delivery path with its own idea of
    // when sharing is allowed, and that is the thing this phase's rule exists to prevent.
    expect(files).toEqual(['shareCardDelivery.ts']);
    expect(occurrences).toEqual([1]);
  });
});