import { describe, expect, it } from 'vitest';
import { FEATURE_FLAG_MATRIX, FEATURE_FLAGS } from '@/config/featureFlags';
import {
  DEFAULT_RUNTIME_CONFIG,
  parseRuntimeConfig,
  RUNTIME_FLAG_ENV_KEYS,
} from '@/config/runtimeConfig';

describe('runtime feature configuration', () => {
  it('uses the complete safe production default matrix', () => {
    expect(parseRuntimeConfig({})).toEqual({
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
  });

  it('parses every valid build-time override', () => {
    expect(
      parseRuntimeConfig({
        VITE_WORLD_RENDERER: 'pixi',
        VITE_STORAGE_REPOSITORY: 'v2',
        VITE_PIXI_VILLAGE: 'true',
        VITE_PIXI_DUNGEON: 'true',
        VITE_PIXI_FISHING: 'true',
        VITE_COZY_VISUALS: 'true',
        VITE_ADAPTIVE_ASSISTANCE: 'true',
        VITE_DATA_PRODUCTS_V2: 'true',
        VITE_WEB_SHARE: 'true',
      }),
    ).toEqual({
      worldRenderer: 'pixi',
      storageRepository: 'v2',
      pixiVillage: true,
      pixiDungeon: true,
      pixiFishing: true,
      cozyVisuals: true,
      adaptiveAssistance: true,
      dataProductsV2: true,
      webShare: true,
    });
  });

  it('normalizes surrounding whitespace and casing without accepting loose booleans', () => {
    expect(
      parseRuntimeConfig({
        VITE_WORLD_RENDERER: ' PIXI ',
        VITE_STORAGE_REPOSITORY: ' V2 ',
        VITE_PIXI_VILLAGE: ' TRUE ',
        VITE_WEB_SHARE: 'FALSE',
      }),
    ).toMatchObject({
      worldRenderer: 'pixi',
      storageRepository: 'v2',
      pixiVillage: true,
      webShare: false,
    });

    expect(() => parseRuntimeConfig({ VITE_PIXI_DUNGEON: '1' })).toThrow(
      'VITE_PIXI_DUNGEON must be one of: true, false',
    );
  });

  it('reports all invalid flags without echoing their values', () => {
    const privateValue = 'must-not-appear-in-diagnostics';
    let message = '';
    try {
      parseRuntimeConfig({
        VITE_WORLD_RENDERER: privateValue,
        VITE_STORAGE_REPOSITORY: privateValue,
        VITE_ADAPTIVE_ASSISTANCE: 'yes',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('VITE_WORLD_RENDERER must be one of: phaser, pixi');
    expect(message).toContain('VITE_STORAGE_REPOSITORY must be one of: legacy, v2');
    expect(message).toContain('VITE_ADAPTIVE_ASSISTANCE must be one of: true, false');
    expect(message).not.toContain(privateValue);
  });

  it('rejects non-string build values', () => {
    expect(() => parseRuntimeConfig({ VITE_WEB_SHARE: 1 })).toThrow(
      'VITE_WEB_SHARE must be one of: true, false',
    );
  });

  it('documents every planned flag with its owner, default, purpose, and rollback', () => {
    expect(Object.keys(FEATURE_FLAG_MATRIX)).toEqual(Object.keys(RUNTIME_FLAG_ENV_KEYS));

    for (const [key, definition] of Object.entries(FEATURE_FLAG_MATRIX)) {
      expect(definition.environmentVariable).toBe(RUNTIME_FLAG_ENV_KEYS[key as keyof typeof RUNTIME_FLAG_ENV_KEYS]);
      expect(definition.productionDefault).toBe(DEFAULT_RUNTIME_CONFIG[key as keyof typeof DEFAULT_RUNTIME_CONFIG]);
      expect(definition.ownerPhase).toBeGreaterThan(1);
      expect(definition.purpose.length).toBeGreaterThan(20);
      expect(definition.rollback.length).toBeGreaterThan(20);
    }

    expect(FEATURE_FLAGS).toEqual(DEFAULT_RUNTIME_CONFIG);
  });
});
