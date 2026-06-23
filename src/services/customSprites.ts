/**
 * Custom sprite persistence service.
 *
 * Handles saving, loading, resetting, and pack management for user-customized
 * sprite SVGs. Uses localStorage for web builds and Electron IPC for desktop.
 * Provides the `resolveSpriteUrl()` function that Phaser scenes use to get
 * the correct sprite URL (custom override or bundled fallback).
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
 */
export function saveCustomSpriteContent(spritePath: string, svgContent: string): void {
  if (!hasLocalStorage()) return;
  const trimmed = svgContent.trim();
  if (!trimmed.startsWith('<svg') && !trimmed.startsWith('<?xml')) return;
  safeSet(overrideKey(spritePath), svgContent);
}

/**
 * Delete a custom sprite override (restores to bundled original).
 */
export function resetCustomSpriteContent(spritePath: string): void {
  if (!hasLocalStorage()) return;
  safeRemove(overrideKey(spritePath));
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
 */
export function resetAllCustomSprites(): void {
  const paths = listCustomSpritePaths();
  for (const path of paths) {
    safeRemove(overrideKey(path));
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
// Sprite URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the URL for a sprite given its bundle-relative path.
 *
 * If the user has saved a custom override for this sprite, returns a blob URL
 * with the custom SVG content. Otherwise returns the bundled asset URL.
 *
 * Call `revokeSpriteBlobUrl()` when the blob is no longer needed (e.g. scene
 * shutdown) to free memory.
 */
export function resolveSpriteUrl(spritePath: string): string {
  const BASE = import.meta.env.BASE_URL;

  // Check localStorage for a custom override
  if (hasLocalStorage()) {
    const custom = safeGet(overrideKey(spritePath));
    if (custom) {
      const trimmed = custom.trim();
      // Validate SVG content: must start like SVG and parse as valid XML
      if (trimmed.startsWith('<svg') || trimmed.startsWith('<?xml')) {
        try {
          const parser = new DOMParser();
          const doc = parser.parseFromString(trimmed, 'image/svg+xml');
          if (doc.querySelector('parsererror')) throw new Error('parse error');
          const blob = new Blob([custom], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(blob);
          blobUrls.add(url);
          return url;
        } catch {
          // Malformed XML — clear the override silently
        }
      }
      safeRemove(overrideKey(spritePath));
    }
  }

  return `${BASE}assets/${spritePath}`;
}

const blobUrls = new Set<string>();

/**
 * Revoke all blob URLs created by `resolveSpriteUrl()`. Call this when a
 * scene is destroyed to free memory.
 */
export function revokeAllBlobUrls(): void {
  for (const url of blobUrls) {
    URL.revokeObjectURL(url);
  }
  blobUrls.clear();
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
 */
export async function saveCustomSpriteElectron(
  spritePath: string,
  svgContent: string,
): Promise<void> {
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
