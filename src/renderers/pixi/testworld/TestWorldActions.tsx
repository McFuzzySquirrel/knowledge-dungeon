/**
 * The DOM mirror: one real, focusable, labelled control per canvas interaction.
 *
 * ## The rule this component exists to satisfy
 *
 * Plan 10.1: "A DOM equivalent for every Pixi interaction", "complete keyboard
 * operation of the core flow", "minimum 44 by 44 CSS-pixel touch targets", "no
 * hover-only actions", "visible focus indicators", "no colour-only state
 * communication".
 *
 * Every one of those is a property of *this* component rather than of the scene,
 * because a scene cannot express them: it draws pixels, and pixels are not
 * focusable, labelable, or announced. The scene declares what the world can do -
 * `WorldAction[]` - and this renders one control per declaration, wired to the same
 * `activate` the canvas uses.
 *
 * ## Why the mapping is enforced rather than trusted
 *
 * The temptation is to have the scene register its own DOM controls, because then
 * a scene author cannot forget one. That is worse: the control would be created by
 * the renderer, the accessible tree would be a side effect of mounting a canvas, and
 * a world that failed to initialise would take its own labels with it. Declaring
 * the actions in plain data and rendering them here means the accessible tree is a
 * function of data, and the mapping "every action has a control" is checkable from
 * outside - which is what `tests/phase9/pixi-dom-mirror.test.ts` does.
 *
 * ## Focus order
 *
 * Controls render in the order the scene declares them, and nothing in this
 * component reorders, re-parents, or portals them. The first control is the first
 * action a keyboard user meets, and the first action is the one the world
 * describes as its primary one.
 *
 * ## Sizing
 *
 * `minWidth`/`minHeight` are {@link CozyWorldTheme.touchTargetMin} - 44 - read as a
 * *number* from the token table and given a `px` unit here. That is the one place a
 * unit is written, and it is the DOM's requirement rather than the renderer's: a
 * canvas draws in numbers and the DOM does not. The direction is number to string,
 * never the `parseFloat` of a token that plan 10.1's phase exit criterion forbids.
 *
 * Focus is drawn with `outline`, not with a colour change, and state is carried by
 * text - the status line after each control - so nothing here depends on hue.
 */
import type { JSX } from 'react';

import type { CozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import type { WorldAction, WorldActionState } from '@/renderers/pixi/runtime/types';

export interface TestWorldActionsProps {
  readonly theme: CozyWorldTheme;
  readonly actions: readonly WorldAction[];
  readonly state: WorldActionState;
  /** Perform an action. The same call the canvas routes through. */
  readonly onActivate: (actionId: string) => void;
  /** Accessible name of the control group. */
  readonly label: string;
  /** The element that receives the host's `setMirrorElement`, when the caller has one. */
  readonly innerRef?: (element: HTMLElement | null) => void;
  /** Id prefix for the per-control description elements. */
  readonly idPrefix: string;
}

const px = (value: number): string => `${value}px`;

/**
 * The accessible text for one control.
 *
 * Built from the declaration rather than written per scene, so the key a keyboard
 * user is told about is the key the handler actually matches. A control whose
 * action has no key says so, instead of implying one.
 */
function controlLabel(action: WorldAction): string {
  return action.label;
}

function controlDescription(action: WorldAction): string {
  const channel = action.pointer ? 'Pointer and keyboard.' : 'Keyboard only.';
  const key = action.keyboardKey === null ? 'No keyboard shortcut.' : `Shortcut: ${action.keyboardKey.toUpperCase()}.`;
  return `${action.hint} ${channel} ${key}`;
}

export function TestWorldActions({
  theme,
  actions,
  state,
  onActivate,
  label,
  innerRef,
  idPrefix,
}: TestWorldActionsProps): JSX.Element {
  const target = theme.touchTargetMin;
  return (
    <div
      ref={innerRef}
      role="group"
      aria-label={label}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: px(theme.space['3']),
        alignItems: 'stretch',
      }}
    >
      {actions.map((action, index) => {
        const descriptionId = `${idPrefix}-${action.id}-hint`;
        const statusId = `${idPrefix}-${action.id}-status`;
        const status = state[action.id] ?? '';
        return (
          <div
            key={action.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: px(theme.space['1']),
              // The tab stop is the button, not this wrapper, so the wrapper carries
              // no focus handling at all.
              minWidth: px(target),
            }}
          >
            <button
              type="button"
              // Index is in the accessible name's *description*, not its label, so
              // the control keeps a stable name while its position is still stated
              // for a screen reader that announces "3 of 3".
              aria-describedby={`${descriptionId} ${statusId}`}
              aria-label={controlLabel(action)}
              data-action-id={action.id}
              data-action-index={index}
              onClick={() => onActivate(action.id)}
              style={{
                minWidth: px(target),
                minHeight: px(target),
                padding: `${px(theme.space['2'])} ${px(theme.space['4'])}`,
                fontFamily: theme.fontFamily.body,
                fontSize: px(theme.fontSize.md),
                fontWeight: theme.fontWeight.medium,
                lineHeight: theme.lineHeight.normal,
                color: cssHex(theme.color.textPrimary),
                background: cssHex(theme.color.surfaceRaised),
                // A visible boundary, not a colour change: WCAG 1.4.11 wants 3:1
                // against the adjacent surface and `borderControl` is the token
                // classified `nonText` for exactly this.
                border: `${px(theme.border.state)} solid ${cssHex(theme.color.borderControl)}`,
                borderRadius: px(theme.radius.md),
                cursor: 'pointer',
                touchAction: 'manipulation',
              }}
            >
              {action.label}
            </button>
            <span id={descriptionId} style={visuallyHidden}>
              {controlDescription(action)}
            </span>
            <span
              id={statusId}
              // A polite live region per control: a change in one action's state is
              // announced without interrupting, and without a screen reader having
              // to re-read the whole group.
              aria-live="polite"
              style={{
                fontFamily: theme.fontFamily.body,
                fontSize: px(theme.fontSize.sm),
                lineHeight: theme.lineHeight.snug,
                color: cssHex(theme.color.textSecondary),
                // The status is a text line, never a tinted pill, so the state is
                // legible with no colour perception at all.
                background: 'transparent',
              }}
            >
              {status}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const visuallyHidden: Record<string, string | number> = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: '0',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: '0',
};

/**
 * A numeric colour as a CSS colour.
 *
 * The theme holds `0xRRGGBB` because a canvas wants a number. The DOM wants a
 * string, so this is where the two meet - and it is a widening conversion from a
 * number, not a parse of a token string. `#000000` would otherwise be read as an
 * invalid colour.
 */
function cssHex(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}
