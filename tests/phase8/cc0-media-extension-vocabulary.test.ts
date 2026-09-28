/**
 * SERIOUS-2: an unlisted extension could carry real media past the gate.
 *
 * ## The defect
 *
 * The checker documented an invariant it did not hold: *"An unknown extension has
 * to declare which it is, so a new kind of media cannot slip in unclassified by
 * picking an unlisted suffix."* The declaration it accepted was `media: false`, and
 * nothing ever asked whether the file was actually media. A QA pass registered
 * `.svgz .aac .oga .opus .apng .jfif .pjpeg .glb .ktx2 .hdr .exr .dds .basis
 * .wav2 .md .obj` as `repository-authored` non-media, each with a correct SHA-256, a
 * CREDITS line and a refreshed count block, and the gate exited 0 sixteen times.
 * An unregistered such file also failed for the wrong reason, as
 * `E-UNREGISTERED-FILE` rather than `E-UNREGISTERED-MEDIA`.
 *
 * ## What replaced it
 *
 * A **closed extension vocabulary**. Every extension is one of three things: in
 * `MEDIA_EXTENSIONS`, in the declared `NON_MEDIA_EXTENSIONS` set, or unclassified -
 * and unclassified is a hard failure in both directions. A registered file with an
 * unclassified extension cannot say `media: false` and pass, because there is
 * nothing to check that claim against. And the extension is not the only evidence:
 * a file declared non-media whose bytes open with a known media container signature
 * fails anyway, so renaming a real image to `.md` is caught by the bytes even when
 * the suffix is a legal one.
 *
 * ## Where the two roots differ, and why
 *
 * A refusal is not a verdict, and what the gate does with one depends on whether the
 * file can reach the build. Under `public/assets/` every file is copied into `dist/`
 * verbatim, so an unclassified file there ships whatever it is and fails as media. Under
 * `src/` the bundler emits only what the module graph reaches, so a file that no module
 * names and whose suffix is unknown cannot ship; it is skipped, and skipped only after
 * its bytes have been checked against the same media signatures - the rule that a
 * renamed image is still an image does not stop at the registry boundary. Both halves
 * are asserted below, and the reachability rule itself is asserted in
 * `cc0-source-media-scope.test.ts`, which owns the source-tree scan.
 *
 * ## What is asserted here
 *
 * 1. Each of the extensions QA used is refused when registered as non-media, with a
 *    code that names the vocabulary rather than the extension.
 * 2. Each is reported as `E-UNREGISTERED-MEDIA` when it has no entry at all, so the
 *    unclassified case fails as media rather than as a stray document.
 * 3. Real container bytes wearing a legal non-media extension are refused, under the
 *    assets root and under the source root alike.
 * 4. Legitimate non-media registrations still pass - `CREDITS.md`,
 *    `asset-licenses.json`, `sprite-manifest.json`, and the committed registry - so
 *    the rule does not become a ban on documents.
 * 5. The three-way classification itself holds, so the documented invariant is now
 *    true of the code rather than only of this file.
 *
 * Privacy: no learner data is read, written, printed, or asserted on.
 *
 * Phase: 8.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MEDIA_BYTES,
  TEXT_BYTES,
  nonMediaEntry,
  registerWrittenFile,
  writeAt,
  writeSourceFile,
  type MediaFormat,
} from './cc0DefectSupport';
import { codesOf, makeFixture, runGate, type Fixture } from './support/licenseGate';

const REPO_ROOT = process.cwd();
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-cc0-assets.mjs');
const REGISTRY = path.join(REPO_ROOT, 'public', 'assets', 'asset-licenses.json');

/**
 * The sixteen suffixes from the QA reproduction.
 *
 * `.md` is included even though it is now a legal non-media extension, because the
 * interesting case for it is not the vocabulary and it is the bytes: a markdown file
 * is fine, a PNG named `.md` is not.
 */
const QA_EXTENSIONS = [
  'svgz', 'aac', 'oga', 'opus', 'apng', 'jfif', 'pjpeg', 'glb',
  'ktx2', 'hdr', 'exr', 'dds', 'basis', 'wav2', 'obj',
] as const;

const open: Fixture[] = [];
function fixture(): Fixture {
  const made = makeFixture();
  open.push(made);
  return made;
}
afterEach(() => {
  while (open.length > 0) open.pop()?.cleanup();
});

/**
 * Registers a file exactly the way the QA reproduction did: honest digest, honest
 * non-media declaration, a credits line, and a count block refreshed to match. If
 * this passes, the defect is present; there is nothing else it could be tripping on.
 */
function registerAsNonMedia(fixture: Fixture, extension: string, bytes: Buffer) {
  const relativePath = `public/assets/extra/sample.${extension}`;
  writeAt(fixture.root, relativePath, bytes);
  registerWrittenFile(fixture, nonMediaEntry(`extra-${extension}`, relativePath, bytes));
  return relativePath;
}

describe('an unclassified extension cannot be registered as non-media', () => {
  it.each(QA_EXTENSIONS)('FAILS on .%s registered as repository-authored, media: false', (extension) => {
    const made = fixture();
    const relativePath = registerAsNonMedia(made, extension, TEXT_BYTES);
    const result = made.gate();
    expect(result.code, `${extension} was accepted: ${result.output}`).toBe(1);
    // Exactly one failure, and it is the vocabulary: a test that passed for some
    // other reason would keep passing after the defect came back.
    expect(codesOf(result), extension).toEqual(['E-UNKNOWN-EXTENSION']);
    expect(result.output, extension).toContain(relativePath);
    // The message names both halves of the closed vocabulary, so the fix is to
    // classify the extension deliberately rather than to look for a flag.
    expect(result.output, extension).toMatch(/MEDIA_EXTENSIONS or NON_MEDIA_EXTENSIONS/);
  });

  it.each(QA_EXTENSIONS)('FAILS on an unregistered .%s as unregistered *media*', (extension) => {
    // The wrong-reason half of the report: an unclassified extension used to be
    // reported as a stray document, which is a claim the gate cannot support.
    const made = fixture();
    writeAt(made.root, `public/assets/extra/sample.${extension}`, TEXT_BYTES);
    const result = made.gate();
    expect(result.code, `${extension} was accepted: ${result.output}`).toBe(1);
    expect(codesOf(result), extension).toEqual(['E-UNREGISTERED-MEDIA']);
    // And the reason is stated, so a red run says why it thinks this is media.
    expect(result.output, extension).toMatch(/neither the media set nor the declared non-media set/);
  });

  it('refuses the declaration whichever way round it is written', () => {
    // `media: true` on an unclassified extension is not an escape either: the gate
    // still cannot say what the file is, and a registry that guesses is a registry
    // that can be wrong.
    const made = fixture();
    const bytes = TEXT_BYTES;
    const relativePath = 'public/assets/extra/sample.svgz';
    writeAt(made.root, relativePath, bytes);
    const entry = nonMediaEntry('extra-svgz', relativePath, bytes);
    entry.media = true;
    entry.classification = 'legacy-unverified';
    registerWrittenFile(made, entry);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result)).toContain('E-UNKNOWN-EXTENSION');
  });
});

describe('a non-media file whose bytes are media is a failure on the bytes', () => {
  const formats: readonly [MediaFormat, string][] = [
    ['png', 'PNG'],
    ['jpeg', 'JPEG'],
    ['gif', 'GIF'],
    ['ogg', 'Ogg'],
    ['webp', 'WebP'],
    ['mp4', 'MP4'],
    ['gzip', 'gzipped container'],
    ['flac', 'FLAC'],
  ];

  it.each(formats)('FAILS on %s bytes committed as a .md file', (format, label) => {
    const made = fixture();
    const bytes = MEDIA_BYTES[format];
    const relativePath = registerAsNonMedia(made, 'md', bytes);
    const result = made.gate();
    expect(result.code, `${format} as .md was accepted: ${result.output}`).toBe(1);
    expect(codesOf(result), format).toContain('E-MEDIA-SIGNATURE');
    // The message names the format it recognised, so the author is not left
    // guessing which file the gate thinks is a picture.
    expect(result.output, format).toContain(label);
    expect(result.output, format).toContain(relativePath);
  });

  it.each(formats)('FAILS on %s bytes committed as a .json file', (format, label) => {
    const made = fixture();
    registerAsNonMedia(made, 'json', MEDIA_BYTES[format]);
    const result = made.gate();
    expect(result.code, `${format} as .json was accepted: ${result.output}`).toBe(1);
    expect(codesOf(result), format).toContain('E-MEDIA-SIGNATURE');
    expect(result.output, format).toContain(label);
  });

  it('accepts a genuine text document, so the rule is not a ban on documents', () => {
    // The other half of the guarantee. A credits page, a registry, a module: none of
    // them open with a container signature, and a gate that failed on them would be
    // switched off within a week.
    const made = fixture();
    registerAsNonMedia(made, 'md', Buffer.from('# Fixture notes\n\nNo picture here.\n', 'utf8'));
    registerAsNonMedia(made, 'txt', Buffer.from('plain text\n', 'utf8'));
    const result = made.gate();
    expect(result.code, result.output).toBe(0);
    expect(codesOf(result), result.output).toEqual([]);
  });

  it('a non-media file with media bytes is still caught when its suffix is legal but its class is not', () => {
    // `media: false` on a legal suffix is only honest if the bytes agree. A
    // `legacy-unverified` file that is secretly a PNG is the same smuggling with a
    // more respectable class attached.
    const made = fixture();
    const relativePath = 'public/assets/sprites/smuggled.png';
    writeAt(made.root, relativePath, MEDIA_BYTES.png);
    const entry = nonMediaEntry('smuggled', relativePath, MEDIA_BYTES.png);
    entry.media = false;
    registerWrittenFile(made, entry);
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    // The extension and the flag disagree first, and the bytes say why they do.
    expect(codesOf(result)).toContain('E-MEDIA-FLAG');
    expect(codesOf(result)).toContain('E-MEDIA-SIGNATURE');
  });
});

describe('the closed vocabulary holds in the source tree too', () => {
  it('FAILS on a registered src/ file whose extension is unclassified', () => {
    // The registry rule, applied under the other registrable root. A `media: false`
    // entry is a *claim* about the file, and there is nothing to check it against when
    // the suffix is unknown - so the claim is refused here as it is under the assets
    // root. Note that this fires independently of the source-root scan: a file that has
    // been registered has had its kind asserted, and an assertion is exactly what the
    // closed vocabulary exists to police.
    const made = fixture();
    const bytes = TEXT_BYTES;
    const relativePath = 'src/notes/room.svgz';
    writeSourceFile(made, relativePath, bytes);
    registerWrittenFile(made, nonMediaEntry('src-notes', relativePath, bytes));
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result), result.output).toContain('E-UNKNOWN-EXTENSION');
    expect(result.output).toContain(relativePath);
  });

  it('FAILS on a registered src/ file whose media bytes contradict a legal non-media suffix', () => {
    // The bytes are a fact about the file, and a file under `src/` is no different from
    // one under the assets root: renaming it does not make it a document. This is the
    // same check the source-tree skip leans on - a name the gate cannot classify is only
    // skipped once the gate has looked at what it actually is - so the two have to agree
    // about the answer.
    const made = fixture();
    const bytes = MEDIA_BYTES.png;
    const relativePath = 'src/notes/room.png';
    writeSourceFile(made, relativePath, bytes);
    registerWrittenFile(made, nonMediaEntry('src-notes', relativePath, bytes));
    const result = made.gate();
    expect(result.code, result.output).toBe(1);
    expect(codesOf(result), result.output).toContain('E-MEDIA-SIGNATURE');
    expect(codesOf(result), result.output).toContain('E-MEDIA-FLAG');
    expect(result.output).toContain('PNG');
  });
});

describe('the closed vocabulary holds for the repository as it stands', () => {
  it('the committed registry still passes, documents and all', () => {
    const result = runGate();
    expect(result.code, result.output).toBe(0);
    expect(codesOf(result), result.output).toEqual([]);
  });

  it('every non-media entry in the committed registry is legal under the vocabulary', () => {
    const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as {
      assets: { id?: string; path?: string; media?: boolean }[];
    };
    const nonMedia = registry.assets.filter((entry) => entry.media === false);
    // The three documents the registry has to describe to describe itself. If this
    // count moves, the new file is either a fourth document - fine, and it is
    // asserted here - or media wearing a document extension, which is not.
    expect(nonMedia.map((entry) => entry.path).sort()).toEqual([
      'public/assets/CREDITS.md',
      'public/assets/asset-licenses.json',
      'public/assets/sprite-manifest.json',
    ]);
  });

  it('the gate declares both halves of the vocabulary and refuses by default', () => {
    // The documented invariant has to be true of the code, not only of this file: an
    // extension is classified, or the run fails. The three-way classification is
    // asserted here by the shape of the one function every rule shares.
    const source = readFileSync(CHECKER, 'utf8');
    expect(source).toContain('const MEDIA_EXTENSIONS = new Set([');
    expect(source).toContain('const NON_MEDIA_EXTENSIONS = new Set([');
    const classify = /function extensionClass\(assetPath\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    expect(classify, 'the checker has no extensionClass function').not.toBe('');
    expect(classify).toMatch(/return 'media'/);
    expect(classify).toMatch(/return 'non-media'/);
    expect(classify, 'an unclassified extension has no outcome of its own').toMatch(/return 'unclassified'/);
    // And the comment that made the false promise is gone: the closed vocabulary is
    // documented as the reason an unlisted suffix cannot be used.
    expect(source).not.toMatch(
      /An unknown extension has to declare which it is, so a new kind of\s+media cannot slip in unclassified/,
    );
  });

  it('the media set the gate still declares is the one the QA pass pinned', () => {
    // This file does not widen it. The fix is the closed vocabulary, not a longer
    // list, so the pin `qa-verification.test.ts` holds at 25 stands unchanged.
    const source = readFileSync(CHECKER, 'utf8');
    const block = /const MEDIA_EXTENSIONS = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1] ?? '';
    const declared = [...block.matchAll(/'([a-z0-9]+)'/g)].map((match) => match[1]);
    expect(declared.length, 'the media set changed size').toBe(25);
  });
});
