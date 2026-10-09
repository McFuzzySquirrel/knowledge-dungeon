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
  /**
   * Whether the audio service may construct a context and make sound.
   *
   * The one flag here that is not a cutover gate, and after the Phase 23 cutover the
   * only flag that is still a kill switch rather than a one-release rollback. Every
   * other flag below now defaults to the post-cutover behaviour and exists to restore
   * the pre-cutover behaviour; audio has no pre-phase behaviour to keep, so it defaults
   * to `true` and exists to be turned off. That is what the Phase 10 rollback line asks
   * for - "Disable audio independently and retain procedural art fallbacks" - which
   * only means something if there is audio to disable.
   */
  readonly audioEnabled: boolean;
  readonly creatorWorkspace: boolean;
  readonly scribeEncounterWorkspace: boolean;
  readonly archaeologistReviewWorkspace: boolean;
  /**
   * Whether the offline static-shell service worker may be registered.
   *
   * A cutover gate for Phase 22, now on by default after the Phase 23 cutover. The
   * production build registers the shell service worker; `VITE_OFFLINE_SHELL=false` is
   * the one-release rollback, and with it off the build emits no `sw.js`, no shell
   * manifest, and no registration script, restoring the pre-Phase-22 artifact. The
   * worker caches build-time shell assets only and never caches learner data.
   */
  readonly offlineShell: boolean;
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
  audioEnabled: 'VITE_AUDIO_ENABLED',
  creatorWorkspace: 'VITE_CREATOR_WORKSPACE',
  scribeEncounterWorkspace: 'VITE_SCRIBE_ENCOUNTER_WORKSPACE',
  archaeologistReviewWorkspace: 'VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE',
  offlineShell: 'VITE_OFFLINE_SHELL',
} as const satisfies Readonly<Record<RuntimeConfigKey, string>>;

/**
 * Production defaults after the Phase 23 cutover. The PixiJS worlds, storage-v2, the Cozy
 * visual system, data products, Gentle assistance, Web Share, the redesigned workspaces,
 * and the offline shell are on by default. Each corresponding flag is retained for one
 * release as a documented rollback to its pre-cutover behaviour, declared in
 * `CUTOVER_FLAG_ROLLBACKS` in `./featureFlags`. `audioEnabled` is the only kill switch.
 *
 * `worldRenderer` does **not** move at the cutover: it stays `'phaser'`. It is a retained
 * host switch, not a world-renderer cutover. The real PixiJS worlds are selected by the
 * per-world flags (`pixiVillage`, `pixiDungeon`, `pixiFishing`) inside the screens, and
 * the `'pixi'` value selects the Phase 9 test host (`PixiWorldHost`), not a production
 * world. Phase 24 removes the flag. See `RETAINED_HOST_FLAG_KEYS` in `./featureFlags`.
 */
export const DEFAULT_RUNTIME_CONFIG: Readonly<RuntimeConfig> = Object.freeze({
  worldRenderer: 'phaser',
  storageRepository: 'v2',
  pixiVillage: true,
  pixiDungeon: true,
  pixiFishing: true,
  cozyVisuals: true,
  adaptiveAssistance: true,
  dataProductsV2: true,
  webShare: true,
  audioEnabled: true,
  creatorWorkspace: true,
  scribeEncounterWorkspace: true,
  archaeologistReviewWorkspace: true,
  offlineShell: true,
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
    audioEnabled: parseBoolean('audioEnabled', DEFAULT_RUNTIME_CONFIG.audioEnabled),
    creatorWorkspace: parseBoolean(
      'creatorWorkspace',
      DEFAULT_RUNTIME_CONFIG.creatorWorkspace,
    ),
    scribeEncounterWorkspace: parseBoolean(
      'scribeEncounterWorkspace',
      DEFAULT_RUNTIME_CONFIG.scribeEncounterWorkspace,
    ),
    archaeologistReviewWorkspace: parseBoolean(
      'archaeologistReviewWorkspace',
      DEFAULT_RUNTIME_CONFIG.archaeologistReviewWorkspace,
    ),
    offlineShell: parseBoolean('offlineShell', DEFAULT_RUNTIME_CONFIG.offlineShell),
  };

  if (errors.length > 0) {
    throw new Error(`Invalid build-time feature flags: ${errors.join('; ')}`);
  }

  return Object.freeze(config);
}
