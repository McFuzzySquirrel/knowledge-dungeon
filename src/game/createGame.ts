import Phaser from 'phaser';
import { DungeonScene, type FloorVisibilityInput } from '@/game/scenes/DungeonScene';
import type { DungeonMap } from '@/game/systems/dungeonTypes';
import type { DungeonSceneEvents } from '@/game/scenes/DungeonScene';
import type { PlayerClassId } from '@/game/systems/playerClasses';
import type { ColorTheme } from '@/store/preferencesStore';

export interface CreateGameOptions {
  parent: HTMLElement;
  dungeonMap: DungeonMap;
  callbacks: DungeonSceneEvents;
  playerClass?: PlayerClassId | null;
  initialFloor?: FloorVisibilityInput;
  colorTheme?: ColorTheme;
}

const GAME_BACKGROUND_BY_THEME: Record<ColorTheme, string> = {
  dark: '#101a30',
  colorful: '#111b33',
  aurora: '#101a30',
};

export function createGame(options: CreateGameOptions): Phaser.Game {
  const theme = options.colorTheme ?? 'dark';
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: options.parent,
    backgroundColor: GAME_BACKGROUND_BY_THEME[theme],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: '100%',
      height: '100%',
    },
    physics: {
      default: 'arcade',
      arcade: { gravity: { x: 0, y: 0 }, debug: false },
    },
    scene: [DungeonScene],
  });

  game.scene.start('DungeonScene', {
    dungeonMap: options.dungeonMap,
    callbacks: options.callbacks,
    playerClass: options.playerClass ?? null,
    initialFloor: options.initialFloor,
  });

  return game;
}
