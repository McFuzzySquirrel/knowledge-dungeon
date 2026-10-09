import {
  parseRuntimeConfig,
  RUNTIME_FLAG_ENV_KEYS,
  type RuntimeConfig,
  type RuntimeConfigKey,
} from './runtimeConfig';

export type FeatureFlagOwnerPhase =
  | 4
  | 5
  | 8
  | 9
  | 10
  | 11
  | 13
  | 14
  | 15
  | 16
  | 17
  | 19
  | 20
  | 22;
export type FeatureFlagValueKind = 'boolean' | 'enum';

export interface FeatureFlagDefinition {
  readonly environmentVariable: string;
  readonly valueKind: FeatureFlagValueKind;
  readonly productionDefault: boolean | string;
  readonly ownerPhase: FeatureFlagOwnerPhase;
  readonly purpose: string;
  readonly rollback: string;
}

export type FeatureFlagMatrix = Readonly<
  Record<RuntimeConfigKey, Readonly<FeatureFlagDefinition>>
>;

/**
 * The kill-switch classification: flags that are neither cutover rollbacks nor retained
 * host switches.
 *
 * A flag named here *enables a service its owning phase delivers*, so it defaults to
 * `true` and exists to be turned off: `audioEnabled` (Phase 10) is the only one, and the
 * plan's rollback line for that phase is a build with it off. It is declared as data
 * rather than left implicit, so a gate can assert the partition and a carve-out cannot
 * spread silently. Adding a name here is a reviewed act for the same reason adding one to
 * the matrix is.
 */
export const NON_CUTOVER_FLAG_KEYS = Object.freeze(['audioEnabled'] as const);

export type NonCutoverFlagKey = (typeof NON_CUTOVER_FLAG_KEYS)[number];

/**
 * The retained-host classification: a flag that survives the Phase 23 cutover unchanged
 * and is removed later, rather than failing over from one behaviour to another.
 *
 * `worldRenderer` is the only one. It is a **host** switch, not a world-renderer cutover:
 * the real PixiJS worlds are selected by the per-world flags (`pixiVillage`,
 * `pixiDungeon`, `pixiFishing`) inside the screens, and `'pixi'` here selects the Phase 9
 * **test host** (`src/renderers/pixi/runtime/PixiWorldHost.tsx`), not a production world.
 * Production therefore keeps `'phaser'` (the application host) at the cutover, so the
 * dungeon route reaches the real `DungeonWorld` through `VITE_PIXI_DUNGEON`, and Phase 24
 * removes the flag when the host adapter goes.
 *
 * Declared as data rather than left implicit, so the three-way partition can be asserted
 * and `worldRenderer`'s non-cutover status cannot be inferred away.
 */
export const RETAINED_HOST_FLAG_KEYS = Object.freeze(['worldRenderer'] as const);

export type RetainedHostFlagKey = (typeof RETAINED_HOST_FLAG_KEYS)[number];

/**
 * The Phase 23 cutover rollback contract.
 *
 * Every flag that switches an existing behaviour to a new one at a reviewed cutover is
 * declared here with the exact value that restores its pre-cutover behaviour. Before
 * the cutover that value was the `productionDefault`; after it, the flag defaults to
 * the new behaviour and this value is the reviewed rollback. The gates assert that each
 * value is still accepted by `parseRuntimeConfig` and still produces the pre-cutover
 * behaviour (`storageRepository: 'legacy'`, every boolean explicit `false`), and that the
 * flag's human-readable `rollback` string names the environment variable and value.
 *
 * `worldRenderer` is deliberately absent: it is a retained host switch, not a cutover, so
 * it is classified in `RETAINED_HOST_FLAG_KEYS` and its default does not move. The
 * `satisfies` clause makes the compiler prove this map covers exactly every key that is
 * neither a kill switch nor a retained host switch, so a flag can neither be left
 * unclassified nor declared twice at the type level.
 */
export const CUTOVER_FLAG_ROLLBACKS = {
  storageRepository: 'legacy',
  pixiVillage: false,
  pixiDungeon: false,
  pixiFishing: false,
  cozyVisuals: false,
  adaptiveAssistance: false,
  dataProductsV2: false,
  webShare: false,
  creatorWorkspace: false,
  scribeEncounterWorkspace: false,
  archaeologistReviewWorkspace: false,
  offlineShell: false,
} as const satisfies Record<
  Exclude<RuntimeConfigKey, NonCutoverFlagKey | RetainedHostFlagKey>,
  boolean | string
>;

export type CutoverFlagKey = keyof typeof CUTOVER_FLAG_ROLLBACKS;

/** The reviewed cutover flags, sorted so a gate can compare against one stable order. */
export const CUTOVER_FLAG_KEYS: readonly CutoverFlagKey[] = Object.freeze(
  (Object.keys(CUTOVER_FLAG_ROLLBACKS) as CutoverFlagKey[]).sort(),
);

/**
 * The reviewed flag set at the Phase 23 cutover, pinned so a flag cannot be silently
 * removed (or added) without review. The gates compare the real matrix key set to this
 * list, and separately prove the three reviewed classifications - cutover rollbacks,
 * kill switches, and retained host switches - cover it exactly once.
 */
export const REVIEWED_FLAG_KEYS: readonly RuntimeConfigKey[] = Object.freeze([
  'adaptiveAssistance',
  'archaeologistReviewWorkspace',
  'audioEnabled',
  'cozyVisuals',
  'creatorWorkspace',
  'dataProductsV2',
  'offlineShell',
  'pixiDungeon',
  'pixiFishing',
  'pixiVillage',
  'scribeEncounterWorkspace',
  'storageRepository',
  'webShare',
  'worldRenderer',
]);

/**
 * Infrastructure contract for phased cutovers. This matrix is not a runtime or
 * user-facing settings surface, and flags must never contain learner data.
 *
 * After the Phase 23 cutover every cutover flag's `productionDefault` is the new
 * behaviour, and its `rollback` string names the environment variable and value that
 * restores the pre-cutover behaviour for one release. Two names are not cutover gates and
 * are declared as data rather than inferred: `audioEnabled` (Phase 10) is a kill switch
 * that defaults on, because there is no pre-phase audio behaviour for a learner to keep;
 * and `worldRenderer` is a retained host switch that keeps its `'phaser'` default because
 * the real PixiJS worlds are selected by the per-world flags. Between them the three
 * classifications are a reviewed partition rather than a quiet hole.
 */
export const FEATURE_FLAG_MATRIX = {
  worldRenderer: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.worldRenderer,
    valueKind: 'enum',
    productionDefault: 'phaser',
    ownerPhase: 9,
    purpose:
      'Selects the world host adapter, not a world. Production keeps the application host (`phaser`), which renders the real PixiJS worlds through the per-world flags `VITE_PIXI_DUNGEON`, `VITE_PIXI_VILLAGE`, and `VITE_PIXI_FISHING`. `pixi` selects the Phase 9 test host (`PixiWorldHost`), not a production world, so it is not a cutover. It is a retained host switch (RETAINED_HOST_FLAG_KEYS) and Phase 24 removes it.',
    rollback:
      'Not a cutover: keep VITE_WORLD_RENDERER unset (or `phaser`) for the application host. `VITE_WORLD_RENDERER=pixi` selects the Phase 9 test host and is not a production world renderer.',
  },
  storageRepository: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.storageRepository,
    valueKind: 'enum',
    productionDefault: 'v2',
    ownerPhase: 4,
    purpose:
      'Selects the storage generation. Production now reads and writes storage-v2 while continuing legacy mirror writes; this flag is the one-release rollback to the staged legacy repository.',
    rollback:
      'Set VITE_STORAGE_REPOSITORY=legacy and retain the staged generation for recovery.',
  },
  pixiVillage: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.pixiVillage,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 11,
    purpose:
      'Selects the PixiJS Village world, now the production default. This flag is the one-release rollback to the Phaser Village path.',
    rollback: 'Set VITE_PIXI_VILLAGE=false to retain the Phaser Village path.',
  },
  pixiDungeon: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.pixiDungeon,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 13,
    purpose:
      'Selects the PixiJS Dungeon world, now the production default. This flag is the one-release rollback to the Phaser Dungeon path.',
    rollback: 'Set VITE_PIXI_DUNGEON=false to retain the Phaser Dungeon path.',
  },
  pixiFishing: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.pixiFishing,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 17,
    purpose:
      'Selects the PixiJS Fishing world, now the production default. This flag is the one-release rollback to the Phaser Fishing path.',
    rollback: 'Set VITE_PIXI_FISHING=false to retain the Phaser Fishing path.',
  },
  cozyVisuals: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.cozyVisuals,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 8,
    purpose:
      'Enables the Cozy visual system, now the production default. This flag is the one-release rollback to the legacy renderer themes.',
    rollback: 'Set VITE_COZY_VISUALS=false to retain the legacy renderer themes.',
  },
  adaptiveAssistance: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.adaptiveAssistance,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 19,
    purpose:
      'Enables deterministic, local, explainable Gentle assistance, now the production default. This flag is the one-release rollback; turning it off leaves locally stored assistance records untouched.',
    rollback:
      'Set VITE_ADAPTIVE_ASSISTANCE=false and leave locally stored assistance records untouched.',
  },
  dataProductsV2: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.dataProductsV2,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 5,
    purpose:
      'Gates versioned full-device, subject, and template products delivered across Phases 5 through 7, now the production default. This flag is the one-release rollback.',
    rollback:
      'Set VITE_DATA_PRODUCTS_V2=false; existing local and legacy export/import paths remain available.',
  },
  webShare: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.webShare,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 20,
    purpose:
      'Enables explicit-action Web Share after the private share-card preview and local download are verified, now the production default. This flag is the one-release rollback.',
    rollback: 'Set VITE_WEB_SHARE=false and retain local PNG download.',
  },
  audioEnabled: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.audioEnabled,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 10,
    // The one flag in this matrix that is a kill switch rather than a cutover rollback,
    // and the reason is the difference between the two. Every cutover flag now defaults
    // to the behaviour the cutover delivered, and its reviewed pre-cutover value is its
    // rollback. Audio has no previous behaviour to preserve - Phase 10 builds the
    // service - so the flag does not gate its arrival, it gates its use, and the default
    // build is the build the phase delivers.
    purpose:
      'Enables the renderer-neutral audio service built in Phase 10: gesture-gated playback, procedural synthesis with no media files, and persisted music and SFX volume. It is a kill switch, not a cutover rollback, so it defaults on and the plan’s rollback line - disable audio independently and retain procedural art fallbacks - is a build with it off.',
    rollback:
      'Set VITE_AUDIO_ENABLED=false to disable audio independently and retain the procedural art fallbacks. Nothing else is affected: no media is unloaded, no data is migrated, and the procedural art recipes are untouched.',
  },
  creatorWorkspace: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.creatorWorkspace,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 14,
    purpose:
      'Enables the redesigned Creator workspace, where subject mapping is the first-class dungeon workspace, now the production default. This flag is the one-release rollback to the existing RoomPanel Creator view.',
    rollback:
      'Set VITE_CREATOR_WORKSPACE=false to retain the existing RoomPanel Creator view.',
  },
  scribeEncounterWorkspace: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.scribeEncounterWorkspace,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 15,
    purpose:
      'Enables the redesigned Scribe encounter workspace, now the production default; this flag is the one-release rollback to the existing NoteEditorModal. Note validation, progression, and artifact generation are unchanged by this flag: it selects which view a learner sees, not what counts as a valid note.',
    rollback:
      'Set VITE_SCRIBE_ENCOUNTER_WORKSPACE=false to retain the existing NoteEditorModal as the Scribe view.',
  },
  archaeologistReviewWorkspace: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.archaeologistReviewWorkspace,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 16,
    purpose:
      'Enables the redesigned Archaeologist review workspace, now the production default; this flag is the one-release rollback to the existing room-panel review view. It selects which view a learner sees, not what counts as a review pass; review scheduling, SM-2 values, and progression are unchanged.',
    rollback:
      'Set VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE=false to retain the existing RoomPanel review view and its close-the-panel-to-count-the-pass flow.',
  },
  offlineShell: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.offlineShell,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 22,
    purpose:
      'Enables the offline static-shell service worker: a versioned same-origin shell cache that lets a previously loaded app reload without a network, while never caching learner data and never reading or writing IndexedDB. It only ever caches build-time shell assets named by the emitted manifest. It is now the production default and this flag is the one-release rollback.',
    rollback:
      'Set VITE_OFFLINE_SHELL=false to remove the service worker, the shell manifest, and the registration script from the build; the pre-Phase-22 artifact is restored.',
  },
} as const satisfies FeatureFlagMatrix;

/**
 * The cutover flags whose value is a boolean, derived from the matrix rather than
 * re-listed, so the "flags that default on" assertion cannot drift from the declaration.
 * The two enum cutover flags (`worldRenderer`, `storageRepository`) are excluded because
 * their non-default value is not a boolean.
 */
export const CUTOVER_BOOLEAN_FLAG_KEYS: readonly CutoverFlagKey[] = Object.freeze(
  CUTOVER_FLAG_KEYS.filter((key) => FEATURE_FLAG_MATRIX[key].valueKind === 'boolean'),
);

export function parseFeatureFlags(
  environment: Readonly<Record<string, unknown>>,
): Readonly<RuntimeConfig> {
  return parseRuntimeConfig(environment);
}

/**
 * Parsed once at build time. Application code may import this contract when a
 * later, separately scoped phase wires an owner flag into a route or adapter.
 */
export const FEATURE_FLAGS: Readonly<RuntimeConfig> = Object.freeze(
  parseFeatureFlags(import.meta.env),
);

export const runtimeConfig = FEATURE_FLAGS;
