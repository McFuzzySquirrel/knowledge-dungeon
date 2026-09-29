/**
 * Custom sprite persistence service.
 *
 * Handles saving, loading, resetting, and pack management for user-customized
 * sprite SVGs. Uses localStorage for web builds and Electron IPC for desktop.
 * Provides the `resolveSpriteUrl()` function that Phaser scenes use to get
 * the correct sprite URL (custom override or bundled fallback).
 *
 * ## Phase 10: admission and blob URL lifetime
 *
 * Phase 10's scope bullet is "validate custom sprite overrides and revoke blob URLs
 * correctly", and both halves of it were wrong before this phase. What changed, and
 * what was left alone, is worth writing down because the *shape* of the fix is the
 * point:
 *
 * 1. **A blob URL is created per (sprite, content), not per call.** `resolveSpriteUrl`
 *    used to call `URL.createObjectURL` on every invocation and push the result into a
 *    module-level `Set` that only `revokeAllBlobUrls` ever drained. A scene that
 *    resolves the same sprite during a restart, a structure rebuild, or a re-enter
 *    therefore leaked a URL per call, and the set grew for the life of the tab. It is
 *    now a **content generation**: one URL per (sprite path, stored content), reused
 *    while the content is unchanged, and retired the moment the content is replaced,
 *    reset, or the service is torn down.
 * 2. **Admission happens before the write, not at render time.** `saveCustomSpriteContent`
 *    used to admit anything beginning `<svg` or `<?xml` and defer every real check to
 *    `resolveSpriteUrl`, which then *deleted the stored sprite* when the check failed.
 *    That is the half-registered override the scope bullet names: the write succeeded,
 *    the value was unusable, and the user's work was destroyed by a render. Validation
 *    now runs in {@link admitCustomSpriteOverride} before `localStorage` is touched, so
 *    a rejected override is never written and never destroys the good one it would
 *    have replaced.
 * 3. **A URL is never revoked while a texture is still using it.** `revokeAllBlobUrls`
 *    used to revoke unconditionally, which is right for a Phaser scene that has just
 *    been torn down and wrong for anything else. Retirement is now two-phase: the URL
 *    is marked retired, and the actual `URL.revokeObjectURL` happens when the last
 *    {@link retainCustomSpriteUrl} lease is dropped. With no leases - the Phaser path,
 *    which has no way to express one - the behaviour is byte-for-byte what it was.
 * 4. **One creation site, one revocation site.** Both `URL.createObjectURL` and
 *    `URL.revokeObjectURL` appear exactly once in this file. That is not tidiness:
 *    `tests/data/localDownloadOnly.test.ts` pins this module at exactly one
 *    `createObjectURL` call site and fails if a second appears anywhere in the graph
 *    reachable from `src/main.tsx`, so "revoke on every exit path" has to be expressed
 *    as one call in one place rather than as four copies of the same call.
 *
 * What did **not** change: the storage keys, the exported signatures' behaviour, the
 * bundled-path fallback, and the fact that a scene asks for a URL and gets a string.
 * `tests/phase10/custom-sprite-overrides.test.ts` pins each of those, including the
 * one behaviour that did change on purpose - a malformed stored override now falls
 * back to the bundled file *without* deleting itself, and
 * {@link discardCustomSpriteContent} is the explicit self-heal for a store written by
 * an older build.
 */
import { isElectronAvailable } from '@/services/electronBridge';
import type { SpriteAnimationConfig } from '@/ui/components/SpriteEditor';

const STORAGE_PREFIX = 'knowledge-dungeon';
const OVERRIDE_KEY_PREFIX = `${STORAGE_PREFIX}:custom-sprites:override:`;
const ANIM_KEY_PREFIX = `${STORAGE_PREFIX}:custom-sprites:anim:`;
const PACKS_KEY = `${STORAGE_PREFIX}:custom-sprites:packs`;

export interface CustomSpritePack {
  name: string;
  author?: string;
  description?: string;
  version: string;
  createdAt: string;
  gameVersion: string;
  sprites: Record<string, string>;
}

interface StoredPacks {
  packs: CustomSpritePack[];
  activePack: string | null;
}

function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota exceeded or privacy mode - non-fatal
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// Per-sprite overrides
// ---------------------------------------------------------------------------

function overrideKey(spritePath: string): string {
  return `${OVERRIDE_KEY_PREFIX}${spritePath}`;
}

/**
 * Get the stored SVG content for a custom sprite, or null if not customized.
 */
export function getCustomSpriteContent(spritePath: string): string | null {
  if (!hasLocalStorage()) return null;
  return safeGet(overrideKey(spritePath));
}

/**
 * Store a custom SVG override for a sprite.
 *
 * Returns whether the override was admitted and written. Phase 10 changed the
 * signature from `void` for that reason and nothing else: the old body wrote whatever
 * began `<svg` and left every real check to the render path, which is the
 * half-registered override the scope bullet names. Every existing caller ignores the
 * result, so this is additive.
 *
 * A refusal is a **no-write**, not a partial write: the store keeps whatever it held,
 * including a previous good override, and no URL is retired. All-or-nothing is the
 * property that makes a failed save safe to retry.
 */
export function saveCustomSpriteContent(spritePath: string, svgContent: string): boolean {
  if (!hasLocalStorage()) return false;
  if (!admitCustomSpriteOverride(svgContent).admitted) return false;
  const previous = safeGet(overrideKey(spritePath));
  if (previous === svgContent) return true;
  safeSet(overrideKey(spritePath), svgContent);
  // The stored content for this sprite has changed, so the URL the old content was
  // served from is stale. Retiring it here rather than at the next resolve is what
  // makes "revoked on replacement" true even if nothing ever asks for the sprite
  // again.
  //
  // An identical re-save is not a replacement. The editor writes on every keystroke,
  // so "save the same bytes again" is the ordinary case rather than an edge one, and
  // revoking there would invalidate a live texture over nothing.
  retireGeneration(currentGenerations.get(spritePath));
  return true;
}

/**
 * Delete a custom sprite override (restores to bundled original).
 *
 * Also retires the blob URL the override was being served from, which the old body
 * did not: a reset used to leave the URL alive until the next full teardown, which on
 * a learner who customises and resets the same sprite a few times is a handful of
 * blobs per session.
 */
export function resetCustomSpriteContent(spritePath: string): void {
  safeRemove(overrideKey(spritePath));
  retireGeneration(currentGenerations.get(spritePath));
}

/**
 * List all sprite paths that have custom overrides.
 */
export function listCustomSpritePaths(): string[] {
  if (!hasLocalStorage()) return [];
  const results: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(OVERRIDE_KEY_PREFIX)) {
      results.push(key.slice(OVERRIDE_KEY_PREFIX.length));
    }
  }
  return results;
}

/**
 * Reset all custom sprites to bundled originals.
 *
 * Not short-circuited on the absence of `localStorage` any more. The store may be
 * gone while the module's URL state is not - a private-mode tab, a quota eviction, an
 * Electron IPC path - and the URLs are the larger of the two.
 */
export function resetAllCustomSprites(): void {
  for (const path of listCustomSpritePaths()) {
    safeRemove(overrideKey(path));
    retireGeneration(currentGenerations.get(path));
  }
}

// ---------------------------------------------------------------------------
// Per-sprite animation config storage
// ---------------------------------------------------------------------------

function animKey(spritePath: string): string {
  return `${ANIM_KEY_PREFIX}${spritePath}`;
}

/**
 * Get the stored animation config for a sprite, or a default 'none' config.
 */
export function getAnimationConfig(spritePath: string): SpriteAnimationConfig {
  if (!hasLocalStorage()) return { type: 'none' };
  try {
    const raw = localStorage.getItem(animKey(spritePath));
    if (raw) return JSON.parse(raw) as SpriteAnimationConfig;
  } catch { /* ignore */ }
  return { type: 'none' };
}

/**
 * Store an animation config for a sprite.
 */
export function saveAnimationConfig(spritePath: string, config: SpriteAnimationConfig): void {
  if (!hasLocalStorage()) return;
  safeSet(animKey(spritePath), JSON.stringify(config));
}

/**
 * Remove the animation config for a sprite.
 */
export function deleteAnimationConfig(spritePath: string): void {
  if (!hasLocalStorage()) return;
  safeRemove(animKey(spritePath));
}

/**
 * List all sprite paths that have animation configs.
 */
export function listAnimationSpritePaths(): string[] {
  if (!hasLocalStorage()) return [];
  const results: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(ANIM_KEY_PREFIX)) {
      results.push(key.slice(ANIM_KEY_PREFIX.length));
    }
  }
  return results;
}

/**
 * Reset all animation configs to default (none).
 */
export function resetAllAnimationConfigs(): void {
  const paths = listAnimationSpritePaths();
  for (const path of paths) {
    safeRemove(animKey(path));
  }
}

// ---------------------------------------------------------------------------
// Override admission
// ---------------------------------------------------------------------------

/**
 * The largest override this service will admit, in UTF-8 bytes.
 *
 * 256 KiB is chosen for two reasons that pull the same way. It is three orders of
 * magnitude above any hand-authored 32x32 sprite SVG, so it never rejects real work;
 * and it is a small fraction of the smallest `localStorage` quota any supported
 * browser enforces, so an override that passes cannot be the thing that fills the
 * store and takes a learner's notes down with it. The number is exported so the
 * editor and the tests read the same one.
 */
export const MAX_CUSTOM_SPRITE_OVERRIDE_BYTES = 256 * 1024;

/**
 * The one media type an override may be.
 *
 * `customSprites` stores text, and both renderers load it as SVG. Admitting a
 * raster type here would mean a base64 data URL in `localStorage` and a second
 * decode path, which is a different feature with a different size budget rather than
 * a wider version of this one. The list is a list so widening it later is a reviewed
 * act rather than an accident.
 */
const ADMISSIBLE_OVERRIDE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/svg+xml']);

/** Why an override was refused. Closed, so a caller can act on each case by name. */
export type CustomSpriteOverrideRejection =
  /** Not a string, or empty once trimmed. */
  | 'empty'
  /** Does not begin like an image document. */
  | 'not-an-image'
  /** Larger than {@link MAX_CUSTOM_SPRITE_OVERRIDE_BYTES}. */
  | 'too-large'
  /** The realm has no image parser, so nothing can be verified. */
  | 'unavailable'
  /** Will not parse as `image/svg+xml`. */
  | 'malformed-image'
  /** Parses, but the document element is not an `<svg>`. */
  | 'no-image-root';

export interface CustomSpriteOverrideAdmission {
  readonly admitted: boolean;
  readonly rejection: CustomSpriteOverrideRejection | null;
  readonly byteLength: number;
  /** The media type the content was admitted as, or `null` when refused. */
  readonly mediaType: string | null;
}

function refuse(rejection: CustomSpriteOverrideRejection, byteLength: number): CustomSpriteOverrideAdmission {
  return Object.freeze({ admitted: false, rejection, byteLength, mediaType: null });
}

/**
 * Decide whether a candidate override may be stored, before anything is written.
 *
 * Pure: it reads its argument and returns a verdict, so the gate can be exercised
 * without a store, and so a rejection can never leave a half-written override behind
 * for want of an ordering accident. Three checks, in the order that produces the most
 * useful refusal first - cheap shape, then size, then a real parse:
 *
 * - it must begin like an image document, which is the shape `resolveSpriteUrl` and
 *   both loaders already assume;
 * - it must fit the size limit, because an unbounded string into `localStorage` and
 *   then into a blob is a memory cost with no ceiling;
 * - it must parse as `image/svg+xml` **and** have an `<svg>` document element. A
 *   parse check alone is not enough: a well-formed XML document whose root is `<html>`
 *   parses, and a loader handed that produces a texture of nothing.
 *
 * The parse deliberately says nothing about scripts or external references. An
 * override is served as a blob URL to an image decoder, which does not execute
 * script, and `SpriteEditor.sanitizeSvg` already strips `<script>` at the authoring
 * edge. Re-implementing a sanitiser here would be a second policy with its own
 * drift, and the admission question is narrower than that.
 */
export function admitCustomSpriteOverride(content: unknown): CustomSpriteOverrideAdmission {
  if (typeof content !== 'string') return refuse('not-an-image', 0);
  const trimmed = content.trim();
  if (trimmed.length === 0) return refuse('empty', 0);
  if (!trimmed.startsWith('<svg') && !trimmed.startsWith('<?xml')) return refuse('not-an-image', 0);

  const byteLength = new TextEncoder().encode(content).length;
  if (byteLength > MAX_CUSTOM_SPRITE_OVERRIDE_BYTES) return refuse('too-large', byteLength);

  if (typeof DOMParser !== 'function') return refuse('unavailable', byteLength);
  let document_: XMLDocument;
  try {
    document_ = new DOMParser().parseFromString(trimmed, 'image/svg+xml');
  } catch {
    return refuse('malformed-image', byteLength);
  }
  // `querySelector` rather than a try: jsdom and every browser report a parse failure
  // as a `parsererror` element inside a successful document, so the call throws for a
  // different reason and would swallow a second, real failure.
  if (document_.querySelector('parsererror') !== null) return refuse('malformed-image', byteLength);
  const root = document_.documentElement;
  if (root === null || root.localName !== 'svg') return refuse('no-image-root', byteLength);

  const mediaType = 'image/svg+xml';
  if (!ADMISSIBLE_OVERRIDE_MEDIA_TYPES.has(mediaType)) return refuse('not-an-image', byteLength);
  return Object.freeze({ admitted: true, rejection: null, byteLength, mediaType });
}

// ---------------------------------------------------------------------------
// Sprite URL resolution
// ---------------------------------------------------------------------------

/**
 * One live blob URL for one stored override.
 *
 * A *generation*: the pair of a sprite path and the exact content it was created
 * from. Two generations for the same path never coexist - a replacement retires the
 * one it supersedes - and a generation is revoked exactly once, because `retired` is
 * the flag that says so and the revocation helper checks it before doing anything.
 */
interface CustomSpriteUrlGeneration {
  readonly spritePath: string;
  readonly content: string;
  readonly url: string;
  /** Outstanding leases. A retired generation is not revoked while this is above zero. */
  retains: number;
  /** No longer the answer for its sprite: replaced, reset, or swept. */
  retired: boolean;
  /**
   * `URL.revokeObjectURL` has been called for this URL.
   *
   * Separate from `retired` because the two happen at different times and confusing
   * them is a silent leak. Retirement is the decision - "this is no longer the answer"
   * - and revocation is the act, which waits for the last lease. The first version
   * of this file had one flag for both, and the revocation checked it, so a
   * generation marked retired by the very function that meant to revoke it was never
   * revoked at all: the blob stayed alive for the life of the tab on every one of the
   * four exit paths.
   */
  revoked: boolean;
}

/** The current generation per sprite path. */
const currentGenerations = new Map<string, CustomSpriteUrlGeneration>();
/** Retired generations still waiting on a lease. Bounded by the number of live leases. */
const pendingRevocations = new Set<CustomSpriteUrlGeneration>();

/**
 * The one place this file creates an object URL.
 *
 * See point 4 in the module header: `tests/data/localDownloadOnly.test.ts` pins this
 * module at exactly one `createObjectURL` call site, and every exit path that has to
 * revoke has to route through the one place that creates.
 */
function createOverrideUrl(content: string): string {
  return URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }));
}

/**
 * Revoke a generation, if nothing is still holding it.
 *
 * The `retired` check at the top is what makes "exactly once" a property of the code
 * rather than of the order its callers happen to run in: a second call is a no-op
 * even if the first one already revoked.
 */
function revokeGeneration(generation: CustomSpriteUrlGeneration | undefined): void {
  if (generation === undefined || generation.revoked || generation.retains > 0) return;
  generation.revoked = true;
  pendingRevocations.delete(generation);
  if (currentGenerations.get(generation.spritePath) === generation) {
    currentGenerations.delete(generation.spritePath);
  }
  URL.revokeObjectURL(generation.url);
}

/**
 * Mark a generation as no longer the answer for its sprite, and revoke it if free.
 *
 * Called from every exit path: replacement, per-sprite reset, bulk reset, and service
 * teardown.
 */
function retireGeneration(generation: CustomSpriteUrlGeneration | undefined): void {
  if (generation === undefined || generation.retired) return;
  generation.retired = true;
  if (generation.retains > 0) {
    pendingRevocations.add(generation);
    return;
  }
  revokeGeneration(generation);
}

/**
 * The URL for a sprite's current override content, creating one only if needed.
 *
 * Repeated calls for unchanged content return the same string. That is the leak fix,
 * and it is also why the content is compared rather than a version counter: a counter
 * would have to be kept in step with `localStorage`, and `localStorage` is writable
 * from another tab.
 */
function acquireOverrideUrl(spritePath: string, content: string): string {
  const current = currentGenerations.get(spritePath);
  if (current !== undefined && !current.retired && current.content === content) return current.url;
  const next: CustomSpriteUrlGeneration = {
    spritePath,
    content,
    url: createOverrideUrl(content),
    retains: 0,
    retired: false,
    revoked: false,
  };
  currentGenerations.set(spritePath, next);
  // Superseded, not deleted: if something still holds the old URL it is revoked when
  // the last lease goes, and not before.
  retireGeneration(current);
  return next.url;
}

/**
 * Take a lease on a sprite's current override URL.
 *
 * `revokeAllBlobUrls` and a reset will not revoke a leased URL; the revocation
 * happens when the returned function is called and it was the last lease. Returns
 * `null` when there is no live generation, which is the answer for a sprite with no
 * override as much as for one that was just reset.
 *
 * Phase 10 exposes this and stops there. The Pixi consumer is a Phase 11 world
 * scene, which is the first caller that can say when its texture is finished; the
 * Phaser path cannot express a lease and never needed one, because it revokes
 * between a teardown and the next load.
 */
export function retainCustomSpriteUrl(spritePath: string): (() => void) | null {
  const generation = currentGenerations.get(spritePath);
  if (generation === undefined || generation.retired) return null;
  generation.retains += 1;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    generation.retains -= 1;
    if (generation.retains === 0) revokeGeneration(generation);
  };
}

/**
 * Resolve the URL for a sprite given its bundle-relative path.
 *
 * If the user has saved a custom override for this sprite, returns a blob URL with
 * the custom SVG content. Otherwise returns the bundled asset URL.
 *
 * The blob URL is stable for as long as the stored content is unchanged, which is
 * what a texture loading from it needs; it is replaced on a content change, and
 * retired on a reset or on `revokeAllBlobUrls`.
 *
 * A stored override that fails {@link admitCustomSpriteOverride} falls back to the
 * bundled file. It is **not** deleted: this is a render path, and a value that got
 * into the store by some earlier means is the learner's work, not the renderer's to
 * discard. {@link discardCustomSpriteContent} is the explicit self-heal, for a caller
 * that has read the rejection and wants the store cleaned.
 */
export function resolveSpriteUrl(spritePath: string): string {
  const BASE = import.meta.env.BASE_URL;
  const custom = hasLocalStorage() ? safeGet(overrideKey(spritePath)) : null;
  if (custom !== null) {
    if (admitCustomSpriteOverride(custom).admitted) return acquireOverrideUrl(spritePath, custom);
  }
  return `${BASE}assets/${spritePath}`;
}

/**
 * Revoke every blob URL this module created, once any outstanding lease is dropped.
 *
 * With no leases - which is the case for every existing caller, because the Phaser
 * adapters call this between a scene teardown and the next load - this revokes
 * immediately and clears the registry, exactly as it did before Phase 10. With a
 * lease, the URL is marked retired and revoked by the lease's release, which is the
 * behaviour that stops a live texture losing its source.
 */
export function revokeAllBlobUrls(): void {
  for (const generation of [...currentGenerations.values()]) retireGeneration(generation);
  for (const generation of [...pendingRevocations]) revokeGeneration(generation);
}

/**
 * Drop the module's URL state entirely, for a service teardown.
 *
 * Separate from {@link revokeAllBlobUrls} because the two have different callers: a
 * renderer that is between worlds wants its URLs gone, and a test wants the module to
 * start from nothing. Both leave a leased URL alive, and both are idempotent.
 */
export function disposeCustomSpriteOverrides(): void {
  revokeAllBlobUrls();
  currentGenerations.clear();
  pendingRevocations.clear();
}

/**
 * Delete a stored override that {@link admitCustomSpriteOverride} refuses.
 *
 * The self-heal `resolveSpriteUrl` used to perform on its own. It is a separate
 * function now so that discarding a learner's work is something a caller asks for,
 * with the rejection in hand, rather than a side effect of drawing a frame.
 */
export function discardCustomSpriteContent(spritePath: string): void {
  safeRemove(overrideKey(spritePath));
  retireGeneration(currentGenerations.get(spritePath));
}

// ---------------------------------------------------------------------------
// Pack management (localStorage)
// ---------------------------------------------------------------------------

function readPacks(): StoredPacks {
  if (!hasLocalStorage()) return { packs: [], activePack: null };
  const raw = safeGet(PACKS_KEY);
  if (!raw) return { packs: [], activePack: null };
  try {
    const parsed = JSON.parse(raw) as StoredPacks;
    if (parsed && Array.isArray(parsed.packs)) return parsed;
  } catch {
    // corrupt data
  }
  return { packs: [], activePack: null };
}

function writePacks(data: StoredPacks): void {
  if (!hasLocalStorage()) return;
  safeSet(PACKS_KEY, JSON.stringify(data));
}

export function listPacks(): CustomSpritePack[] {
  return readPacks().packs;
}

export function getActivePackName(): string | null {
  return readPacks().activePack;
}

export function savePack(pack: CustomSpritePack): void {
  const data = readPacks();
  const idx = data.packs.findIndex((p) => p.name === pack.name);
  if (idx >= 0) {
    data.packs[idx] = pack;
  } else {
    data.packs.push(pack);
  }
  writePacks(data);
}

export function deletePack(name: string): void {
  const data = readPacks();
  data.packs = data.packs.filter((p) => p.name !== name);
  if (data.activePack === name) {
    data.activePack = null;
  }
  writePacks(data);
}

export function setActivePack(name: string | null): void {
  const data = readPacks();
  data.activePack = name;
  writePacks(data);
}

/**
 * Activate a pack: apply all its sprite overrides.
 */
export function activatePack(name: string): void {
  const data = readPacks();
  const pack = data.packs.find((p) => p.name === name);
  if (!pack) return;

  // Clear existing overrides
  resetAllCustomSprites();

  // Apply pack overrides
  for (const [spritePath, svgContent] of Object.entries(pack.sprites)) {
    saveCustomSpriteContent(spritePath, svgContent);
  }

  data.activePack = name;
  writePacks(data);
}

/**
 * Deactivate the current pack and clear all overrides.
 */
export function deactivatePack(): void {
  resetAllCustomSprites();
  const data = readPacks();
  data.activePack = null;
  writePacks(data);
}

/**
 * Build a CustomSpritePack from the current set of overrides.
 */
export function buildPackFromCurrentOverrides(
  name: string,
  author?: string,
  description?: string,
): CustomSpritePack {
  const sprites: Record<string, string> = {};
  const paths = listCustomSpritePaths();
  for (const spritePath of paths) {
    const content = getCustomSpriteContent(spritePath);
    if (content) {
      sprites[spritePath] = content;
    }
  }

  return {
    name,
    author,
    description,
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    gameVersion: '0.1.0',
    sprites,
  };
}

/**
 * Validate that an object is a well-formed CustomSpritePack.
 */
export function validatePack(obj: unknown): CustomSpritePack | null {
  if (!obj || typeof obj !== 'object') return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.name !== 'string' || !p.name) return null;
  if (typeof p.version !== 'string') return null;
  if (typeof p.createdAt !== 'string') return null;
  if (!p.sprites || typeof p.sprites !== 'object') return null;
  for (const [, value] of Object.entries(p.sprites as Record<string, unknown>)) {
    if (typeof value !== 'string') return null;
  }
  return obj as CustomSpritePack;
}

// ---------------------------------------------------------------------------
// Electron bridge helpers (callable from the renderer process)
// ---------------------------------------------------------------------------

async function getElectronBridge() {
  if (!isElectronAvailable()) return null;
  const bridge = window.electronKnowledgeBridge;
  if (!bridge) return null;
  return bridge;
}

/**
 * Save a custom sprite via Electron IPC (copies to userData + public/assets/).
 *
 * The desktop path validates before it writes, for the same reason the web path
 * does and because the failure here is worse: this one copies bytes into the
 * application's own `public/assets/` tree, where an unvalidated file is not just a
 * rejected override but a file the next build ships.
 */
export async function saveCustomSpriteElectron(
  spritePath: string,
  svgContent: string,
): Promise<void> {
  if (!admitCustomSpriteOverride(svgContent).admitted) {
    throw new Error(
      'The custom sprite was not saved because it is not an admissible image: it must be a well-formed ' +
        'SVG document within the size limit. Nothing was written.',
    );
  }
  const bridge = await getElectronBridge();
  if (!bridge || typeof bridge.saveCustomSprite !== 'function') {
    throw new Error('saveCustomSprite not available');
  }
  await bridge.saveCustomSprite(spritePath, svgContent);
}

/**
 * Reset a custom sprite via Electron IPC.
 */
export async function resetCustomSpriteElectron(spritePath: string): Promise<void> {
  const bridge = await getElectronBridge();
  if (!bridge || typeof bridge.resetCustomSprite !== 'function') {
    throw new Error('resetCustomSprite not available');
  }
  await bridge.resetCustomSprite(spritePath);
}

/**
 * Get the sprite manifest from the Electron main process (filesystem scan).
 */
export async function getSpriteManifestElectron(): Promise<unknown> {
  const bridge = await getElectronBridge();
  if (!bridge || typeof bridge.getSpriteManifest !== 'function') {
    throw new Error('getSpriteManifest not available');
  }
  return bridge.getSpriteManifest();
}

/**
 * Export a sprite pack via Electron native save dialog. Returns the file path
 * or null if cancelled.
 */
export async function exportSpritePackElectron(packJson: string): Promise<string | null> {
  const bridge = await getElectronBridge();
  if (!bridge || typeof bridge.exportSpritePack !== 'function') {
    throw new Error('exportSpritePack not available');
  }
  return bridge.exportSpritePack(packJson);
}

/**
 * Import a sprite pack via Electron native file dialog. Returns the parsed
 * pack JSON or null if cancelled/invalid.
 */
export async function importSpritePackElectron(): Promise<unknown | null> {
  const bridge = await getElectronBridge();
  if (!bridge || typeof bridge.importSpritePack !== 'function') {
    throw new Error('importSpritePack not available');
  }
  return bridge.importSpritePack();
}

// ---------------------------------------------------------------------------
// Phaser tween application from animation presets
// ---------------------------------------------------------------------------

/**
 * Apply a sprite animation preset as Phaser tweens on the given game object.
 * Call this after creating a sprite in a Phaser scene. If the config has
 * type 'none' or no config is found, no tweens are added.
 *
 * @param scene     The Phaser scene to add tweens to.
 * @param sprite    The Image or GameObject to animate.
 * @param config    The animation config from {@link getAnimationConfig}.
 * @param baseY     Optional base Y position for 'float' preset (defaults to sprite.y).
 */
export function applySpriteAnimation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scene: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sprite: any,
  config: SpriteAnimationConfig,
  baseY?: number,
): void {
  if (config.type === 'none') return;
  const speed = config.speed ?? 1;

  const addTween = (cfg: Record<string, unknown>) => scene.tweens.add(cfg);

  switch (config.type) {
    case 'pulse':
      addTween({ targets: sprite, scale: { from: 0.95, to: 1.05 }, duration: 1500 / speed, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      break;
    case 'spin':
      addTween({ targets: sprite, angle: 360, duration: 6000 / speed, repeat: -1, ease: 'Linear' });
      break;
    case 'float':
      addTween({ targets: sprite, y: { from: baseY ?? sprite.y, to: (baseY ?? sprite.y) - 3 }, duration: 1500 / speed, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      break;
    case 'bounce':
      addTween({ targets: sprite, scaleY: { from: 1, to: 0.9 }, duration: 400 / speed, yoyo: true, repeat: -1, ease: 'Bounce.easeOut' });
      break;
    case 'flicker':
      addTween({ targets: sprite, alpha: { from: 0.5, to: 1 }, duration: 600 / speed, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      break;
    case 'wobble':
      addTween({ targets: sprite, angle: { from: -5, to: 5 }, duration: 800 / speed, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      break;
    case 'swing':
      addTween({ targets: sprite, angle: { from: -10, to: 10 }, duration: 2000 / speed, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      break;
    case 'drift':
      addTween({ targets: sprite, x: { from: sprite.x - 2, to: sprite.x + 2 }, duration: 2000 / speed, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      break;
    case 'shimmer':
      addTween({ targets: sprite, scaleX: { from: 0.9, to: 1.1 }, duration: 1000 / speed, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      break;
    case 'breathe':
      addTween({ targets: sprite, scale: { from: 1, to: 1.02 }, duration: 3000 / speed, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      break;
    case 'blink':
      addTween({ targets: sprite, alpha: { from: 1, to: 0.1 }, duration: 400 / speed, yoyo: true, repeat: -1, ease: 'Linear' });
      break;
  }
}
