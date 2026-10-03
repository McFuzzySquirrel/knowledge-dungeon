import { describe, expect, it } from 'vitest';
import { FEATURE_FLAG_MATRIX, FEATURE_FLAGS, NON_CUTOVER_FLAG_KEYS } from '@/config/featureFlags';
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
      audioEnabled: true,
      creatorWorkspace: false,
      scribeEncounterWorkspace: false,
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
        VITE_AUDIO_ENABLED: 'true',
        VITE_CREATOR_WORKSPACE: 'true',
        VITE_SCRIBE_ENCOUNTER_WORKSPACE: 'true',
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
      audioEnabled: true,
      creatorWorkspace: true,
      scribeEncounterWorkspace: true,
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

describe('the Phase 14 Creator workspace flag', () => {
  it('exists, has an environment key, and defaults off three ways', () => {
    // The same three-way agreement every cutover gate states for its own flag: the safe
    // production default, the parsed default with no environment, and the declared
    // matrix default. Phase 14's rollback line is "retain the existing RoomPanel Creator
    // view behind the phase flag", which only means something if the default is already
    // the RoomPanel view.
    expect(RUNTIME_FLAG_ENV_KEYS.creatorWorkspace).toBe('VITE_CREATOR_WORKSPACE');
    expect(DEFAULT_RUNTIME_CONFIG.creatorWorkspace).toBe(false);
    expect(parseRuntimeConfig({}).creatorWorkspace).toBe(false);
    expect(FEATURE_FLAG_MATRIX.creatorWorkspace.productionDefault).toBe(false);
    expect(FEATURE_FLAG_MATRIX.creatorWorkspace.environmentVariable).toBe('VITE_CREATOR_WORKSPACE');
    expect(FEATURE_FLAG_MATRIX.creatorWorkspace.valueKind).toBe('boolean');
    expect(FEATURE_FLAG_MATRIX.creatorWorkspace.ownerPhase).toBe(14);
    expect(FEATURE_FLAG_MATRIX.creatorWorkspace.rollback).toContain('VITE_CREATOR_WORKSPACE=false');
    expect(FEATURE_FLAG_MATRIX.creatorWorkspace.rollback).toContain('RoomPanel Creator view');
  });

  it('parses exactly as the other cutover booleans parse, in all three spellings', () => {
    expect(parseRuntimeConfig({ VITE_CREATOR_WORKSPACE: 'false' }).creatorWorkspace).toBe(false);
    expect(parseRuntimeConfig({ VITE_CREATOR_WORKSPACE: 'true' }).creatorWorkspace).toBe(true);
    expect(parseRuntimeConfig({ VITE_CREATOR_WORKSPACE: ' TRUE ' }).creatorWorkspace).toBe(true);
    // A malformed value fails the build rather than silently defaulting, and the error
    // names the variable, never its value.
    expect(() => parseRuntimeConfig({ VITE_CREATOR_WORKSPACE: 'maybe' })).toThrow(
      'VITE_CREATOR_WORKSPACE must be one of: true, false',
    );
  });

  it('is a cutover gate, so it is not on the non-cutover list', () => {
    // It switches an existing behaviour (the RoomPanel Creator view) to a new one, so
    // its production default is the pre-phase behaviour. `audioEnabled` is the only
    // flag allowed to default on, and it says so by name; adding this one there would be
    // a claim that Phase 14 builds the Creator view rather than replaces it.
    expect(NON_CUTOVER_FLAG_KEYS).not.toContain('creatorWorkspace');
    expect(NON_CUTOVER_FLAG_KEYS).toEqual(['audioEnabled']);
  });
});

describe('the Phase 15 Scribe encounter workspace flag', () => {
  it('exists, has an environment key, and defaults off three ways', () => {
    // The same three-way agreement every cutover gate states for its own flag: the safe
    // production default, the parsed default with no environment, and the declared
    // matrix default. Phase 15's rollback line is "restore the existing modal as the
    // Scribe view", which only means something if the default already *is* the
    // NoteEditorModal.
    expect(RUNTIME_FLAG_ENV_KEYS.scribeEncounterWorkspace).toBe('VITE_SCRIBE_ENCOUNTER_WORKSPACE');
    expect(DEFAULT_RUNTIME_CONFIG.scribeEncounterWorkspace).toBe(false);
    expect(parseRuntimeConfig({}).scribeEncounterWorkspace).toBe(false);
    expect(FEATURE_FLAG_MATRIX.scribeEncounterWorkspace.productionDefault).toBe(false);
    expect(FEATURE_FLAG_MATRIX.scribeEncounterWorkspace.environmentVariable).toBe(
      'VITE_SCRIBE_ENCOUNTER_WORKSPACE',
    );
    expect(FEATURE_FLAG_MATRIX.scribeEncounterWorkspace.valueKind).toBe('boolean');
    expect(FEATURE_FLAG_MATRIX.scribeEncounterWorkspace.ownerPhase).toBe(15);
    expect(FEATURE_FLAG_MATRIX.scribeEncounterWorkspace.rollback).toContain(
      'VITE_SCRIBE_ENCOUNTER_WORKSPACE=false',
    );
    expect(FEATURE_FLAG_MATRIX.scribeEncounterWorkspace.rollback).toContain('NoteEditorModal');
    // The purpose names what it gates, so a future reader cannot mistake it for a flag
    // that changes what counts as a valid note. The flag selects a view; the validation
    // and progression rules are identical in both lanes.
    expect(FEATURE_FLAG_MATRIX.scribeEncounterWorkspace.purpose).toContain('NoteEditorModal');
  });

  it('parses exactly as the other cutover booleans parse, in all three spellings', () => {
    expect(parseRuntimeConfig({ VITE_SCRIBE_ENCOUNTER_WORKSPACE: 'false' }).scribeEncounterWorkspace).toBe(false);
    expect(parseRuntimeConfig({ VITE_SCRIBE_ENCOUNTER_WORKSPACE: 'true' }).scribeEncounterWorkspace).toBe(true);
    expect(parseRuntimeConfig({ VITE_SCRIBE_ENCOUNTER_WORKSPACE: ' TRUE ' }).scribeEncounterWorkspace).toBe(true);
    // A malformed value fails the build rather than silently defaulting, and the error
    // names the variable, never its value.
    expect(() => parseRuntimeConfig({ VITE_SCRIBE_ENCOUNTER_WORKSPACE: 'maybe' })).toThrow(
      'VITE_SCRIBE_ENCOUNTER_WORKSPACE must be one of: true, false',
    );
    // The default build reaches no renderer, storage generation, or product flag through
    // it: it is an independent cutover switch, so turning the Scribe workspace on does
    // not silently move any other flag with it.
    expect(parseRuntimeConfig({ VITE_SCRIBE_ENCOUNTER_WORKSPACE: 'true' })).toMatchObject({
      worldRenderer: 'phaser',
      storageRepository: 'legacy',
      dataProductsV2: false,
      adaptiveAssistance: false,
      creatorWorkspace: false,
    });
  });

  it('is a cutover gate, so it is not on the non-cutover list', () => {
    // It switches an existing behaviour (the NoteEditorModal) to a new one, so its
    // production default is the pre-phase behaviour. `audioEnabled` is the only flag
    // allowed to default on, and it says so by name; adding this one there would be a
    // claim that Phase 15 builds the Scribe view rather than replaces it.
    expect(NON_CUTOVER_FLAG_KEYS).not.toContain('scribeEncounterWorkspace');
    expect(NON_CUTOVER_FLAG_KEYS).toEqual(['audioEnabled']);
  });
});
