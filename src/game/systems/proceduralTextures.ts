/**
 * Phaser-side procedural floor textures.
 *
 * The renderer-neutral biome data (ids, palettes, texture keys, resolution)
 * lives in `src/core/biomes/floorBiomes.ts` and is re-exported below so
 * `DungeonScene` keeps importing from this path. The seeded PRNG, the tile
 * draw order, and `ensureBiomeFloorTexture` are Phaser drawing concerns and
 * stay here, producing byte-identical output for a given biome.
 */
import Phaser from 'phaser';
import {
  FLOOR_BIOME_PALETTES,
  floorBiomeTextureKey,
  type FloorBiomeId,
} from '@/core/biomes/floorBiomes';

export {
  FLOOR_BIOME_IDS,
  FLOOR_BIOME_PALETTES,
  floorBiomeTextureKey,
  getBiomePalette,
  resolveFloorBiome,
  type FloorBiomeId,
  type FloorBiomePalette,
} from '@/core/biomes/floorBiomes';

const TILE_SIZE = 64;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashLabel(label: string): number {
  let hash = 2166136261;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick<T>(values: readonly T[], rng: () => number): T {
  return values[Math.floor(rng() * values.length)];
}

export function ensureBiomeFloorTexture(scene: Phaser.Scene, biome: FloorBiomeId): string {
  const textureKey = floorBiomeTextureKey(biome);
  if (scene.textures.exists(textureKey)) {
    return textureKey;
  }

  const palette = FLOOR_BIOME_PALETTES[biome];
  const rng = mulberry32(hashLabel(`floor-biome:${biome}`));
  const g = scene.make.graphics({ x: 0, y: 0 });

  g.fillStyle(palette.base, 1);
  g.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

  for (let index = 0; index < 250; index += 1) {
    const x = Math.floor(rng() * TILE_SIZE);
    const y = Math.floor(rng() * TILE_SIZE);
    g.fillStyle(pick(palette.mottles, rng), 0.4);
    g.fillRect(x, y, 2, 2);
  }

  for (let index = 0; index < 40; index += 1) {
    const x = Math.floor(rng() * TILE_SIZE);
    const y = Math.floor(rng() * TILE_SIZE);
    g.fillStyle(palette.fleck, 0.08);
    g.fillRect(x, y, 1, 1);
  }

  for (let y = 0; y < TILE_SIZE; y += 4) {
    g.lineStyle(1, palette.grain, 0.03);
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(TILE_SIZE, y);
    g.strokePath();
  }

  for (let crack = 0; crack < 8; crack += 1) {
    let x = rng() * TILE_SIZE;
    let y = rng() * TILE_SIZE;

    g.lineStyle(1, palette.crack, 0.15);
    g.beginPath();
    g.moveTo(x, y);

    const segments = 3 + Math.floor(rng() * 4);
    for (let segment = 0; segment < segments; segment += 1) {
      x = (x + (rng() - 0.5) * 10 + TILE_SIZE) % TILE_SIZE;
      y = (y + (rng() - 0.5) * 10 + TILE_SIZE) % TILE_SIZE;
      g.lineTo(x, y);
    }
    g.strokePath();
  }

  for (let offset = 0; offset < TILE_SIZE; offset += 1) {
    const tone = palette.edgeMin + Math.floor(rng() * (palette.edgeMax - palette.edgeMin + 1));
    const color = Phaser.Display.Color.GetColor(tone, tone, tone);
    g.fillStyle(color, 0.2);
    g.fillRect(offset, 0, 1, 1);
    g.fillRect(offset, TILE_SIZE - 1, 1, 1);
    g.fillRect(0, offset, 1, 1);
    g.fillRect(TILE_SIZE - 1, offset, 1, 1);
  }

  g.generateTexture(textureKey, TILE_SIZE, TILE_SIZE);
  g.destroy();
  return textureKey;
}
