/**
 * The one frame every village panel body is placed in.
 *
 * ## What a caller gets
 *
 * The plan's Phase 12 requirement is "Cozy side panels on wide screens and bottom
 * sheets on touch devices", and the two are not the same control. So this
 * component takes the mode from {@link useVillageSurfaceMode} and applies the
 * semantics that mode implies:
 *
 * |                       | `side`                              | `sheet`                          |
 * |-----------------------|-------------------------------------|----------------------------------|
 * | role                  | (none - a labelled `region`)        | `role="dialog"`                  |
 * | takes focus on open   | no                                  | yes, on the container            |
 * | contains Tab          | no                                  | yes, via `useModalFocus`         |
 * | closes on Escape      | no                                  | yes                             |
 * | dismiss control       | yes, ≥44px, labelled                | yes, ≥44px, labelled             |
 *
 * The side panel deliberately does **not** take focus. A village panel opens as a
 * consequence of the *player walking*, not as a consequence of a user activating
 * anything, so moving focus into it would rip a keyboard user out of the world
 * every time they brushed past a building. It is a `region` instead: reachable
 * by Tab in document order, named by its heading, and announced by the caller's
 * live status sentence.
 *
 * The bottom sheet does take focus, because on a touch viewport the sheet covers
 * the part of the screen a thumb is on, so leaving focus behind it means the
 * learner's next Tab goes to a control they cannot see. Containment and
 * restoration both come from the shared `useModalFocus`, so this surface obeys
 * the same three rules `ConfirmDialog` and the Data Center do rather than a
 * second implementation of them.
 *
 * ## Why the dismiss control exists at all
 *
 * The pre-Phase-12 village had no way to close a panel except by walking away
 * from the structure, which is a *movement* instruction used as a *dismissal*
 * mechanism - unavailable to a keyboard user standing still, and unavailable to
 * anyone whose renderer is not currently reporting proximity. A labelled
 * ≥44-pixel button plus Escape is the DOM route to the same state.
 */
import { useId, type ReactNode } from 'react';

import { useModalFocus } from '@/ui/hooks/useModalFocus';

import './villagePanels.css';

import type { VillageSurfaceMode } from './villageTypes';

export interface VillagePanelProps {
  /** Which Cozy shape to take. From `useVillageSurfaceMode()`. */
  readonly mode: VillageSurfaceMode;
  /** The visible heading. Also the surface's accessible name. */
  readonly title: string;
  /** A short line under the heading. Omit rather than pass an empty string. */
  readonly subtitle?: string;
  /** One emoji or short glyph. Decorative, so it is hidden from assistive tech. */
  readonly icon: string;
  /** Closes the panel. Wired to the dismiss control and, on a sheet, to Escape. */
  readonly onClose: () => void;
  /** The panel body. */
  readonly children: ReactNode;
  /**
   * The `data-theme` value the surrounding screen is themed with.
   *
   * Passed rather than read from the preferences store so a panel can be themed
   * consistently with a screen that has already decided (the screen owns the one
   * `usePreferencesStore` subscription for the whole route).
   */
  readonly colorTheme: string;
  /**
   * Whether a sheet may be dismissed with Escape.
   *
   * `true` by default. A panel that is mid-operation passes `false` so the key
   * does not claim to work and then do nothing.
   */
  readonly dismissible?: boolean;
}

export function VillagePanel({
  mode,
  title,
  subtitle,
  icon,
  onClose,
  children,
  colorTheme,
  dismissible = true,
}: VillagePanelProps): ReactNode {
  const titleId = useId();
  const isSheet = mode === 'sheet';
  const panelRef = useModalFocus<HTMLElement>({
    // Only a sheet is a dialog. Passing `false` on the side panel means the hook
    // installs no listener and moves no focus, which is the point of the table in
    // this file's header.
    active: isSheet,
    onEscape: isSheet && dismissible ? onClose : null,
  });

  return (
    <section
      ref={panelRef}
      className={`village-info-panel village-panel village-panel--${mode} ui-skin`}
      data-village-surface={mode}
      data-theme={colorTheme}
      // A sheet is a dialog; a side panel is an unnamed-role `section` that
      // `aria-labelledby` promotes to a `region` landmark. Writing `undefined`
      // rather than `null` is what keeps the attribute off the element entirely.
      role={isSheet ? 'dialog' : undefined}
      // The world stays live and operable behind a sheet, so the sheet is *not*
      // modal. Saying `aria-modal="true"` here would be a lie the screen reader
      // would act on by hiding everything outside the dialog.
      aria-modal={isSheet ? false : undefined}
      aria-labelledby={titleId}
      // A dialog must be focusable to receive the focus `useModalFocus` gives it.
      tabIndex={isSheet ? -1 : undefined}
    >
      <div className="village-panel-header">
        <span className="village-info-portal-icon" aria-hidden="true">
          {icon}
        </span>
        <div>
          <h3 id={titleId}>{title}</h3>
          {subtitle ? <p className="village-info-meta">{subtitle}</p> : null}
        </div>
        <button
          type="button"
          className="village-panel-close"
          onClick={onClose}
          // The name says which surface it closes, so a screen-reader user
          // tabbing through several village buttons can tell them apart.
          aria-label={`Close ${title}`}
          data-village-touch-target="close"
          style={{ minWidth: '44px', minHeight: '44px' }}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {children}
    </section>
  );
}
