import Phaser from 'phaser';

export const FLOOR_BIOME_IDS = [
  'knowledgeDungeon',
  'mathematicsCaverns',
  'scienceLabs',
  'historyRuins',
  'languageLibrary',
] as const;

export type FloorBiomeId = (typeof FLOOR_BIOME_IDS)[number];

interface FloorBiomePalette {
  base: number;
  mottles: readonly number[];
  fleck: number;
  grain: number;
  crack: number;
  edgeMin: number;
  edgeMax: number;
}

const TILE_SIZE = 64;

const FLOOR_BIOME_PALETTES: Record<FloorBiomeId, FloorBiomePalette> = {
  knowledgeDungeon: {
    base: 0x2f3136,
    mottles: [0x3b3d42, 0x45474c, 0x25272b],
    fleck: 0xc7bb94,
    grain: 0x6a624e,
    crack: 0x181818,
    edgeMin: 48,
    edgeMax: 58,
  },
  mathematicsCaverns: {
    base: 0x2d364a,
    mottles: [0x3e4a62, 0x596680, 0x222a3a],
    fleck: 0x6fd5e9,
    grain: 0x7f8ca6,
    crack: 0x161d2a,
    edgeMin: 52,
    edgeMax: 66,
  },
  scienceLabs: {
    base: 0x30373d,
    mottles: [0x454f57, 0x5c6872, 0x262d31],
    fleck: 0x87c88e,
    grain: 0x6e7a83,
    crack: 0x171c1f,
    edgeMin: 50,
    edgeMax: 64,
  },
  historyRuins: {
    base: 0x2f3850,
    mottles: [0x3e4a68, 0x53617f, 0x242c3d],
    fleck: 0x8ab6e8,
    grain: 0x7083a5,
    crack: 0x1b2231,
    edgeMin: 62,
    edgeMax: 82,
  },
  languageLibrary: {
    base: 0x2a3452,
    mottles: [0x374464, 0x4b5a80, 0x202a41],
    fleck: 0xa7bff3,
    grain: 0x6e80ab,
    crack: 0x181f32,
    edgeMin: 58,
    edgeMax: 80,
  },
};

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

export function resolveFloorBiome(seed: number, override?: FloorBiomeId): FloorBiomeId {
  if (override) return override;
  const normalizedSeed = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  return FLOOR_BIOME_IDS[normalizedSeed % FLOOR_BIOME_IDS.length];
}

export function floorBiomeTextureKey(biome: FloorBiomeId): string {
  return `kd-floor-biome-${biome}`;
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