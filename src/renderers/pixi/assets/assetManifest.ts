/**
 * The PixiJS asset bundles, as data.
 *
 * ## What this file is
 *
 * Phase 10 scope asks for "Pixi asset bundles for common, village, dungeon, fishing,
 * and share-card media" and plan section 10.3 asks for a lazy load and an explicit
 * unload. Those are two different things and this file is only the first: it is the
 * declarative record of what exists, which licence class each thing is, whether the
 * route can survive without it, and what to draw when it is not there. The service
 * that acts on it is `AssetLoader.ts`, one directory over.
 *
 * Split in two, deliberately. A manifest is the thing a reviewer can check against
 * `public/assets/asset-licenses.json` line by line, and it is the thing a *failure*
 * has to be able to talk about. Neither of those jobs wants an `await` in it, and a
 * loader is mostly `await`.
 *
 * ## The five bundle sets are thin, and that is the deliverable
 *
 * Phase 10's non-goals include "No final world-specific asset production". So
 * `common`, `village`, `dungeon`, `fishing`, and `share-card` declare **keys and
 * fallback recipes and no files**. `path: null` is the honest spelling of "this key
 * exists, the world will ask for it, and today it is drawn procedurally" - it is not
 * a placeholder for a filename that was forgotten, and it is not an invitation to
 * point at a file that does not exist. Phases 11, 13, 17, and 20 fill these in, and
 * filling one in is a one-line change here plus a registry entry, not a new system.
 *
 * The consequence is worth stating plainly because it looks like incompleteness and
 * is not: **nothing in the world bundles can be missing, because nothing in them is
 * a file.** The "optional media does not break a route" property is therefore a
 * property of the *loader* (`AssetLoader.ts`) rather than of this data, and
 * `tests/phase10/asset-loader.test.ts` exercises it against a synthetic manifest that
 * does have paths, which is the only way to test a 404 without shipping one.
 *
 * ## `cc0-approved` is zero and this file does not pretend otherwise
 *
 * Phase 8's finding is the reason the four world bundles are empty rather than
 * full: all 90 pre-existing media files are `legacy-unverified`, the repository
 * LICENSE is MIT, and MIT is not `CC0-1.0`, so there is no verified grant to record
 * for any of them. Re-licensing them is a copyright-holder decision, not a build
 * step. So the only files in any bundle here are the six Phase 8 procedural Cozy
 * placeholders, which are `procedural` precisely because a committed script
 * generates them and no third-party licence attaches.
 *
 * That is why every entry carries `licenseClass` at all. The registry admits exactly
 * two classes to a bundle, `cc0-approved` and `procedural`, and an entry that named
 * anything else would be a claim about a file nobody has verified. Making it a
 * required field means the mistake is a type error while the manifest is being
 * written and a thrown error at import if it is reached some other way, rather than
 * a bundle that quietly ships an unverified sprite.
 *
 * ## Paths are same-origin, and the shape is what proves it
 *
 * A path here is `assets/<...>` - a **public-root-relative** path, not a URL. It is
 * prefixed with `import.meta.env.BASE_URL` by the loader, exactly as
 * `src/services/customSprites.ts` builds a sprite URL, so the same file is served
 * correctly by the web build (`/`) and the Electron build (`./`).
 *
 * Nothing in this file may name a scheme, a host, a protocol-relative `//`, or a
 * `..`. The plan's non-goals forbid remote media and Phase 10's verification asks
 * for "no remote media request occurs", and a manifest is the one place where such a
 * request would be *decided* rather than merely made. `assertAssetManifestIsShippable`
 * enforces it structurally, and `tests/phase10/asset-manifest.test.ts` re-derives the
 * same rules over the raw source text so a rule that is only enforced in TypeScript
 * types cannot be the only thing holding.
 *
 * ## Why the fallback recipe carries no numbers
 *
 * A recipe names Cozy colour *tokens* and pixel dimensions, and nothing else. The
 * token-to-number resolution happens once, in the loader, through
 * `resolveCozyWorldTheme` - the single module in this tree that is allowed to turn a
 * Cozy token into something a canvas takes. If a recipe carried hex values it would
 * be a second declaration of the palette, which is the exact thing
 * `public/assets/asset-licenses.json` records in `paletteNote` when it says the
 * placeholder colours there are art inputs and not a second token source.
 *
 * `radiusPx` is deliberately absent for the same reason. The panel radius is a Cozy
 * token; a manifest that pinned its own copy would drift from it silently, so the
 * recipe says "panel" and the loader reads `theme.radius.md`.
 *
 * ## The cross-references that hold this to the registry
 *
 * - `tests/phase10/asset-manifest.test.ts` compares the bundle ids and the
 *   `pixi-default` membership against `public/assets/asset-licenses.json`, and
 *   re-derives the licence-class and same-origin rules from this file's own source.
 * - `tests/phase10/asset-loader.test.ts` covers the load/release behaviour, including
 *   the optional-missing and required-missing cases this data does not itself contain.
 * - `scripts/check-cc0-assets.mjs` (`npm run test:licenses`) is what enforces
 *   membership from the other side: a file here that is not a `cc0-approved` or
 *   `procedural` registry entry fails there, and a registry entry that claims a
 *   bundle it is not admitted to fails here.
 */
import type { CozyColorToken } from '@/theme';

/**
 * The five bundle sets Phase 10 names, plus the one the Phase 8 registry already
 * declares.
 *
 * `pixi-default` is the default, not an alias for `common`. The registry names it,
 * its declared path is `public/assets/cozy/`, and the six files under it are the
 * only media this application may put in a Pixi bundle today - so folding it into
 * `common` would mean `common` had a path the registry has not admitted, which is
 * precisely the shape the bundle rule exists to prevent.
 */
export type AssetBundleId = 'common' | 'village' | 'dungeon' | 'fishing' | 'share-card' | 'pixi-default';

/** Every bundle id, in the order the module declares them. */
export const ASSET_BUNDLE_IDS: readonly AssetBundleId[] = Object.freeze([
  'pixi-default',
  'common',
  'village',
  'dungeon',
  'fishing',
  'share-card',
] as const);

/** The bundle a caller gets when it names none. */
export const DEFAULT_ASSET_BUNDLE_ID: AssetBundleId = 'pixi-default';

/**
 * The only two classifications the registry admits to a bundle.
 *
 * Deliberately not the full taxonomy. `legacy-unverified` and `repository-authored`
 * exist and are both forbidden here - the first because no verified grant backs any
 * of the ninety files it names, the second because a non-media file is not something
 * a texture can be loaded from. A manifest entry is a media claim, so it is typed
 * against the two classes that can support one.
 */
export type AssetLicenseClass = 'cc0-approved' | 'procedural';

/** The two classes {@link AssetLicenseClass} admits, as a runtime list. */
export const ASSET_LICENSE_CLASSES: readonly AssetLicenseClass[] = Object.freeze([
  'cc0-approved',
  'procedural',
] as const);

/**
 * Whether a route can render without this entry.
 *
 * - `required` - the entry is admitted media that the build ships. Its absence is a
 *   packaging defect, so a load reports it rather than quietly substituting art.
 * - `optional` - the entry is decoration. Its absence is a normal state of the
 *   application, so the loader substitutes the procedural recipe and records the gap.
 *
 * An entry with no `path` is always `optional`: there is no file to be missing, and
 * a `required` entry with no file would be a claim about a thing that does not exist.
 */
export type AssetRequirement = 'required' | 'optional';

/**
 * The shape the loader draws when an entry has no texture.
 *
 * Deliberately small and deliberately renderer-neutral: four primitives, three
 * colours, two dimensions. It carries no colour *numbers* (see the module header)
 * and no corner radius, because both would be second declarations of things the Cozy
 * token module already owns.
 */
export type AssetFallbackKind = 'rounded-panel' | 'tile' | 'disc' | 'rule';

export interface AssetFallbackRecipe {
  readonly kind: AssetFallbackKind;
  /** Fill, as a Cozy semantic token name. Resolved to a number by the loader. */
  readonly fill: CozyColorToken;
  /** Border, as a Cozy semantic token name. Resolved to a number by the loader. */
  readonly stroke: CozyColorToken;
  /** Intrinsic width in CSS pixels. Positive. */
  readonly widthPx: number;
  /** Intrinsic height in CSS pixels. Positive. */
  readonly heightPx: number;
}

/**
 * One loadable thing, or one thing that will be drawn procedurally.
 *
 * `key` is the alias the loader and a scene both use. It is a manifest identifier
 * and never a path: it appears in diagnostics, and a diagnostic that could carry a
 * URL could carry a query string somebody put in one.
 */
export interface AssetManifestEntry {
  readonly key: string;
  /**
   * Public-root-relative path, or `null`.
   *
   * `null` means there is no file for this key and the procedural recipe is the
   * whole of its representation. It is not a placeholder for a missing filename, and
   * the loader never turns it into a request.
   */
  readonly path: string | null;
  readonly requirement: AssetRequirement;
  /**
   * The registry classification this entry claims.
   *
   * Required, and validated at import, so an entry that is neither `cc0-approved`
   * nor `procedural` fails loudly here rather than shipping.
   */
  readonly licenseClass: AssetLicenseClass;
  readonly fallback: AssetFallbackRecipe;
}

export interface AssetBundleDefinition {
  readonly id: AssetBundleId;
  /** What the bundle is for, in one sentence a reviewer can check against the plan. */
  readonly description: string;
  readonly entries: readonly AssetManifestEntry[];
}

/* -------------------------------------------------------------------------- */
/* Declaration helpers                                                         */
/* -------------------------------------------------------------------------- */

/** The Cozy families the recipes are drawn from, kept apart from the token names. */
type FallbackPalette = 'moss' | 'parchment' | 'firelight';

const FALLBACK_PALETTES: Readonly<Record<FallbackPalette, { readonly fill: CozyColorToken; readonly stroke: CozyColorToken }>> =
  Object.freeze({
    moss: Object.freeze({ fill: 'surfacePage', stroke: 'borderControl' }),
    parchment: Object.freeze({ fill: 'surfacePanel', stroke: 'borderStrong' }),
    firelight: Object.freeze({ fill: 'surfaceRaised', stroke: 'accent' }),
  });

/**
 * An entry that loads a file.
 *
 * Written as a function rather than an object literal so the `path` argument is a
 * parameter and a reader can see at the call site that every path in this file has
 * the same `assets/cozy/` shape. The shapes are validated at import regardless -
 * see {@link assertAssetManifestIsShippable}.
 */
function entry(
  key: string,
  path: string,
  requirement: AssetRequirement,
  kind: AssetFallbackKind,
  palette: FallbackPalette,
): AssetManifestEntry {
  const colours = FALLBACK_PALETTES[palette];
  return Object.freeze({
    key,
    path,
    requirement,
    // Every file in this file today is one of the six Phase 8 procedural
    // placeholders, so `procedural` is not a default here - it is the fact. The
    // registry is what would have to change before a `cc0-approved` entry could
    // appear, and it is not this file's to decide.
    licenseClass: 'procedural' as const,
    fallback: Object.freeze({
      kind,
      fill: colours.fill,
      stroke: colours.stroke,
      widthPx: kind === 'rule' ? 32 : 64,
      heightPx: kind === 'rule' ? 8 : 48,
    }),
  });
}

/** An entry with no file: a key the world asks for, drawn from the recipe. */
function placeholder(
  key: string,
  kind: AssetFallbackKind,
  fill: CozyColorToken,
  stroke: CozyColorToken,
  widthPx: number,
  heightPx: number,
): AssetManifestEntry {
  return Object.freeze({
    key,
    path: null,
    requirement: 'optional' as const,
    licenseClass: 'procedural' as const,
    fallback: Object.freeze({ kind, fill, stroke, widthPx, heightPx }),
  });
}

/* -------------------------------------------------------------------------- */
/* The bundles                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The six Phase 8 procedural placeholders.
 *
 * The only entries in this file with a `path`, and the only files
 * `public/assets/asset-licenses.json` currently admits to a bundle. `required`,
 * because they are shipped media with a pinned checksum: if one of them is not on
 * disk the build is wrong, and a procedural substitute would hide that.
 */
const PIXI_DEFAULT_ENTRIES: readonly AssetManifestEntry[] = Object.freeze([
  entry('cozy-berry-bush', 'assets/cozy/cozy-berry-bush.svg', 'required', 'rounded-panel', 'moss'),
  entry('cozy-firelight-torch', 'assets/cozy/cozy-firelight-torch.svg', 'required', 'rule', 'firelight'),
  entry('cozy-ink-panel', 'assets/cozy/cozy-ink-panel.svg', 'required', 'rounded-panel', 'parchment'),
  entry('cozy-ink-signpost', 'assets/cozy/cozy-ink-signpost.svg', 'required', 'tile', 'parchment'),
  entry('cozy-moss-grass', 'assets/cozy/cozy-moss-grass.svg', 'required', 'tile', 'moss'),
  entry('cozy-parchment-floor', 'assets/cozy/cozy-parchment-floor.svg', 'required', 'tile', 'parchment'),
]);

/**
 * Shared chrome every world draws.
 *
 * Keys only. The surface a world puts behind its HUD, the focus affordance it
 * mirrors from the DOM, and the frame it draws a learner's answer into. All three are
 * drawable from the recipe alone, and Phase 11 decides whether the art is worth
 * producing.
 */
const COMMON_ENTRIES: readonly AssetManifestEntry[] = Object.freeze([
  placeholder('common-hud-panel', 'rounded-panel', 'surfacePanel', 'borderControl', 96, 72),
  placeholder('common-focus-frame', 'rounded-panel', 'surfaceRaised', 'focusHalo', 32, 32),
  placeholder('common-answer-frame', 'rounded-panel', 'surfaceSunken', 'borderStrong', 64, 48),
]);

/** Village ground, wayfinding, and the marker a placed NPC stands on. */
const VILLAGE_ENTRIES: readonly AssetManifestEntry[] = Object.freeze([
  placeholder('village-ground', 'tile', 'surfacePage', 'borderHairline', 64, 64),
  placeholder('village-signpost', 'tile', 'surfaceRaised', 'borderControl', 32, 48),
  placeholder('village-npc-marker', 'disc', 'accentSoft', 'borderControl', 24, 24),
]);

/** Dungeon floor, the door a lockable room is drawn with, and the stair pair. */
const DUNGEON_ENTRIES: readonly AssetManifestEntry[] = Object.freeze([
  placeholder('dungeon-floor', 'tile', 'surfaceSunken', 'borderHairline', 64, 64),
  placeholder('dungeon-door', 'rounded-panel', 'surfacePanel', 'borderStrong', 32, 48),
  placeholder('dungeon-stairs', 'tile', 'surfaceRaised', 'borderControl', 32, 32),
]);

/** Water, the float, and the rod. The three things Fisher's Rest is made of. */
const FISHING_ENTRIES: readonly AssetManifestEntry[] = Object.freeze([
  placeholder('fishing-water', 'tile', 'surfaceSunken', 'focusHalo', 64, 64),
  placeholder('fishing-bobber', 'disc', 'accent', 'borderControl', 16, 16),
  placeholder('fishing-rod', 'rule', 'surfaceRaised', 'borderStrong', 48, 8),
]);

/**
 * The share card's frame and crest.
 *
 * The card itself is composed in DOM and exported as an image, so this bundle holds
 * only the two frames around it. It is a bundle rather than a constant because the
 * frame is a Cozy surface the export has to match, and a constant would be a second
 * place to change it.
 */
const SHARE_CARD_ENTRIES: readonly AssetManifestEntry[] = Object.freeze([
  placeholder('share-card-frame', 'rounded-panel', 'surfaceRaised', 'borderStrong', 240, 160),
  placeholder('share-card-crest', 'disc', 'accent', 'borderControl', 40, 40),
]);

/** Every bundle, keyed by id. */
export const ASSET_BUNDLES: Readonly<Record<AssetBundleId, AssetBundleDefinition>> = Object.freeze({
  'pixi-default': Object.freeze({
    id: 'pixi-default',
    description:
      'The default bundle, and the only one with files in it: the six Phase 8 procedural Cozy placeholders the media registry admits. Every other bundle composes around these.',
    entries: PIXI_DEFAULT_ENTRIES,
  }),
  common: Object.freeze({
    id: 'common',
    description:
      'Shared chrome every world draws: the HUD surface, the focus affordance mirrored from the DOM, and the frame an answer is drawn into. Keys and procedural recipes only.',
    entries: COMMON_ENTRIES,
  }),
  village: Object.freeze({
    id: 'village',
    description:
      'Pixi Village world media: ground, wayfinding, and the NPC placement marker. Keys and procedural recipes only; the art is Phase 11.',
    entries: VILLAGE_ENTRIES,
  }),
  dungeon: Object.freeze({
    id: 'dungeon',
    description:
      'Dungeon world media: floor, the door a lockable room is drawn with, and the stair pair. Keys and procedural recipes only; the art is Phase 13.',
    entries: DUNGEON_ENTRIES,
  }),
  fishing: Object.freeze({
    id: 'fishing',
    description:
      "Fisher's Rest world media: water, the float, and the rod. Keys and procedural recipes only; the art is Phase 17.",
    entries: FISHING_ENTRIES,
  }),
  'share-card': Object.freeze({
    id: 'share-card',
    description:
      'Share-card media: the frame the exported image is composed inside and its crest. Keys and procedural recipes only; the export itself is Phase 20.',
    entries: SHARE_CARD_ENTRIES,
  }),
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The one definition of "this path is same-origin and stays inside `assets/`".
 *
 * A function rather than one regular expression, because the two rules it enforces
 * are not the same rule and a single pattern gets one of them wrong. A character
 * class of `[A-Za-z0-9._-]` admits `..` - the dots are in the class - so a pattern
 * that checks "only legal characters" silently permits `assets/../../etc/passwd`,
 * and that is exactly the hole a *path* rule exists to close. So the segments are
 * split and each is checked on its own.
 *
 * `tests/phase10/asset-manifest.test.ts` is where that was found, which is the
 * argument for the function existing: a test of a function testing itself would
 * have agreed with the regex.
 */
function isSameOriginAssetPath(path: string): boolean {
  if (!path.startsWith('assets/')) return false;
  if (path.includes('//')) return false;
  const segments = path.slice('assets/'.length).split('/');
  return segments.every(
    (segment) => segment.length > 0 && /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '..',
  );
}

/** A key: lowercase, dash-separated, so it is safe in a diagnostic and stable in a bundle. */
const ASSET_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

const FALLBACK_KINDS: readonly AssetFallbackKind[] = Object.freeze([
  'rounded-panel',
  'tile',
  'disc',
  'rule',
]);

/**
 * Every reason a manifest is refused, as data rather than as prose.
 *
 * Returned instead of thrown so a caller - a test, or a future authoring tool - can
 * report all of them at once. {@link assertAssetManifestIsShippable} turns the first
 * into a thrown `TypeError`.
 */
export interface AssetManifestProblem {
  readonly bundleId: string;
  readonly key: string;
  readonly rule:
    | 'unknown-bundle-id'
    | 'duplicate-bundle-id'
    | 'duplicate-key'
    | 'invalid-key'
    | 'bad-license-class'
    | 'remote-or-unsafe-path'
    | 'required-without-path'
    | 'bad-fallback-kind'
    | 'bad-fallback-size';
  readonly detail: string;
}

/**
 * Check a manifest, returning every problem rather than the first.
 *
 * Takes the manifest as an argument rather than reading the module-level one, so a
 * test can check a *bad* manifest - which is the only way to prove these rules have
 * teeth rather than merely that the shipped data happens to satisfy them. The rules
 * are re-derived from the data, not from a list of ids, so adding a seventh bundle is
 * a deliberate act that fails `duplicate-bundle-id` and an unrecognised classification
 * fails `bad-license-class` on its own.
 */
export function findAssetManifestProblems(
  bundles: Readonly<Record<string, AssetBundleDefinition>>,
): readonly AssetManifestProblem[] {
  const problems: AssetManifestProblem[] = [];
  const seenKeys = new Set<string>();
  const seenBundleIds = new Set<string>();

  for (const [declaredId, bundle] of Object.entries(bundles)) {
    const report = (key: string, rule: AssetManifestProblem['rule'], detail: string): void => {
      problems.push({ bundleId: declaredId, key, rule, detail });
    };

    if (seenBundleIds.has(declaredId)) {
      report('<bundle>', 'duplicate-bundle-id', 'A bundle id appears more than once.');
    }
    seenBundleIds.add(declaredId);

    if (!ASSET_BUNDLE_IDS.includes(declaredId as AssetBundleId)) {
      report('<bundle>', 'unknown-bundle-id', `\`${declaredId}\` is not one of the declared bundle ids.`);
    }
    if (bundle.id !== declaredId) {
      report('<bundle>', 'duplicate-bundle-id', 'The record key and the bundle\'s own `id` disagree.');
    }
    if (!Array.isArray(bundle.entries)) {
      report('<bundle>', 'duplicate-bundle-id', 'A bundle must declare an `entries` array.');
      continue;
    }

    for (const item of bundle.entries) {
      if (!ASSET_KEY.test(item.key)) {
        report(String(item.key), 'invalid-key', 'A key must be lowercase alphanumeric with dashes.');
      }
      if (seenKeys.has(item.key)) {
        report(item.key, 'duplicate-key', 'A key is the loader\'s address for a texture and must be unique across the whole manifest.');
      }
      seenKeys.add(item.key);

      if (!ASSET_LICENSE_CLASSES.includes(item.licenseClass)) {
        report(
          item.key,
          'bad-license-class',
          'A bundle member must be `cc0-approved` or `procedural`; anything else has no verified grant behind it and must not ship.',
        );
      }

      if (item.path === null) {
        if (item.requirement !== 'optional') {
          report(item.key, 'required-without-path', 'An entry with no file cannot be required: there is nothing that could be missing.');
        }
      } else if (!isSameOriginAssetPath(item.path)) {
        report(
          item.key,
          'remote-or-unsafe-path',
          'A path must be public-root-relative and same-origin (`assets/...`): no scheme, no host, no `//`, no `..`.',
        );
      }

      if (!FALLBACK_KINDS.includes(item.fallback?.kind)) {
        report(item.key, 'bad-fallback-kind', 'A fallback recipe must name one of the four declared shapes.');
      }
      if (
        !Number.isFinite(item.fallback?.widthPx) ||
        !Number.isFinite(item.fallback?.heightPx) ||
        item.fallback.widthPx <= 0 ||
        item.fallback.heightPx <= 0
      ) {
        report(item.key, 'bad-fallback-size', 'A fallback recipe needs a positive width and height in pixels.');
      }
    }
  }

  return problems;
}

/**
 * Throw on the first problem, naming it.
 *
 * Runs at module scope over {@link ASSET_BUNDLES} so a bad entry is a failed import
 * rather than a bundle that ships. That is the "fails loudly rather than shipping"
 * half of the licence-class requirement: the type already refuses the value, and
 * this refuses it for the routes the type cannot cover - a hand-edited record, a
 * value arriving from a future JSON manifest, or a cast.
 */
export function assertAssetManifestIsShippable(
  bundles: Readonly<Record<string, AssetBundleDefinition>> = ASSET_BUNDLES,
): void {
  const problems = findAssetManifestProblems(bundles);
  if (problems.length === 0) return;
  const first = problems[0];
  throw new TypeError(
    `The Pixi asset manifest is not shippable: ${problems.length} problem(s). First: bundle \`${first.bundleId}\` ` +
      `entry \`${first.key}\` violates ${first.rule} - ${first.detail} ` +
      'The media registry (public/assets/asset-licenses.json) admits only `cc0-approved` and `procedural` entries to a bundle.',
  );
}

assertAssetManifestIsShippable();

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

/** Total over any string, so a name from a route parameter cannot produce `undefined`. */
export function resolveAssetBundle(id: string | null | undefined): AssetBundleDefinition | null {
  if (typeof id !== 'string') return null;
  if (!Object.hasOwn(ASSET_BUNDLES, id)) return null;
  return ASSET_BUNDLES[id as AssetBundleId];
}

/** Every key in the manifest, mapped to the bundle that declares it. */
export const ASSET_KEY_OWNERS: ReadonlyMap<string, AssetBundleId> = (() => {
  const owners = new Map<string, AssetBundleId>();
  for (const bundle of Object.values(ASSET_BUNDLES)) {
    for (const item of bundle.entries) owners.set(item.key, bundle.id);
  }
  return owners;
})();

/** The entry a key names, or `null` for a key no bundle declares. */
export function findAssetEntry(key: string): AssetManifestEntry | null {
  const owner = ASSET_KEY_OWNERS.get(key);
  if (owner === undefined) return null;
  const found = ASSET_BUNDLES[owner].entries.find((item) => item.key === key);
  return found ?? null;
}
