/**
 * Phase 4 privacy gate, test 5: the user-facing privacy statement is accurate.
 *
 * The Welcome screen's privacy paragraph is the one place the application makes
 * a promise to the learner about where their data goes. Phase 4 changes what
 * that promise can be: web image bytes become device-local IndexedDB records,
 * `/api/upload` goes away, and external attachment URLs are preserved without
 * being downloaded. A copy that still says "in your browser (localStorage)" and
 * "Nothing leaves your device" would then be making a claim the code does not
 * honour.
 *
 * The rule set is expressed as a pure checker so it can be tested against
 * synthetic copies in both directions. That is what keeps the conditional rules
 * honest: the "if it mentions external images, it must say their bytes cannot be
 * retrieved" rule is inert against today's copy, so the checker is separately
 * required to ACCEPT a disclosing copy and REJECT a silent one.
 *
 * The live assertion is registered as `it.fails` while the shipped copy is
 * inaccurate. It turns RED the moment the UI specialist corrects the copy, which
 * is when this file must be changed to `it` and kept.
 *
 * Privacy: this file reads a source file. It contains no learner data.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WELCOME_SCREEN = join(process.cwd(), 'src', 'ui', 'screens', 'WelcomeScreen.tsx');

/**
 * The paragraph that carries the privacy statement, with the
 * `electronAvailable` ternary resolved for each host and JSX markup removed.
 *
 * Only the two literal branches are interpreted; every other expression
 * contributes a space. The result is the sentence a learner actually reads.
 */
export function extractPrivacyCopy(source: string, host: 'web' | 'electron'): string {
  const marker = source.indexOf('Privacy:');
  if (marker === -1) throw new Error('No privacy statement was found in the Welcome screen source.');

  const openIndex = source.lastIndexOf('<p', marker);
  const closeIndex = source.indexOf('</p>', marker);
  if (openIndex === -1 || closeIndex === -1) {
    throw new Error('The privacy statement is not inside a paragraph element.');
  }

  const paragraph = source.slice(openIndex, closeIndex)
    .replace(
      /\{electronAvailable\s*\?\s*'([^']*)'\s*:\s*'([^']*)'\s*\}/g,
      (_match, whenElectron: string, whenWeb: string) => (host === 'electron' ? whenElectron : whenWeb),
    )
    .replace(/\{'[^']*'\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ');

  return paragraph.replace(/\s+/g, ' ').trim();
}

export interface PrivacyCopyVerdict {
  /** The copy names `localStorage`. */
  readonly namesLocalStorage: boolean;
  /** The copy names IndexedDB. */
  readonly namesIndexedDb: boolean;
  /**
   * The copy names the device-local attachment store *for this host*.
   *
   * That is IndexedDB on the web, where the note editor writes image bytes to
   * IndexedDB, and the desktop app's own disk on the Electron branch, where
   * `+ Local` calls `electronKnowledgeBridge.addRoomLocalAttachment` and the
   * native host writes the file. A single store name cannot be correct for both,
   * so this is the branch's real store rather than one fixed word.
   */
  readonly namesDeviceLocalAttachmentStore: boolean;
  /** The copy says data never leaves the device. */
  readonly claimsNothingLeavesDevice: boolean;
  /** The copy mentions external images or external links. */
  readonly mentionsExternalImages: boolean;
  /** The copy discloses that external images' bytes cannot be retrieved. */
  readonly disclosesExternalByteLimit: boolean;
  /** Stable problem codes, empty when the copy is accurate. */
  readonly problems: readonly string[];
}

const NEVER_LEAVES = /nothing leaves your device|nothing ever leaves|nothing is ever sent|never sent to any server|never leaves your device|no data (?:ever )?leaves|is never uploaded|stays on your device/i;
const EXTERNAL_IMAGES = /external (?:image|images|picture|pictures|link|links|url|urls)|linked images?|images? (?:from|on) the (?:web|internet)|remote images?|images? hosted elsewhere/i;
const BYTE_DISCLOSURE =
  /(?:cannot|can not|can't|does not|doesn't|do not|don't|unable to|not able to|never)\s+(?:be\s+)?(?:retrieve|retrieved|download|downloaded|fetch|fetched|read|copied|include|includes|included|store|stored|save|saved|keep|kept)\b[^.]*bytes?\b|\bbytes?\b[^.]*(?:cannot|can not|can't|does not|doesn't|not available|unavailable|never)\b/i;
const DEVICE_LOCAL_STORE = /indexed\s*db/i;
/** The desktop host's own device-local attachment store. */
const DISK_STORE = /\bdisk\b|written to (?:this|the) (?:device|machine)/i;

export function assessPrivacyCopy(copy: string, host: 'web' | 'electron' = 'web'): PrivacyCopyVerdict {
  const namesLocalStorage = /localstorage/i.test(copy);
  const namesIndexedDb = DEVICE_LOCAL_STORE.test(copy);
  // The wrong store for the branch is worse than naming none: a notice that says
  // IndexedDB on the desktop build sends the learner looking in the wrong place
  // for their own files.
  const namesHostLocalStore = host === 'electron' ? DISK_STORE.test(copy) : namesIndexedDb;
  const namesDeviceLocalAttachmentStore = namesHostLocalStore;
  const claimsNothingLeavesDevice = NEVER_LEAVES.test(copy);
  const mentionsExternalImages = EXTERNAL_IMAGES.test(copy);
  const disclosesExternalByteLimit = BYTE_DISCLOSURE.test(copy);

  const problems: string[] = [];

  // Rule 1: once attachment bytes are device-local, `localStorage` alone is a
  // false description of where the data lives, and the real store must be named.
  if (namesLocalStorage && !namesDeviceLocalAttachmentStore) {
    problems.push('localstorage-named-as-the-only-store');
  }
  if (!namesDeviceLocalAttachmentStore) {
    problems.push('device-local-attachment-store-not-named');
  }

  // Rule 2: an absolute "nothing ever leaves this device" claim is only true
  // once no upload path exists, and it must not be asserted while one does.
  if (claimsNothingLeavesDevice) {
    problems.push('claims-nothing-leaves-device');
  }

  // Rule 3: mentioning external images without saying their bytes cannot be
  // retrieved is a silent promise that the app will fetch them.
  if (mentionsExternalImages && !disclosesExternalByteLimit) {
    problems.push('external-images-without-byte-disclosure');
  }

  return {
    namesLocalStorage,
    namesIndexedDb,
    namesDeviceLocalAttachmentStore,
    claimsNothingLeavesDevice,
    mentionsExternalImages,
    disclosesExternalByteLimit,
    problems,
  };
}

describe('Phase 4 privacy gate 5: the privacy-copy checker is not vacuous', () => {
  it('rejects the three inaccurate copy shapes and accepts the accurate one', () => {
    // 1. "localStorage alone" plus an absolute no-upload claim: today's shape.
    expect(
      assessPrivacyCopy(
        'All your data is stored in your browser (localStorage) and is never sent to any server. ' +
          'Nothing leaves your device.',
      ).problems,
    ).toEqual([
      'localstorage-named-as-the-only-store',
      'device-local-attachment-store-not-named',
      'claims-nothing-leaves-device',
    ]);

    // 2. Mentions external images but never says their bytes are unavailable.
    expect(
      assessPrivacyCopy(
        'Your notes stay in your browser. Attachments are stored in IndexedDB on this device. ' +
          'You can also link external images.',
      ).problems,
    ).toEqual(['external-images-without-byte-disclosure']);

    // 3. The accurate shape: names the real store, discloses the external
    // limitation, and makes no absolute no-upload claim.
    expect(
      assessPrivacyCopy(
        'Notes and settings are stored in your browser. Image attachments you add are stored ' +
          'on this device in IndexedDB. Links to external images are kept as links; the app ' +
          'cannot download their bytes, so a backup cannot include them.',
      ).problems,
    ).toEqual([]);

    // The verdict really discriminates rather than returning a constant.
    const tooVague = assessPrivacyCopy('Everything is stored on this device.');
    expect(tooVague.problems).toEqual(['device-local-attachment-store-not-named']);
    expect(tooVague.namesDeviceLocalAttachmentStore).toBe(false);
    expect(tooVague.claimsNothingLeavesDevice).toBe(false);

    const named = assessPrivacyCopy('Image attachments are stored in IndexedDB on this device.');
    expect(named.problems).toEqual([]);
    expect(named.namesDeviceLocalAttachmentStore).toBe(true);
    expect(named.claimsNothingLeavesDevice).toBe(false);
  });

  it('reads the real Welcome screen copy and produces the real rendered sentence', () => {
    const source = readFileSync(WELCOME_SCREEN, 'utf8');
    const web = extractPrivacyCopy(source, 'web');
    const electron = extractPrivacyCopy(source, 'electron');

    // The extraction is real, not an empty or constant string.
    expect(web.length).toBeGreaterThan(40);
    expect(web).toContain('Privacy:');
    expect(electron.length).toBeGreaterThan(40);
    expect(electron).toContain('Privacy:');

    // The two hosts genuinely resolve to different sentences, which proves the
    // ternary was interpreted rather than copied.
    expect(web).not.toBe(electron);
    expect(web).toContain('browser');
    expect(electron).toContain('local machine');
    // JSX markup never survives into the rendered sentence.
    expect(web).not.toMatch(/[<>{}]/);
  });
});

describe('Phase 4 privacy gate 5 reproduction: the shipped privacy statement', () => {
  it('the Welcome privacy statement only claims what the code honours', () => {
    // The interface this reproduction waited on: the corrected user-facing privacy
    // copy in `src/ui/screens/WelcomeScreen.tsx`. It landed with the Phase 4
    // application change that made the claims true - the note editor writes image
    // bytes to a device-local IndexedDB store instead of posting them to
    // `/api/upload`, and external attachment URLs are kept as links with no
    // bytes - so this is now a live assertion. The UI specialist may reword the
    // statement; these four rules are the contract it has to keep:
    //   * it names the device-local store for image attachments *on the branch it
    //     renders on* - IndexedDB on the web, the desktop app's disk on Electron;
    //   * it does not present `localStorage` as where everything lives;
    //   * it makes no absolute "nothing leaves your device" claim;
    //   * if it mentions external images at all, it discloses that the app
    //     cannot retrieve their bytes.
    const source = readFileSync(WELCOME_SCREEN, 'utf8');
    const web = assessPrivacyCopy(extractPrivacyCopy(source, 'web'), 'web');
    // Assessed for the branch it renders on: the desktop host writes attachments
    // through its native bridge, so naming IndexedDB there is a false statement
    // and naming the disk on the web build is equally false.
    const electron = assessPrivacyCopy(extractPrivacyCopy(source, 'electron'), 'electron');
    // Both branches name their own store, and neither names the other's.
    expect(web.namesIndexedDb, 'the web branch names IndexedDB').toBe(true);
    expect(electron.namesIndexedDb, 'the desktop branch does not claim IndexedDB').toBe(false);

    expect(web.problems, `web copy problems: ${web.problems.join(', ')}`).toEqual([]);
    expect(electron.problems, `electron copy problems: ${electron.problems.join(', ')}`).toEqual([]);
  });
});

