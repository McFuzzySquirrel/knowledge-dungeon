import Phaser from 'phaser';
import { DungeonScene, type FloorVisibilityInput } from '@/game/scenes/DungeonScene';
import type { DungeonMap } from '@/game/systems/dungeonTypes';
import type { DungeonSceneEvents } from '@/game/scenes/DungeonScene';
import type { PlayerClassId } from '@/game/systems/playerClasses';

export interface CreateGameOptions {
  parent: HTMLElement;
  dungeonMap: DungeonMap;
  callbacks: DungeonSceneEvents;
  playerClass?: PlayerClassId | null;
  initialFloor?: FloorVisibilityInput;
}

export function createGame(options: CreateGameOptions): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: options.parent,
    backgroundColor: '#1a120a',
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
