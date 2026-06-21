# Code Templates — Creating Phaser Game Objects

Full TypeScript snippets for each step of `create-phaser-game-object`.

## Step 2: Texture Loading

```typescript
// In DungeonScene.preload() or VillageScene.preload()
this.load.svg('dungeon-npc-mage', '/assets/sprites/npc-mage.svg', { width: 32, height: 32 });
this.load.image('village-tree-oak', '/assets/sprites/tree-oak.png');
this.load.spritesheet('player-walk', '/assets/sprites/player.png', { frameWidth: 32, frameHeight: 32 });
```

## Step 3: Object Creation

```typescript
// In DungeonScene.create() or the relevant generation function
const obj = this.add.image(tileX * 48 + 24, tileY * 48 + 24, 'dungeon-npc-mage');
this.physics.add.existing(obj);

const label = this.add.text(x, y - 20, 'Room Label', {
  fontFamily: '"Press Start 2P", monospace',
  fontSize: '12px',
  color: '#e8dcc8',
}).setOrigin(0.5);
```

## Step 4: Animation

```typescript
// Floating idle (NPCs, items)
this.tweens.add({
  targets: obj,
  y: obj.y - 4,
  duration: 1500,
  yoyo: true,
  repeat: -1,
  ease: 'Sine.easeInOut',
});

// Pulsing glow (portals, active objects)
this.tweens.add({
  targets: obj,
  scaleX: 1.1,
  scaleY: 1.1,
  alpha: 0.8,
  duration: 2000,
  yoyo: true,
  repeat: -1,
  ease: 'Sine.easeInOut',
});
```

## Step 5: Interactivity

```typescript
obj.setInteractive({ pixelPerfect: true });

obj.on('pointerdown', () => {
  useSessionStore.getState().setInteractTarget(objectId);
});

obj.on('pointerover', () => obj.setTint(0xaaaaaa));
obj.on('pointerout', () => obj.clearTint());
```

## Step 6: State Integration

```typescript
const roomState = subjectStore.getState().getRoom(roomId);
if (roomState.encounterState === 'ArtifactCollected') {
  obj.setVisible(false);
}
if (roomState.phaseState === 'ScribeActive') {
  obj.setAlpha(1);
} else {
  obj.setAlpha(0.4);
}
```

## Step 7: Procedural Generation Hook

```typescript
function buildDecorForRoom(roomIndex: number, floor: number, roomState: RoomMetadata) {
  const rng = seededRandom(roomIndex * 7 + floor);

  if (rng < 0.15) {
    this.add.image(/* bookshelf params */);
  } else if (rng < 0.30) {
    this.add.image(/* brazier params */);
  } else if (rng < 0.45) {
    this.add.image(/* chest params */);
  }
}
```
