import Phaser from 'phaser';
import { VillageScene, type VillageSceneEvents } from '@/game/scenes/VillageScene';
import type { VillageStructure } from '@/data/villageLayout';

export interface CreateVillageGameOptions {
  parent: HTMLElement;
  callbacks: VillageSceneEvents;
  dynamicStructures?: VillageStructure[];
  playerClass?: string;
}

export function createVillageGame(options: CreateVillageGameOptions): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: options.parent,
    backgroundColor: '#1a2a1a',
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
    scene: [VillageScene],
  });

  game.scene.start('VillageScene', {
    callbacks: options.callbacks,
    dynamicStructures: options.dynamicStructures,
    playerClass: options.playerClass,
  });

  return game;
}
