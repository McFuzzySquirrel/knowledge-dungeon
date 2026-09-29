/**
 * The Phase 9 test world: a sprite, a keyboard action, a pointer action, and a DOM
 * mirror for each.
 *
 * ## Why a test world at all
 *
 * Phase 9's non-goals rule out the Village, the dungeon, and the fishing world, but
 * "no world implementation" is not "no world": the host has to prove that a
 * renderer mounts, presents a frame, responds to input, pauses when the document is
 * hidden, honours reduced motion, and leaves nothing behind when it unmounts. None of
 * that is observable without something on the stage.
 *
 * So this scene is deliberately small and deliberately *honest about what it is*: a
 * lantern and a bell, drawn with `Graphics`, labelled in text, and wired to two
 * actions. Every property Phase 9's exit criteria name is exercised here, and nothing
 * else is claimed.
 *
 * ## No external media
 *
 * The sprite is drawn procedurally and its texture is generated from that drawing,
 * so this module adds no file to the CC0 registry, no request to the network, and no
 * dependency on Phase 10's asset bundles. `tests/phase9/pixi-host-boundary.test.ts`
 * asserts that no module under `src/renderers/` names an asset path.
 *
 * ## The two actions, and what they prove
 *
 * | Action       | Canvas                | DOM mirror            | Proves                                  |
 * |--------------|-----------------------|-----------------------|-----------------------------------------|
 * | `light`      | key `L`               | a labelled `<button>` | a keyboard action is mirrored in the DOM |
 * | `ring`       | pointer on the sprite | a labelled `<button>` | a pointer action is mirrored in the DOM |
 *
 * `ring` is reachable three ways - pointer, key `B`, and the mirror button - which
 * is the concrete demonstration of plan 10.1's "a DOM equivalent for every Pixi
 * interaction": a keyboard user can do everything a pointer user can do. The three
 * routes are three *ways in*, not three actions: the bell's pointer handler calls the
 * host's dispatcher (`init.onAction`) rather than its own {@link TestWorldScene.activate},
 * because the action and the state announcement that follows it have to be one
 * function, and only the host owns both. A scene that called its own `activate` rang
 * the bell and left the mirror stale - see `types.ts` for the whole of that story.
 *
 * ## The read-out is a projection of `readState()`, not a caption of its own
 *
 * The canvas draws the same sentence the DOM mirror announces, from the same
 * function, in the same words. It used to hold a private template ("Lantern unlit",
 * "Bell quiet") that was written once at construction and never updated, so it said
 * the same thing before and after every action and disagreed with the mirror even at
 * rest. It is `aria-hidden`, so that is not an accessibility defect - but a world that
 * draws a state caption which is false from the first interaction is not finished, and
 * a learner with the mirror beside the canvas is being told two different things.
 * `tests/phase9/test-world-scene.test.ts` pins the agreement.
 *
 * ## Reduced motion is observable, not asserted
 *
 * `light` grows the lantern by `motion.travelPx('large')`, which is `0` under
 * reduced motion. So with the preference on the *count* still increments and the
 * lantern still changes colour - the state change is information - while the
 * lantern's size does not change at all, because a size change is motion. The
 * distinction is the whole of what reduced motion means here, and it is legible in
 * the numbers rather than in a comment.
 */
import { Container, Graphics, Text } from 'pixi.js';

import { cozyTextStyle } from '@/renderers/pixi/runtime/cozyWorldTheme';
import type {
  CozyWorldTheme,
  WorldAction,
  WorldActionSource,
  WorldActionState,
  WorldScene,
  WorldSceneInit,
} from '@/renderers/pixi/runtime/types';
import type { PixiApplication } from '@/renderers/pixi/runtime/createPixiApplication';
import type { CozyMotionProfile } from '@/theme';

/** The action ids, as constants, so the DOM mirror and the scene cannot misspell one. */
export const TEST_WORLD_ACTIONS = Object.freeze({
  light: 'light-lantern',
  ring: 'ring-bell',
} as const);

export type TestWorldActionId = (typeof TEST_WORLD_ACTIONS)[keyof typeof TEST_WORLD_ACTIONS];

/**
 * The actions this world offers, in DOM focus order.
 *
 * `light` first because it is the action a keyboard user reaches first, and focus
 * order is part of the accessibility contract rather than a detail of the markup.
 * The `keyboardKey` is repeated in each label, so a screen-reader user and a
 * sighted keyboard user learn the same shortcut from the same control.
 */
export const TEST_WORLD_ACTION_LIST: readonly WorldAction[] = Object.freeze([
  Object.freeze({
    id: TEST_WORLD_ACTIONS.light,
    label: 'Light the lantern (key L)',
    hint: 'Adds one ember to the lantern on the test canvas.',
    keyboardKey: 'l',
    pointer: false,
  }),
  Object.freeze({
    id: TEST_WORLD_ACTIONS.ring,
    label: 'Ring the bell (key B)',
    hint: 'Rings the bell on the test canvas. Also responds to a pointer on it.',
    keyboardKey: 'b',
    pointer: true,
  }),
]);

/** How two per-action sentences become one caption. A full stop, not a comma: it is a sentence. */
const STATE_SENTENCE_SEPARATOR = '. ';

/**
 * The per-action state, which is the only description of the world in this design.
 *
 * Both surfaces render these strings and nothing else: the DOM mirror renders one per
 * control, and the canvas caption renders the set. There is no second vocabulary
 * anywhere in this world, which is why the two cannot drift apart.
 */
export function testWorldState(embers: number, rings: number): WorldActionState {
  return Object.freeze({
    [TEST_WORLD_ACTIONS.light]: `Lantern lit with ${embers} ${embers === 1 ? 'ember' : 'embers'}`,
    [TEST_WORLD_ACTIONS.ring]: rings === 0 ? 'Bell quiet' : `Bell rung ${rings} ${rings === 1 ? 'time' : 'times'}`,
  });
}

/**
 * The canvas caption for a state, in the mirror's own words and order.
 *
 * Built from {@link TEST_WORLD_ACTION_LIST} rather than from a hand-written sentence,
 * so the caption cannot fall behind the action list: an action added to the world
 * appears in the caption with no second edit, and an action removed disappears from
 * it. The two surfaces are the same strings from the same function, which is what
 * makes their agreement a property rather than a coincidence.
 */
export function testWorldCaption(state: WorldActionState): string {
  const sentences = TEST_WORLD_ACTION_LIST.map((action) => state[action.id] ?? '').filter(
    (sentence) => sentence.length > 0,
  );
  return sentences.length === 0 ? '' : `${sentences.join(STATE_SENTENCE_SEPARATOR)}.`;
}

/** What the scene exposes to the host, and what the tests read. */
export interface TestWorldScene extends WorldScene<never> {
  /** How many times the lantern has been lit. */
  readonly embers: number;
  /** How many times the bell has been rung. */
  readonly rings: number;
  /**
   * The lantern's drawn radius in CSS pixels.
   *
   * Exposed because "reduced motion scales motion to zero" is only a claim about a
   * number, and this is the number. A test reads it before and after an action
   * rather than inferring the answer from a screenshot.
   */
  readonly lanternRadius: number;
}

/**
 * Draw the lantern, once, and reuse the texture.
 *
 * `Graphics` here is v8's shape-then-fill form: every shape is described first and
 * then painted, and there is no `beginFill`. A texture generated from the drawing is
 * a normal `Texture`, so it is destroyed with the scene like any other resource and
 * nothing is left in a bundle cache - which matters because Phase 10 will own
 * bundle lifetimes, and this scene must not be the reason one leaks.
 */
function drawLantern(theme: CozyWorldTheme): Graphics {
  const unit = Math.max(8, Math.round(theme.space['4']));
  return new Graphics()
    .circle(0, 0, unit)
    .fill({ color: theme.color.accentDeep, alpha: 1 })
    .circle(0, 0, Math.round(unit * 0.62))
    .fill({ color: theme.color.accent, alpha: 1 })
    .stroke({ width: theme.border.state, color: theme.color.borderStrong, alignment: 0.5 });
}

/** The bell, as a shape rather than a sprite, so it can be tinted and resized freely. */
function drawBell(theme: CozyWorldTheme): Graphics {
  const unit = Math.max(8, Math.round(theme.space['3']));
  return new Graphics()
    .roundRect(-unit, -unit, unit * 2, unit * 2, theme.radius.md)
    .fill({ color: theme.color.surfaceRaised, alpha: 1 })
    .stroke({ width: theme.border.state, color: theme.color.borderControl, alignment: 0.5 });
}

/**
 * Build the test world onto an application's stage.
 *
 * Everything the scene creates is recorded in one list and released in `destroy()`,
 * in reverse order of creation. That is the discipline Phase 10 inherits: a scene
 * that forgets a listener is a scene whose world leaks a listener every time the
 * learner navigates away, and the twenty-cycle criterion in plan section 10.2 is
 * measured over exactly that.
 */
export function createTestWorld(application: PixiApplication, init: WorldSceneInit): TestWorldScene {
  let theme = init.theme;
  let motion: CozyMotionProfile = theme.motion;

  const root = new Container();
  root.label = 'test-world';
  application.stage.addChild(root);

  const lantern = drawLantern(theme);
  const bell = drawBell(theme);
  root.addChild(lantern, bell);

  const readOut = new Text({
    // A placeholder, replaced before this factory returns by `renderReadOut()`. The
    // constructor cannot take the real sentence because the sentence is derived from
    // the state counters, which are declared below.
    text: '',
    style: {
      ...cozyTextStyle(theme, { role: 'body', size: 'md', color: 'textPrimary' }),
      // Wrapped, and re-wrapped to the surface in `layout()`. The caption is a whole
      // sentence per action now rather than a three-word label, and at the 320
      // CSS-pixel viewport plan 10.1 requires the core flow to work at, one line of
      // it ran off the right edge of the surface and was clipped - a caption that is
      // true and unreadable is not much better than one that is false.
      wordWrap: true,
    },
  });
  readOut.anchor.set(0, 0.5);
  root.addChild(readOut);

  let embers = 0;
  let rings = 0;
  let baseRadius = Math.max(8, Math.round(theme.space['4']));
  let pulse = 0;
  let size = { width: application.screen.width, height: application.screen.height };

  /**
   * The pointer target.
   *
   * `eventMode: 'static'` is required: the v8 default is `'passive'`, which hit-tests
   * nothing, and the failure is silent - the sprite renders and never responds. A
   * `hitArea` rather than the sprite's drawn bounds, because the drawn bounds of a
   * `Graphics` with a stroke are not what a learner aims at, and the plan's 44x44
   * minimum is a floor rather than an approximation.
   *
   * The hit area is sized in *world* pixels, so it is at least `touchTargetMin` CSS
   * pixels at resolution 1 and proportionally larger on a HiDPI surface, which is
   * the correct direction for a target. The hit area is on the bell itself rather
   * than on a wrapper, so the node a learner aims at and the node that listens are
   * the same one - a wrapper would need its position and its child's kept in step.
   */
  const targetHalf = Math.ceil(theme.touchTargetMin / 2);
  bell.hitArea = {
    contains: (x: number, y: number) =>
      x >= -targetHalf && x <= targetHalf && y >= -targetHalf && y <= targetHalf,
  };
  bell.eventMode = 'static';
  bell.cursor = 'pointer';

  const onPointerTap = (event: { stopPropagation(): void }): void => {
    // Claimed so the same tap cannot also reach the stage, which will grow a
    // hit-testable canvas in Phase 11.
    event.stopPropagation();
    // The host's dispatcher, not this scene's `applyAction`. The host performs the
    // action *and* republishes the state that follows it; a call to the local
    // implementation would ring the bell and leave the DOM mirror - the only place a
    // screen-reader user learns what happened - announcing the state from before the
    // tap. There is no second route, and no reference to `applyAction` below other
    // than the one place this object hands it to the host as `activate`.
    init.onAction(TEST_WORLD_ACTIONS.ring, 'pointer');
  };
  bell.on('pointertap', onPointerTap);

  /**
   * The action verb, and the only name it is bound to.
   *
   * It is a `const` rather than a method so that the scene holds exactly one
   * reference to it, and that reference is the `activate` property of the object
   * returned below - the handle the host keeps and nothing else in this module is
   * allowed to close over. Every other route in (the pointer handler above) goes out
   * through `init.onAction` and back in through the host. That is the shape
   * `tests/phase9/pixi-dispatch-ownership.test.ts` asserts against this file's source.
   */
  const applyAction = (actionId: string, source: WorldActionSource): boolean => {
    if (actionId === TEST_WORLD_ACTIONS.light) {
      embers += 1;
      // The displacement is the *scaled* travel, so reduced motion makes it zero
      // without the action becoming a no-op: the count still changes, and the
      // colour still changes, so the state is still legible.
      const grown = baseRadius + motion.travelPx('large') * embers;
      lantern.scale.set(grown / baseRadius);
      lantern.tint = embers % 2 === 0 ? theme.color.accent : theme.color.good;
      renderReadOut();
      return true;
    }
    if (actionId === TEST_WORLD_ACTIONS.ring) {
      rings += 1;
      // A source is reported but never branched on, so a keyboard route and a
      // pointer route cannot produce different worlds. The only thing the source
      // changes is the read-out's wording, which is information rather than state.
      pulse = motion.durationMs('quick') > 0 ? 1 : 0;
      bell.tint = source === 'dom' ? theme.color.info : theme.color.accent;
      renderReadOut();
      return true;
    }
    return false;
  };

  function readState(): WorldActionState {
    return testWorldState(embers, rings);
  }

  /**
   * Repaint the canvas caption from the state the mirror is about to be told.
   *
   * Called from the action verb and from construction, and nowhere else - so the
   * caption and `readState()` are the same words by construction rather than by
   * agreement between two hand-maintained strings.
   */
  function renderReadOut(): void {
    readOut.text = testWorldCaption(readState());
  }

  function update(deltaMs: number): void {
    // Nothing here moves on its own. A test world that animated would make the
    // reduced-motion assertion depend on a frame count, and this phase's claims are
    // about input, lifecycle, and policy - none of which need an idle animation.
    if (pulse > 0) {
      pulse = Math.max(0, pulse - deltaMs / Math.max(1, motion.durationMs('quick')));
    }
  }

  function onResize(width: number, height: number): void {
    size = { width, height };
    layout();
  }

  /**
   * Place everything from the surface size.
   *
   * A pure function of `size` and the tokens, so a resize is not a special case and
   * a 320-CSS-pixel viewport - the width plan 10.1 requires the core flow to work
   * at - is the same code path as a desktop one.
   */
  function layout(): void {
    const gap = theme.space['6'];
    const laneWidth = Math.max(theme.touchTargetMin, Math.floor((size.width - gap * 3) / 2));
    const laneHeight = Math.max(theme.touchTargetMin, Math.min(160, size.height - gap * 4));
    const top = Math.max(gap, Math.floor((size.height - laneHeight) / 2));

    lantern.position.set(gap + laneWidth / 2, top + laneHeight / 2);
    lantern.scale.set(1);
    bell.position.set(gap * 2 + laneWidth + laneWidth / 2, top + laneHeight / 2);
    bell.scale.set(1);
    readOut.position.set(gap, top + laneHeight + theme.space['2']);
    readOut.visible = size.width > 2 * gap + 2 * theme.touchTargetMin;
    // The wrap width follows the surface, so a resize re-wraps the caption instead of
    // leaving it laid out for the width it had when the world was built.
    readOut.style.wordWrapWidth = Math.max(theme.touchTargetMin, size.width - gap * 2);
    // Applied after the layout, so a resize cannot leave the lantern at a scale the
    // next `light` would then compound.
    baseRadius = Math.max(8, Math.round(theme.space['4']));
    if (embers > 0) {
      lantern.scale.set((baseRadius + motion.travelPx('large') * embers) / baseRadius);
    }
  }

  function setMotionProfile(profile: CozyMotionProfile): void {
    motion = profile;
    // Applied immediately rather than on the next `light`, so a learner who turns
    // reduced motion on mid-session sees a lantern that stops growing *now* rather
    // than after one more keypress.
    if (embers > 0) {
      lantern.scale.set((baseRadius + motion.travelPx('large') * embers) / baseRadius);
    }
  }

  layout();
  // Before the factory returns, so the very first frame the host presents already
  // carries the caption rather than an empty string for one tick.
  renderReadOut();

  return {
    get actions(): readonly WorldAction[] {
      return TEST_WORLD_ACTION_LIST;
    },
    get embers(): number {
      return embers;
    },
    get rings(): number {
      return rings;
    },
    get lanternRadius(): number {
      return baseRadius * lantern.scale.x;
    },
    activate: applyAction,
    readState,
    update,
    onResize,
    setMotionProfile,
    capabilities: undefined,
    destroy(): void {
      // Listeners first, then display objects in reverse creation order, then the
      // stage removal. `destroy` on a display object is idempotent in v8 only for
      // options, not for a second call, so each node is destroyed exactly once and
      // the parent is cleared rather than re-destroyed.
      bell.off('pointertap', onPointerTap);
      bell.eventMode = 'none';
      bell.hitArea = null;
      bell.removeAllListeners();
      readOut.destroy({ children: true });
      bell.destroy({ children: true });
      lantern.destroy({ children: true });
      root.removeChildren();
      root.destroy({ children: true });
    },
  };
}

/** Rebind the theme's motion profile onto a scene after a live preference change. */
export function applyMotionProfile(scene: TestWorldScene, profile: CozyMotionProfile): void {
  scene.setMotionProfile?.(profile);
}

/** The theme's type scale, exposed so a screen can size a caption to the same tokens. */
export function testWorldCaptionStyle(theme: CozyWorldTheme) {
  return cozyTextStyle(theme, { role: 'body', size: 'sm', color: 'textSecondary' });
}
