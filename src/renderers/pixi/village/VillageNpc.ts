/**
 * One village NPC's display objects: the marker the player walks up to, the body
 * that bobs while it idles, and the ring that says "this one is the one in range".
 *
 * ## What this file is
 *
 * Presentation for a *single* {@link VillageNpc} record and nothing else. It draws,
 * it bobs, it highlights, it releases its own display objects. It does not decide
 * who is nearby, it does not choose a line of dialogue, and it does not know what
 * a quest step is - `NpcController.ts` owns the measurement, and the renderer-neutral
 * contract in `src/application/contracts/villageNpc.ts` owns the decision.
 *
 * ## Why it is a separate module from `createVillageScene.ts`
 *
 * Three reasons, in order of weight:
 *
 * 1. **Review surface.** `tests/phase9/pixi-host-boundary.test.ts` names every file
 *    in `src/renderers/**` permitted to import `pixi.js`, so "a scene draws display
 *    objects" is an enumerated, reviewable decision. Splitting the art out keeps
 *    `createVillageScene.ts` the world and makes this file the drawing.
 * 2. **The plan named it.** Phase 12's expected files are `VillageNpc.ts` and
 *    `NpcController.ts`; a single 1500-line scene file would quietly not be them.
 * 3. **It is testable on its own terms.** The bob is a function of elapsed
 *    milliseconds and a motion profile, the highlight is a function of a boolean,
 *    and neither needs a world to assert.
 *
 * ## No texture, no asset key, no custom sprite
 *
 * The village's SVG sprites under `public/assets/sprites/village/` are
 * `legacy-unverified` and are not admitted to a Pixi bundle by the CC0 gate, so the
 * whole Pixi village is drawn procedurally (`Graphics` and `Text`). Adding an
 * `Assets` key here would make this file the one place in the village that needs
 * the bundle to have succeeded before it can draw, which is a failure mode the
 * Phaser scene does not have: it `continue`s past a missing texture and the village
 * still appears.
 *
 * ## Depth
 *
 * `VILLAGE_DEPTH.groundDecor` (9) - the same layer the Phaser scene puts NPCs on,
 * which sorts them below the player (10) and below the foreground decorations (11).
 * A villager therefore walks *behind* a tree, exactly as she does today, rather than
 * being pasted on top of everything because a new display object was appended last.
 */
import { Container, Graphics } from 'pixi.js';

import { VILLAGE_DEPTH, type VillageNpc } from '@/data/villageLayout';
import type { CozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import type { CozyMotionProfile } from '@/theme';
import type { CozyColorToken } from '@/theme/cozyTokens';

/**
 * Idle-bob half-period, in milliseconds.
 *
 * The Phaser scene tweens each NPC's `y` by three pixels over 1500 ms, yoyo, forever.
 * Same period here so the village's rhythm is unchanged.
 */
const BOB_PERIOD_MS = 1500;

/**
 * How far the bob can travel, as a fraction of one motion-travel step.
 *
 * `small` is 6 pixels at full motion, so half of it is the Phaser scene's 3. Under
 * `prefers-reduced-motion` the profile's travel is `0`, so the bob amplitude is `0`
 * and the villagers stand still - the same treatment `animateBirds` gives the birds,
 * and the same reason: a decorative loop that the learner has asked to stop.
 */
const BOB_TRAVEL_STEP = 'small';
const BOB_TRAVEL_FRACTION = 0.5;

/**
 * Per-NPC body colours, in roster order.
 *
 * Theme tokens rather than literal hex, because a token is what lets a learner
 * switching to a high-contrast or sepia palette get a legible villager in every one
 * of them. The `Keeper` is `accentDeep` because she is the one NPC a learner is
 * told to find, and the wanderers cycle the four remaining identity tokens so two
 * villagers standing together are distinguishable at a glance.
 */
const BODY_TOKENS: readonly CozyColorToken[] = Object.freeze([
  'accentDeep',
  'good',
  'info',
  'warning',
  'accent',
]);

/** Everything `createVillageNpc` needs. */
export interface CreateVillageNpcOptions {
  /** The renderer-neutral NPC record this marker presents. */
  readonly npc: VillageNpc;
  /** Cozy tokens, already numbers. A renderer never sees a CSS length. */
  readonly theme: CozyWorldTheme;
  /**
   * Index into the roster, used for the body colour and to stagger the idle bob.
   *
   * Taken rather than derived from the id so two villagers never share a colour
   * purely because their ids sort alike, and so re-sorting the roster cannot silently
   * repaint somebody.
   */
  readonly index: number;
}

/**
 * One NPC's live marker.
 *
 * The world position is held here rather than on the container so the idle bob can
 * offset the container's `y` without the controller having to subtract it again
 * before measuring a distance. A distance computed from a bobbing `y` would flicker
 * the proximity boundary twice per bob cycle, which would emit `onNpcApproached`
 * and `onNpcLeft` in pairs for no reason.
 */
export interface VillageNpcVisual {
  /** The NPC id, exactly as the matching world event reports it. */
  readonly id: string;
  /** The human-facing name, for a nearby-action row's label. */
  readonly label: string;
  /** The labelled container, parented by the caller. */
  readonly container: Container;
  /** World-space x, in world pixels. */
  readonly x: number;
  /** World-space y, in world pixels. */
  readonly y: number;
  /** Place the NPC at a world position. */
  moveTo(x: number, y: number): void;
  /**
   * Advance the idle bob.
   *
   * `elapsedMs` is the scene's own monotonic elapsed time, not the frame delta, so a
   * dropped frame resumes the cycle where it was rather than restarting it.
   */
  update(elapsedMs: number, motion: CozyMotionProfile): void;
  /** Show or hide the "you can talk to me" ring. */
  setHighlighted(highlighted: boolean): void;
  /** Detach from the parent and release every display object. */
  destroy(): void;
}

/**
 * Build one NPC marker.
 *
 * The caller parents `container` and is responsible for the world layer's own
 * teardown; this function's `destroy` releases exactly what it created, which is
 * what the twenty-cycle mount/unmount memory gate measures.
 */
export function createVillageNpc(options: CreateVillageNpcOptions): VillageNpcVisual {
  const { npc, theme, index } = options;
  const bodyToken = BODY_TOKENS[index % BODY_TOKENS.length];
  const bobPhase = (index * 0.37) * Math.PI * 2;

  const container = new Container();
  container.label = `village-npc:${npc.id}`;

  // A soft ellipse so a villager reads as standing on the path rather than floating
  // above it. Drawn first so it is behind everything else in the subtree.
  const shadow = new Graphics();
  shadow.ellipse(0, 10, 11, 4).fill({ color: 0x000000, alpha: 0.22 });
  container.addChild(shadow);

  // The ring, drawn under the body so it reads as a ring *around* the villager
  // rather than a disc behind her.
  const ring = new Graphics();
  ring
    .circle(0, -4, 15)
    .stroke({ width: 2, color: theme.color.accent, alpha: 0.9 });
  ring.alpha = 0;
  container.addChild(ring);

  const body = new Graphics();
  body
    .roundRect(-8, -4, 16, 16, 6)
    .fill({ color: theme.color[bodyToken], alpha: 1 })
    .stroke({ width: 2, color: theme.color.borderStrong, alignment: 0.5 });
  container.addChild(body);

  const head = new Graphics();
  head
    .circle(0, -11, 6)
    .fill({ color: theme.color.surfaceRaised, alpha: 1 })
    .stroke({ width: 1.5, color: theme.color.borderStrong, alignment: 0.5 });
  container.addChild(head);

  // The whole marker sorts as one node: the Phaser scene's single `.setDepth(9)`.
  container.zIndex = VILLAGE_DEPTH.groundDecor;

  let worldX = 0;
  let worldY = 0;

  function applyPosition(): void {
    container.position.set(worldX, worldY);
  }

  return {
    id: npc.id,
    label: npc.label,
    container,
    get x(): number {
      return worldX;
    },
    get y(): number {
      return worldY;
    },
    moveTo(x: number, y: number): void {
      worldX = x;
      worldY = y;
      applyPosition();
    },
    update(elapsedMs: number, motion: CozyMotionProfile): void {
      const amplitude = motion.travelPx(BOB_TRAVEL_STEP) * BOB_TRAVEL_FRACTION;
      if (amplitude <= 0) {
        // Reduced motion: the marker sits exactly where the world put it.
        container.y = worldY;
        return;
      }
      // `bobPhase` staggers the villagers so they do not breathe in lockstep. The
      // Phaser scene starts every tween on the same frame, which reads as one
      // village-sized creature rather than six people.
      const phase = (elapsedMs / BOB_PERIOD_MS) * Math.PI * 2 + bobPhase;
      container.y = worldY - Math.sin(phase) * amplitude;
    },
    setHighlighted(highlighted: boolean): void {
      ring.alpha = highlighted ? 1 : 0;
    },
    destroy(): void {
      container.removeFromParent();
      container.destroy({ children: true });
    },
  };
}
