/**
 * Phase 10: custom sprite override admission, and blob URL lifetime.
 *
 * ## What this file is for
 *
 * Phase 10's scope bullet is "validate custom sprite overrides and revoke blob URLs
 * correctly", and `src/services/customSprites.ts` was wrong on both counts in ways
 * that only show up under repetition. The old `resolveSpriteUrl` minted a fresh
 * `URL.createObjectURL` on *every* call into a module-level `Set` that only
 * `revokeAllBlobUrls` ever drained, so a scene that re-resolved a sprite during a
 * restart leaked a URL per call. And `saveCustomSpriteContent` admitted anything
 * beginning `<svg`, deferring the real check to the render path - which then *deleted
 * the stored sprite* when the check failed. That is the half-registered override: the
 * write succeeded, the value was unusable, and the learner's work was destroyed by
 * drawing a frame.
 *
 * Every assertion below is therefore about an exit path. A blob URL has exactly four:
 * replacement, per-sprite reset, bulk reset, and service teardown - plus the rule that
 * cuts across all of them, which is that none of them may revoke while a texture is
 * still using the URL.
 *
 * ## How `URL.createObjectURL` is observed
 *
 * jsdom does not implement it, so it is installed here as a counter, and the counter
 * is the whole instrument: a leaked blob is invisible to every other assertion in the
 * repository, and a `Set` that only grows is exactly what this file exists to catch.
 *
 * ## Hermeticity and privacy
 *
 * No network, no `dist/`, no git, no clock, no Electron. State is `localStorage` plus
 * the object-URL counter, both cleared in `afterEach`. The paths used are the
 * repository's own sprite paths; no learner data is written, read, or asserted on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_CUSTOM_SPRITE_OVERRIDE_BYTES,
  admitCustomSpriteOverride,
  discardCustomSpriteContent,
  disposeCustomSpriteOverrides,
  getCustomSpriteContent,
  listCustomSpritePaths,
  resolveSpriteUrl,
  resetAllCustomSprites,
  resetCustomSpriteContent,
  retainCustomSpriteUrl,
  revokeAllBlobUrls,
  saveCustomSpriteContent,
} from '@/services/customSprites';

const SPRITE = 'sprites/npc-scribe.svg';
const OTHER_SPRITE = 'sprites/npc-keeper.svg';

const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>';
const OTHER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>';
/** Parses as XML, and its document element is not an image. */
const XML_BUT_NOT_IMAGE = '<?xml version="1.0"?><html><body>not an image</body></html>';

let created: string[];
let revoked: string[];
let createCounter: number;
const nativeCreate = (URL as unknown as Record<string, unknown>)['createObjectURL'];
const nativeRevoke = (URL as unknown as Record<string, unknown>)['revokeObjectURL'];

beforeEach(() => {
  created = [];
  revoked = [];
  createCounter = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (): string => {
      createCounter += 1;
      const url = `blob:synthetic/${createCounter}`;
      created.push(url);
      return url;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string): void => {
      revoked.push(url);
    },
  });
  localStorage.clear();
  disposeCustomSpriteOverrides();
});

afterEach(() => {
  disposeCustomSpriteOverrides();
  localStorage.clear();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: nativeCreate,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: nativeRevoke,
  });
});

/** Revocations of a given URL, which is the property "exactly once" is about. */
function timesRevoked(url: string): number {
  return revoked.filter((entry) => entry === url).length;
}

describe('an override is admitted before it is written, or not written at all', () => {
  it('a well-formed SVG is admitted, with its byte length and media type', () => {
    const admission = admitCustomSpriteOverride(GOOD_SVG);
    expect(admission.admitted).toBe(true);
    expect(admission.rejection).toBeNull();
    expect(admission.mediaType).toBe('image/svg+xml');
    expect(admission.byteLength).toBe(GOOD_SVG.length);
  });

  it('every refusal names a reason, and a parse is not enough on its own', () => {
    // The last case is the one a parse-only check would let through: well-formed XML
    // whose root is `<html>` parses cleanly and loads as a texture of nothing.
    const cases: ReadonlyArray<[string, unknown, string]> = [
      ['not a string', 42, 'not-an-image'],
      ['empty', '   ', 'empty'],
      ['not image-shaped', 'hello', 'not-an-image'],
      ['unparseable', '<svg><rect></svg>', 'malformed-image'],
      ['parses but is not an image', XML_BUT_NOT_IMAGE, 'no-image-root'],
      ['over the size limit', `<svg>${'x'.repeat(MAX_CUSTOM_SPRITE_OVERRIDE_BYTES + 1)}</svg>`, 'too-large'],
    ];
    for (const [what, content, expected] of cases) {
      const admission = admitCustomSpriteOverride(content);
      expect(admission.admitted, what).toBe(false);
      expect(admission.rejection, what).toBe(expected);
      expect(admission.mediaType, what).toBeNull();
    }
  });

  it('a refused save writes nothing and destroys nothing that was already there', () => {
    // The half-registered override, stated as an assertion. A rejected write must
    // leave the store byte-identical, including a previous good value, because the
    // caller is going to retry.
    expect(saveCustomSpriteContent(SPRITE, GOOD_SVG)).toBe(true);
    const stored = getCustomSpriteContent(SPRITE);

    expect(saveCustomSpriteContent(SPRITE, '<svg><rect></svg>')).toBe(false);
    expect(getCustomSpriteContent(SPRITE), 'the good override survived a refused save').toBe(stored);
    expect(localStorage.length, 'nothing was half-written').toBe(1);
  });

  it('a refused save creates no URL and revokes none', () => {
    saveCustomSpriteContent(SPRITE, '<svg><rect></svg>');
    resolveSpriteUrl(SPRITE);
    expect(created, 'a refused override is never turned into a blob').toEqual([]);
    expect(revoked).toEqual([]);
  });
});

describe('a blob URL is one per (sprite, content), not one per call', () => {
  it('resolving the same unchanged override twice creates one URL and returns the same string', () => {
    // The leak. The old `resolveSpriteUrl` called `createObjectURL` on every
    // invocation and pushed the result into a set nothing drained until teardown, so a
    // scene re-resolving a sprite on a restart leaked one URL per call.
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    const first = resolveSpriteUrl(SPRITE);
    const second = resolveSpriteUrl(SPRITE);
    const third = resolveSpriteUrl(SPRITE);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(created).toHaveLength(1);
  });

  it('two sprites are two URLs, and they are independent', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    saveCustomSpriteContent(OTHER_SPRITE, OTHER_SVG);
    const a = resolveSpriteUrl(SPRITE);
    const b = resolveSpriteUrl(OTHER_SPRITE);
    expect(a).not.toBe(b);
    expect(created).toHaveLength(2);
    expect(listCustomSpritePaths().sort()).toEqual([SPRITE, OTHER_SPRITE].sort());
  });

  it('a sprite with no override resolves to the bundled path and makes no URL', () => {
    expect(resolveSpriteUrl(SPRITE)).toBe('/assets/sprites/npc-scribe.svg');
    expect(created).toEqual([]);
  });
});

describe('every exit path revokes exactly once', () => {
  it('replacement revokes the superseded URL, and only that one', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    const first = resolveSpriteUrl(SPRITE);

    saveCustomSpriteContent(SPRITE, OTHER_SVG);
    const second = resolveSpriteUrl(SPRITE);

    expect(second, 'a changed override gets a new URL').not.toBe(first);
    expect(timesRevoked(first), 'the superseded URL is revoked on replacement').toBe(1);
    expect(timesRevoked(second), 'the live URL is not touched').toBe(0);
  });

  it('re-saving the same content is not a replacement, so nothing is revoked', () => {
    // A save is not a load. Revoking on an identical write would invalidate a texture
    // that is holding the very same bytes.
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    const url = resolveSpriteUrl(SPRITE);
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    expect(timesRevoked(url)).toBe(0);
    expect(resolveSpriteUrl(SPRITE)).toBe(url);
  });

  it('a per-sprite reset revokes that sprite and leaves the other alone', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    saveCustomSpriteContent(OTHER_SPRITE, OTHER_SVG);
    const a = resolveSpriteUrl(SPRITE);
    const b = resolveSpriteUrl(OTHER_SPRITE);

    resetCustomSpriteContent(SPRITE);
    expect(timesRevoked(a)).toBe(1);
    expect(timesRevoked(b)).toBe(0);
    expect(getCustomSpriteContent(SPRITE)).toBeNull();
  });

  it('a bulk reset revokes every sprite, once each', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    saveCustomSpriteContent(OTHER_SPRITE, OTHER_SVG);
    const urls = [resolveSpriteUrl(SPRITE), resolveSpriteUrl(OTHER_SPRITE)];

    resetAllCustomSprites();
    for (const url of urls) expect(timesRevoked(url)).toBe(1);
    expect(listCustomSpritePaths()).toEqual([]);
  });

  it('the teardown sweep revokes everything once, and is safe to run twice', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    saveCustomSpriteContent(OTHER_SPRITE, OTHER_SVG);
    const urls = [resolveSpriteUrl(SPRITE), resolveSpriteUrl(OTHER_SPRITE)];

    revokeAllBlobUrls();
    revokeAllBlobUrls();
    // The Phaser adapters call this between a teardown and the next load, so the
    // double call is the ordinary case and the pre-Phase-10 behaviour was to revoke
    // everything exactly once and clear the registry.
    for (const url of urls) expect(timesRevoked(url)).toBe(1);
    expect(revoked).toHaveLength(urls.length);
  });

  it('a service teardown clears the registry, so the next resolve starts fresh', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    const before = resolveSpriteUrl(SPRITE);
    disposeCustomSpriteOverrides();
    const after = resolveSpriteUrl(SPRITE);
    expect(after).not.toBe(before);
    expect(timesRevoked(before)).toBe(1);
    expect(timesRevoked(after)).toBe(0);
  });
});

describe('a URL is never revoked while a texture is still using it', () => {
  it('a reset with a lease outstanding defers the revocation to the release', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    const url = resolveSpriteUrl(SPRITE);
    const release = retainCustomSpriteUrl(SPRITE);
    expect(release, 'a live URL can be leased').not.toBeNull();

    resetCustomSpriteContent(SPRITE);
    expect(timesRevoked(url), 'a held URL survives a reset').toBe(0);

    (release as () => void)();
    expect(timesRevoked(url), 'and is revoked by the last release').toBe(1);
  });

  it('the teardown sweep also defers, and a second lease needs both releases', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    const url = resolveSpriteUrl(SPRITE);
    const first = retainCustomSpriteUrl(SPRITE) as () => void;
    const second = retainCustomSpriteUrl(SPRITE) as () => void;

    revokeAllBlobUrls();
    expect(timesRevoked(url)).toBe(0);
    first();
    expect(timesRevoked(url), 'one lease is not the last lease').toBe(0);
    second();
    expect(timesRevoked(url)).toBe(1);
  });

  it('a release is idempotent, so a double release cannot double-revoke', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    const url = resolveSpriteUrl(SPRITE);
    const release = retainCustomSpriteUrl(SPRITE) as () => void;
    revokeAllBlobUrls();
    release();
    release();
    release();
    expect(timesRevoked(url)).toBe(1);
  });

  it('a lease on a retired URL is refused rather than resurrecting it', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    const url = resolveSpriteUrl(SPRITE);
    resetCustomSpriteContent(SPRITE);
    expect(timesRevoked(url)).toBe(1);
    expect(retainCustomSpriteUrl(SPRITE), 'the URL is gone, so there is nothing to lease').toBeNull();
  });

  it('a sprite with no override has nothing to lease', () => {
    expect(retainCustomSpriteUrl(SPRITE)).toBeNull();
  });
});

describe('a stored override that will not load falls back without destroying itself', () => {
  it('resolveSpriteUrl falls back to the bundled file and leaves the store alone', () => {
    // The one behaviour this phase changed on purpose, and the reason is in the file:
    // a render path is not allowed to delete a learner's work. A value that got into
    // the store by some earlier means - an older build, a hand-edited store, a quota
    // eviction mid-write - is the learner's, not the renderer's to discard.
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    localStorage.setItem(`knowledge-dungeon:custom-sprites:override:${SPRITE}`, '<svg><rect></svg>');

    expect(resolveSpriteUrl(SPRITE)).toBe('/assets/sprites/npc-scribe.svg');
    expect(created).toEqual([]);
    expect(getCustomSpriteContent(SPRITE), 'the unusable value is still there to be read').toBe(
      '<svg><rect></svg>',
    );
    expect(timesRevoked(resolveSpriteUrl(SPRITE))).toBe(0);
  });

  it('discardCustomSpriteContent is the explicit self-heal, and it revokes', () => {
    saveCustomSpriteContent(SPRITE, GOOD_SVG);
    const url = resolveSpriteUrl(SPRITE);
    localStorage.setItem(`knowledge-dungeon:custom-sprites:override:${SPRITE}`, '<svg><rect></svg>');

    discardCustomSpriteContent(SPRITE);
    expect(getCustomSpriteContent(SPRITE)).toBeNull();
    expect(timesRevoked(url), 'the URL the good content was served from is gone too').toBe(1);
    expect(resolveSpriteUrl(SPRITE)).toBe('/assets/sprites/npc-scribe.svg');
  });
});

describe('the one creation site is still one', () => {
  it('customSprites.ts calls createObjectURL exactly once, and revokeObjectURL once', async () => {
    // Not tidiness. `tests/data/localDownloadOnly.test.ts` pins this module at exactly
    // one `createObjectURL` call site, so "revoke on every exit path" has to be
    // expressed as one call in one place rather than as four copies of the same call.
    // A second one would be a red Phase 5 gate, in a phase that has nothing to do with
    // sprite customisation.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/services/customSprites.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
    expect([...source.matchAll(/\bcreateObjectURL\s*\(/g)], 'createObjectURL call sites').toHaveLength(1);
    expect([...source.matchAll(/\brevokeObjectURL\s*\(/g)], 'revokeObjectURL call sites').toHaveLength(1);
  });
});
