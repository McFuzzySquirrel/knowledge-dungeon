import {
  parseRuntimeConfig,
  RUNTIME_FLAG_ENV_KEYS,
  type RuntimeConfig,
  type RuntimeConfigKey,
} from './runtimeConfig';

export type FeatureFlagOwnerPhase = 4 | 5 | 8 | 9 | 10 | 11 | 13 | 17 | 19 | 20;
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
 * Flags that are not cutover gates.
 *
 * Every other flag in the matrix exists to switch an existing behaviour to a new one
 * at a reviewed cutover, so its production default is the pre-phase behaviour. A flag
 * named here instead *enables a service its owning phase delivers*, so it defaults to
 * `true` and exists to be turned off: `audioEnabled` (Phase 10) is the only one, and
 * the plan's rollback line for that phase is a build with it off.
 *
 * Declared as data rather than left implicit, so a gate can assert both halves and a
 * carve-out cannot spread silently: this list is exactly the set of flags permitted to
 * default on, and a cutover flag that defaults on still fails. Adding a name here is a
 * reviewed act for the same reason adding one to the matrix is.
 */
export const NON_CUTOVER_FLAG_KEYS: readonly RuntimeConfigKey[] = Object.freeze([
  'audioEnabled',
] as const);

/**
 * Infrastructure contract for phased cutovers. This matrix is not a runtime or
 * user-facing settings surface, and flags must never contain learner data.
 *
 * One entry is not a cutover gate. `audioEnabled` (Phase 10) is a kill switch that
 * defaults on, because there is no pre-phase audio behaviour for a learner to keep and
 * the plan's rollback for that phase is to turn it off. It is stated here rather than
 * left to be inferred from a boolean, because "every other flag defaults off" is the
 * property the rest of this matrix exists to protect.
 */
export const FEATURE_FLAG_MATRIX = {
  worldRenderer: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.worldRenderer,
    valueKind: 'enum',
    productionDefault: 'phaser',
    ownerPhase: 9,
    purpose: 'Selects the temporary world-renderer adapter while Phaser remains the current default.',
    rollback: 'Set VITE_WORLD_RENDERER=phaser or remove the build override.',
  },
  storageRepository: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.storageRepository,
    valueKind: 'enum',
    productionDefault: 'legacy',
    ownerPhase: 4,
    purpose: 'Selects the staged storage generation after storage-v2 is implemented and verified.',
    rollback: 'Set VITE_STORAGE_REPOSITORY=legacy and retain the staged generation for recovery.',
  },
  pixiVillage: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.pixiVillage,
    valueKind: 'boolean',
    productionDefault: false,
    ownerPhase: 11,
    purpose: 'Gates the PixiJS Village replacement after renderer-neutral and asset contracts pass.',
    rollback: 'Set VITE_PIXI_VILLAGE=false to retain the Phaser Village path.',
  },
  pixiDungeon: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.pixiDungeon,
    valueKind: 'boolean',
    productionDefault: false,
    ownerPhase: 13,
    purpose: 'Gates the PixiJS Dungeon replacement after gameplay parity and accessibility checks pass.',
    rollback: 'Set VITE_PIXI_DUNGEON=false to retain the Phaser Dungeon path.',
  },
  pixiFishing: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.pixiFishing,
    valueKind: 'boolean',
    productionDefault: false,
    ownerPhase: 17,
    purpose: 'Gates the PixiJS Fishing replacement after the complete catch loop passes parity checks.',
    rollback: 'Set VITE_PIXI_FISHING=false to retain the Phaser Fishing path.',
  },
  cozyVisuals: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.cozyVisuals,
    valueKind: 'boolean',
    productionDefault: false,
    ownerPhase: 8,
    purpose: 'Gates the Cozy visual system after tokens, responsive behavior, and CC0 media are approved.',
    rollback: 'Set VITE_COZY_VISUALS=false to retain the legacy renderer themes.',
  },
  adaptiveAssistance: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.adaptiveAssistance,
    valueKind: 'boolean',
    productionDefault: false,
    ownerPhase: 19,
    purpose: 'Gates deterministic, local, explainable learner assistance after its storage and audit work pass.',
    rollback: 'Set VITE_ADAPTIVE_ASSISTANCE=false and leave locally stored assistance records untouched.',
  },
  dataProductsV2: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.dataProductsV2,
    valueKind: 'boolean',
    productionDefault: false,
    ownerPhase: 5,
    purpose: 'Gates versioned full-device, subject, and template products delivered across Phases 5 through 7.',
    rollback: 'Set VITE_DATA_PRODUCTS_V2=false; existing local and legacy export/import paths remain available.',
  },
  webShare: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.webShare,
    valueKind: 'boolean',
    productionDefault: false,
    ownerPhase: 20,
    purpose: 'Gates explicit-action Web Share after the private share-card preview and local download are verified.',
    rollback: 'Set VITE_WEB_SHARE=false and retain local PNG download.',
  },
  audioEnabled: {
    environmentVariable: RUNTIME_FLAG_ENV_KEYS.audioEnabled,
    valueKind: 'boolean',
    productionDefault: true,
    ownerPhase: 10,
    // The only flag in this matrix whose production default is `true`, and the reason
    // is the difference between a cutover gate and a kill switch. Every other flag
    // defaults to the behaviour that existed before its phase, so that a learner sees
    // no change until the cutover is reviewed. Audio has no previous behaviour to
    // preserve - Phase 10 builds the service - so the flag does not gate its arrival,
    // it gates its use, and the default build is the build the phase delivers.
    purpose:
      'Enables the renderer-neutral audio service built in Phase 10: gesture-gated playback, procedural synthesis with no media files, and persisted music and SFX volume. It is a rollback switch, not a cutover gate, so it defaults on and the plan’s rollback line - disable audio independently and retain procedural art fallbacks - is a build with it off.',
    rollback:
      'Set VITE_AUDIO_ENABLED=false to disable audio independently and retain the procedural art fallbacks. Nothing else is affected: no media is unloaded, no data is migrated, and the procedural art recipes are untouched.',
  },
} as const satisfies FeatureFlagMatrix;

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
