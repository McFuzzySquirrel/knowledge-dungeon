/**
 * The fishing HUD: the pond's instructions, its state in words, and the six controls.
 *
 * ## What this component is for
 *
 * Plan 6.2 gives instructional text and accessible controls to React DOM, and plan 10.1 asks
 * for "a DOM equivalent for every Pixi interaction". The fishing state machine has **six**
 * learner-triggerable transitions, tabulated in `fishingStateMachine.ts`'s header and restated
 * as a port in `fishingHudPort.ts`. This component is the six controls, one per transition,
 * plus the sentence that says what the pond is doing.
 *
 * Nothing here decides *whether* an action is legal. It asks `readout.phase` and enables the
 * control that the machine will accept; the machine still refuses anything illegal, so a
 * stale control and a canvas tap cannot disagree about what happened. That is the state
 * machine's own contract - "an illegal event is refused, never thrown" - restated for the DOM.
 *
 * ## Touch and keyboard parity, and what parity means here
 *
 * Exit criterion 1 is "a complete cast-to-catch-to-keep flow works using touch and keyboard".
 * Parity is not "there is also a key for it" - it is that **every** control responds to a
 * pointer press and to a key, and that a hold is a hold in both:
 *
 * - **The charge control** is one button. `pointerdown` calls `beginPower`, `pointerup` and
 *   `pointercancel` and `pointerleave` call `release`. `keydown` on `Space` or `Enter` calls
 *   `beginPower` and **`keyup` calls `release`**. A learner who taps the button with a finger
 *   and a learner who holds the space bar are doing the same thing, and a learner who *taps*
 *   the space bar charges and releases in the same gesture, which is the whole cast.
 * - **The walk pair** is held the same way, and additionally answers to `A` / `←` and
 *   `D` / `→` while *anywhere in the document*, not only while focused. That is deliberate:
 *   walking is a held intent, and a keyboard user who has to tab to a walk button before they
 *   can walk cannot walk and cast at the same time. The document-level listener is removed
 *   on unmount and when the phase leaves the three states walking is legal in.
 * - **The three tap controls** are plain buttons, so `Enter` and `Space` are the browser's
 *   own activation and no key handler is written for them at all - which is also why they
 *   cannot drift from the pointer path.
 *
 * Every control is ≥44×44 CSS pixels in the colocated stylesheet and carries the same floor
 * inline, for `villageTypes.ts`'s reason: a stylesheet rule cannot be asserted by a component
 * test.
 *
 * ## Why the charge control can lose focus and what happens then
 *
 * A pointer-driven hold has no guarantee that the pointer is still down when the component
 * re-renders, and `pointercancel` is not delivered to a window that scrolled away. So the
 * component tracks its own charge in a ref and clears it in exactly two places: the three
 * pointer-up paths, and `keyup` for the keyboard path. If both are somehow missed, the
 * machine's own `release` is refused in a phase that is no longer `powering`, so a lost
 * release cannot leave the pond stuck mid-charge with no way out - the learner presses
 * `Space`, gets a refused `beginPower`, and the phase sentence tells them what is actually
 * happening.
 *
 * ## Focus on a bite, and why that is not a surprise
 *
 * `biting` is a **two-second window** (`BITE_WINDOW_SEC`). Announcing it politely is not
 * enough for a keyboard or screen-reader user: by the time a polite announcement finishes
 * being read, the fish is gone. So the transition into `biting` moves focus to the set-hook
 * control - and *only* when focus was already inside this HUD, so it never yanks focus out of
 * something the learner deliberately focused elsewhere. The announcement still happens either
 * way, because it is the status channel and the focus move is the shortcut.
 *
 * ## No learner data
 *
 * No store, no subject name, no room name, no fish name. The readout is cast facts and the
 * copy is fixed strings; the only interpolated values are the charge percentage and the
 * session's kept-fish count, both derived from numbers the machine produced. Every id comes
 * from `FISHING_CONTROL_IDS`.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { FISHING_CONTROL_IDS } from '@/ui/study/controlIds';
import {
  FISHING_CONTROL_COPY,
  FISHING_INELIGIBLE_STATUS,
  FISHING_WALK_KEY_HINT,
  fishingPhaseCopy,
  formatCaughtCount,
  formatPowerPercent,
} from './fishingHudCopy';
import {
  type FishingHudMoveIntent,
  type FishingHudPort,
  type FishingHudReadout,
} from './fishingHudPort';

import './fishing.css';

/** Which key values mean "left" and which mean "right", for the document-level walk keys. */
const LEFT_KEYS: ReadonlySet<string> = new Set(['a', 'A', 'ArrowLeft']);
const RIGHT_KEYS: ReadonlySet<string> = new Set(['d', 'D', 'ArrowRight']);
/** The keys that press and release the charge control. */
const CHARGE_KEYS: ReadonlySet<string> = new Set([' ', 'Spacebar', 'Enter']);

export interface FishingHudProps {
  /**
   * The pond, as the controls reach it.
   *
   * Typed against the renderer-neutral {@link FishingHudPort}, which is proved identical to
   * the renderer's own `FishingController` in `tests/phase17/fishing-hud-port.test.ts`. Not a
   * structural base and not `any`: a control that could not reach the pond would compile.
   */
  readonly port: FishingHudPort;
  /** Leave the pond for the village. Defaults to the port's own. */
  readonly onReturnToVillage?: () => void;
}

/** Whether walking is legal in a phase. The machine allows it in three. */
function walkingLegal(phase: FishingHudReadout['phase']): boolean {
  return phase === 'idle' || phase === 'caught' || phase === 'missed';
}

export function FishingHud({ port, onReturnToVillage }: FishingHudProps): JSX.Element {
  const [readout, setReadout] = useState<FishingHudReadout>(() => port.readReadout());
  /**
   * Whether this component believes a charge is in flight.
   *
   * A ref rather than state, because it changes on a pointer gesture and must be readable
   * from the same gesture's other handler without a render in between. It also drives
   * `aria-pressed`, which is a state the learner can read as well as see.
   */
  const chargingRef = useRef(false);
  const [charging, setCharging] = useState(false);
  /**
   * The intent this component last sent, so a re-render never re-sends it and a walk that was
   * already stopped stays stopped.
   */
  const intentRef = useRef<FishingHudMoveIntent>(0);
  const [intent, setIntent] = useState<FishingHudMoveIntent>(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const hookControlRef = useRef<HTMLButtonElement | null>(null);
  const statusId = useId();
  const powerLabelId = useId();
  const walkHintId = useId();

  /**
   * The live readout, in one place.
   *
   * `onPhase` fires on the host's initial publish, after every dispatch, and on the
   * transitions the scene made to itself - the landing, the bite, the window expiry, the reel
   * completing. It never fires per frame, so holding the subscription for the life of the
   * mount is safe and needs no throttling.
   */
  useEffect(() => {
    const stop = port.onPhase((next) => setReadout(next));
    // A subscription that arrives before the world publishes would leave the HUD showing
    // the idle readout, so the current value is read once as well. `readReadout` is total,
    // so this cannot fail before the world exists.
    setReadout(port.readReadout());
    return stop;
  }, [port]);

  /**
   * The walk keys, on the document, for as long as walking is legal.
   *
   * Capture phase, and `preventDefault` on the arrows, so the arrow keys walk rather than
   * scroll the pond. Capture phase is what stops a control inside this HUD from swallowing
   * the Tab that a focus trap needs - the reason `useModalFocus` registers there too.
   */
  useEffect(() => {
    if (!walkingLegal(readout.phase)) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      const left = LEFT_KEYS.has(event.key);
      const right = RIGHT_KEYS.has(event.key);
      if (!left && !right) return;
      event.preventDefault();
      const next: FishingHudMoveIntent = left ? -1 : right ? 1 : 0;
      if (intentRef.current === next) return;
      intentRef.current = next;
      setIntent(next);
      port.move(next);
    };
    const releaseWalk = (): void => {
      if (intentRef.current === 0) return;
      intentRef.current = 0;
      setIntent(0);
      port.move(0);
    };
    document.addEventListener('keydown', handleKeyDown, true);
    // `keyup` on the document, not on the focused control: a learner who holds `D`, tabs
    // somewhere, and lets go must not leave the angler walking into the reeds forever.
    document.addEventListener('keyup', releaseWalk, true);
    window.addEventListener('blur', releaseWalk);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keyup', releaseWalk, true);
      window.removeEventListener('blur', releaseWalk);
      releaseWalk();
    };
  }, [port, readout.phase]);

  /**
   * Focus the hook control when a bite arrives, if this HUD already had focus.
   *
   * The two-second window is the reason, and the "already had focus" condition is what keeps
   * it from being a hijack: a learner reading something else in the page is not dragged into
   * the pond by a fish biting.
   */
  useEffect(() => {
    if (readout.phase !== 'biting') return;
    const root = rootRef.current;
    if (root === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && root.contains(active)) {
      hookControlRef.current?.focus();
    }
  }, [readout.phase]);

  /**
   * End a charge, from any of the five ways one can end.
   *
   * Guarded on the ref, so a `pointerup` with no `pointerdown` - a stray tap, a pointer that was
   * already down when the control mounted - sends nothing.
   */
  const endCharge = useCallback(() => {
    if (!chargingRef.current) return;
    chargingRef.current = false;
    setCharging(false);
    port.release();
  }, [port]);

  const beginCharge = useCallback(() => {
    chargingRef.current = true;
    setCharging(true);
    port.beginPower();
  }, [port]);

  const onChargePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      // Pointer capture, so a finger that slides off the button keeps the hold instead of
      // dropping it - and so the pointer-up is delivered here rather than nowhere.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      beginCharge();
    },
    [beginCharge],
  );

  const onChargePointerUp = useCallback(() => endCharge(), [endCharge]);

  const onChargeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!CHARGE_KEYS.has(event.key)) return;
      // `Space` scrolls the page by default and `Enter` re-submits an ancestor form; both
      // would fight the hold.
      event.preventDefault();
      if (event.repeat || chargingRef.current) return;
      beginCharge();
    },
    [beginCharge],
  );

  const onChargeKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!CHARGE_KEYS.has(event.key)) return;
      event.preventDefault();
      endCharge();
    },
    [endCharge],
  );

  /** Send a walking intent, if it differs from the one already held. */
  const setWalk = useCallback(
    (next: FishingHudMoveIntent) => {
      if (intentRef.current === next) return;
      intentRef.current = next;
      setIntent(next);
      port.move(next);
    },
    [port],
  );

  const phase = fishingPhaseCopy(readout.phase);
  const percent = formatPowerPercent(readout.power);
  const chargeLegal = readout.phase === 'idle' || readout.phase === 'powering';
  const hookLegal = readout.phase === 'biting';
  const canCastAgain = readout.phase === 'caught';
  const canTryAgain = readout.phase === 'missed';
  const copy = FISHING_CONTROL_COPY;
  const leave = onReturnToVillage ?? (() => port.returnToVillage());

  // A charge that the phase has already ended cannot be released usefully, so the flag is
  // dropped when the pond leaves `powering` without an explicit release having happened.
  useEffect(() => {
    if (readout.phase === 'powering') return;
    if (!chargingRef.current) return;
    chargingRef.current = false;
    setCharging(false);
  }, [readout.phase]);

  return (
    <section
      className="fishing-hud ui-skin"
      ref={rootRef}
      aria-label="Fishing controls"
      data-fishing-phase={readout.phase}
    >
      <h2 className="fishing-hud__heading">Fishing</h2>

      {/*
        The live channel. `role="status"` and not `role="alert"`: a bite is exciting but it
        is not an emergency, and an assertive region would interrupt a learner mid-sentence on
        every one of the eight phase changes in a cast.
      */}
      <p className="fishing-hud__phase" role="status" aria-live="polite" id={statusId}>
        <span className="fishing-hud__phase-name">{phase.phaseName}</span>
        <span>{phase.status}</span>
      </p>
      <p className="fishing-hud__instruction" aria-describedby={statusId}>
        {phase.instruction}
      </p>

      {readout.eligible ? null : (
        <p className="fishing-hud__phase-status" role="status" aria-live="polite">
          {FISHING_INELIGIBLE_STATUS}
        </p>
      )}

      {/*
        The power meter, and the number beside it.

        `role="progressbar"` with `aria-valuenow` in percent and `aria-valuetext` in words,
        because a meter whose value is only a width is a meter a screen reader cannot read. The
        visible percentage is not decoration either: plan 10.1 forbids colour-only state, and
        a charge is a state.
      */}
      <div className="fishing-hud__power">
        <span className="fishing-hud__power-readout" id={powerLabelId}>
          Cast strength: {percent}%
        </span>
        <div
          className="fishing-hud__power-track"
          role="progressbar"
          aria-labelledby={powerLabelId}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent} percent charged`}
          data-fishing-power={percent}
        >
          <span className="fishing-hud__power-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className="fishing-hud__controls">
        {/*
          Control 1 and 3: the charge hold. `aria-pressed` is the non-colour pressed signal
          (`COZY_STATE_SIGNALS`), and the label changes nothing on press because the label
          describes the action, not the state - the meter and the status line describe the
          state.
        */}
        <button
          type="button"
          id={FISHING_CONTROL_IDS.chargeHold}
          className="fishing-hud__control"
          aria-pressed={charging}
          aria-describedby={statusId}
          disabled={!chargeLegal || !readout.eligible}
          onPointerDown={onChargePointerDown}
          onPointerUp={onChargePointerUp}
          onPointerCancel={onChargePointerUp}
          onKeyDown={onChargeKeyDown}
          onKeyUp={onChargeKeyUp}
          style={{ minWidth: '44px', minHeight: '44px' }}
          data-fishing-touch-target="charge"
        >
          {copy.beginPower.label}
          <span className="fishing-hud__control-hint">{copy.beginPower.keys}</span>
        </button>

        {/* Control 4: the hook, inside the bite window. */}
        <button
          type="button"
          id={FISHING_CONTROL_IDS.setHook}
          ref={hookControlRef}
          className="fishing-hud__control"
          disabled={!hookLegal}
          aria-describedby={statusId}
          onClick={() => port.hook()}
          style={{ minWidth: '44px', minHeight: '44px' }}
          data-fishing-touch-target="hook"
        >
          {copy.hook.label}
          <span className="fishing-hud__control-hint">{copy.hook.keys}</span>
        </button>

        {/* Control 5: cast again, from a caught fish. */}
        <button
          type="button"
          id={FISHING_CONTROL_IDS.castAgain}
          className="fishing-hud__control"
          disabled={!canCastAgain}
          aria-describedby={statusId}
          onClick={() => port.reset()}
          style={{ minWidth: '44px', minHeight: '44px' }}
          data-fishing-touch-target="cast-again"
        >
          {copy.resetCaught.label}
          <span className="fishing-hud__control-hint">{copy.resetCaught.keys}</span>
        </button>

        {/* Control 6: try again, from a missed cast. */}
        <button
          type="button"
          id={FISHING_CONTROL_IDS.tryAgain}
          className="fishing-hud__control"
          disabled={!canTryAgain}
          aria-describedby={statusId}
          onClick={() => port.reset()}
          style={{ minWidth: '44px', minHeight: '44px' }}
          data-fishing-touch-target="try-again"
        >
          {copy.resetMissed.label}
          <span className="fishing-hud__control-hint">{copy.resetMissed.keys}</span>
        </button>
      </div>

      {/*
        Control 2: the walk pair. Two hold buttons rather than a d-pad, because two targets is
        two 44-pixel targets; a single four-way control would put the diagonals on the same
        button and make "walk and cast" impossible with one hand on a phone.
      */}
      <div className="fishing-hud__walk" id={walkHintId} role="group" aria-label="Walk along the shore">
        <button
          type="button"
          id={FISHING_CONTROL_IDS.walkLeft}
          className="fishing-hud__control"
          aria-pressed={intent === -1}
          aria-describedby={walkHintId}
          disabled={!walkingLegal(readout.phase) || !readout.eligible}
          onPointerDown={() => setWalk(-1)}
          onPointerUp={() => setWalk(0)}
          onPointerCancel={() => setWalk(0)}
          onPointerLeave={() => setWalk(0)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'a' && event.key !== 'A') return;
            event.preventDefault();
            setWalk(-1);
          }}
          onKeyUp={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'a' && event.key !== 'A') return;
            setWalk(0);
          }}
          style={{ minWidth: '44px', minHeight: '44px' }}
          data-fishing-touch-target="walk-left"
        >
          {copy.walkLeft.label}
          <span className="fishing-hud__control-hint">{copy.walkLeft.keys}</span>
        </button>
        <button
          type="button"
          id={FISHING_CONTROL_IDS.walkRight}
          className="fishing-hud__control"
          aria-pressed={intent === 1}
          aria-describedby={walkHintId}
          disabled={!walkingLegal(readout.phase) || !readout.eligible}
          onPointerDown={() => setWalk(1)}
          onPointerUp={() => setWalk(0)}
          onPointerCancel={() => setWalk(0)}
          onPointerLeave={() => setWalk(0)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'd' && event.key !== 'D') return;
            event.preventDefault();
            setWalk(1);
          }}
          onKeyUp={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'd' && event.key !== 'D') return;
            setWalk(0);
          }}
          style={{ minWidth: '44px', minHeight: '44px' }}
          data-fishing-touch-target="walk-right"
        >
          {copy.walkRight.label}
          <span className="fishing-hud__control-hint">{copy.walkRight.keys}</span>
        </button>
      </div>
      <p className="fishing-hud__walk-hint">{FISHING_WALK_KEY_HINT}</p>

      {/*
        Leaving the pond. A control here as well as the canvas one, because the canvas control
        is unreachable by a keyboard and by a screen reader.
      */}
      <div className="fishing-hud__controls">
        <button
          type="button"
          className="fishing-hud__control"
          onClick={leave}
          style={{ minWidth: '44px', minHeight: '44px' }}
          data-fishing-touch-target="return-to-village"
        >
          Return to the village
        </button>
      </div>

      {/*
        The session's own count, in words. It is a fact a learner would otherwise only be able
        to read off the canvas bucket, and it is stated here rather than in the status line so
        it does not re-announce on every phase change.
      */}
      <p className="fishing-hud__phase-status">
        Cast {readout.castNumber === 0 ? 'not started' : `number ${readout.castNumber}`}.{' '}
        {formatCaughtCount(readout.caughtCount)}.
      </p>
    </section>
  );
}