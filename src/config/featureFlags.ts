import {
  parseRuntimeConfig,
  RUNTIME_FLAG_ENV_KEYS,
  type RuntimeConfig,
  type RuntimeConfigKey,
} from './runtimeConfig';

export type FeatureFlagOwnerPhase = 4 | 5 | 8 | 9 | 11 | 13 | 17 | 19 | 20;
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
 * Infrastructure contract for phased cutovers. This matrix is not a runtime or
 * user-facing settings surface, and flags must never contain learner data.
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
