export const WORLD_RENDERERS = ['phaser', 'pixi'] as const;
export const STORAGE_REPOSITORIES = ['legacy', 'v2'] as const;

export type WorldRenderer = (typeof WORLD_RENDERERS)[number];
export type StorageRepository = (typeof STORAGE_REPOSITORIES)[number];

export interface RuntimeConfig {
  readonly worldRenderer: WorldRenderer;
  readonly storageRepository: StorageRepository;
  readonly pixiVillage: boolean;
  readonly pixiDungeon: boolean;
  readonly pixiFishing: boolean;
  readonly cozyVisuals: boolean;
  readonly adaptiveAssistance: boolean;
  readonly dataProductsV2: boolean;
  readonly webShare: boolean;
}

export type RuntimeConfigKey = keyof RuntimeConfig;

/** Build-time environment contract. These values must never contain learner data. */
export const RUNTIME_FLAG_ENV_KEYS = {
  worldRenderer: 'VITE_WORLD_RENDERER',
  storageRepository: 'VITE_STORAGE_REPOSITORY',
  pixiVillage: 'VITE_PIXI_VILLAGE',
  pixiDungeon: 'VITE_PIXI_DUNGEON',
  pixiFishing: 'VITE_PIXI_FISHING',
  cozyVisuals: 'VITE_COZY_VISUALS',
  adaptiveAssistance: 'VITE_ADAPTIVE_ASSISTANCE',
  dataProductsV2: 'VITE_DATA_PRODUCTS_V2',
  webShare: 'VITE_WEB_SHARE',
} as const satisfies Readonly<Record<RuntimeConfigKey, string>>;

/**
 * Safe production defaults. Phaser and legacy localStorage remain active until
 * their separately reviewed cutover phases.
 */
export const DEFAULT_RUNTIME_CONFIG: Readonly<RuntimeConfig> = Object.freeze({
  worldRenderer: 'phaser',
  storageRepository: 'legacy',
  pixiVillage: false,
  pixiDungeon: false,
  pixiFishing: false,
  cozyVisuals: false,
  adaptiveAssistance: false,
  dataProductsV2: false,
  webShare: false,
});

function normalizedRawValue(
  environment: Readonly<Record<string, unknown>>,
  key: string,
): { present: false } | { present: true; value: string } | { present: true; value: null } {
  const raw = environment[key];
  if (raw === undefined) return { present: false };
  if (typeof raw !== 'string') return { present: true, value: null };
  return { present: true, value: raw.trim().toLowerCase() };
}

/**
 * Parse and validate the complete build-time flag set.
 *
 * Unset values use the safe defaults above. Explicit invalid values fail the
 * build/configuration load; invalid raw values are deliberately not echoed in
 * diagnostics because environment variables must never carry learner data.
 */
export function parseRuntimeConfig(
  environment: Readonly<Record<string, unknown>>,
): Readonly<RuntimeConfig> {
  const errors: string[] = [];

  function parseEnum<const T extends readonly string[]>(
    key: RuntimeConfigKey,
    allowedValues: T,
    fallback: T[number],
  ): T[number] {
    const parsed = normalizedRawValue(environment, RUNTIME_FLAG_ENV_KEYS[key]);
    if (!parsed.present) return fallback;
    if (parsed.value === null || !allowedValues.includes(parsed.value)) {
      errors.push(`${RUNTIME_FLAG_ENV_KEYS[key]} must be one of: ${allowedValues.join(', ')}`);
      return fallback;
    }
    return parsed.value as T[number];
  }

  function parseBoolean(key: RuntimeConfigKey, fallback: boolean): boolean {
    const parsed = normalizedRawValue(environment, RUNTIME_FLAG_ENV_KEYS[key]);
    if (!parsed.present) return fallback;
    if (parsed.value === 'true') return true;
    if (parsed.value === 'false') return false;

    errors.push(`${RUNTIME_FLAG_ENV_KEYS[key]} must be one of: true, false`);
    return fallback;
  }

  const config: RuntimeConfig = {
    worldRenderer: parseEnum('worldRenderer', WORLD_RENDERERS, DEFAULT_RUNTIME_CONFIG.worldRenderer),
    storageRepository: parseEnum(
      'storageRepository',
      STORAGE_REPOSITORIES,
      DEFAULT_RUNTIME_CONFIG.storageRepository,
    ),
    pixiVillage: parseBoolean('pixiVillage', DEFAULT_RUNTIME_CONFIG.pixiVillage),
    pixiDungeon: parseBoolean('pixiDungeon', DEFAULT_RUNTIME_CONFIG.pixiDungeon),
    pixiFishing: parseBoolean('pixiFishing', DEFAULT_RUNTIME_CONFIG.pixiFishing),
    cozyVisuals: parseBoolean('cozyVisuals', DEFAULT_RUNTIME_CONFIG.cozyVisuals),
    adaptiveAssistance: parseBoolean(
      'adaptiveAssistance',
      DEFAULT_RUNTIME_CONFIG.adaptiveAssistance,
    ),
    dataProductsV2: parseBoolean('dataProductsV2', DEFAULT_RUNTIME_CONFIG.dataProductsV2),
    webShare: parseBoolean('webShare', DEFAULT_RUNTIME_CONFIG.webShare),
  };

  if (errors.length > 0) {
    throw new Error(`Invalid build-time feature flags: ${errors.join('; ')}`);
  }

  return Object.freeze(config);
}
