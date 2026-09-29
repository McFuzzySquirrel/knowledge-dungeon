/**
 * The surface the world canvas is inserted into.
 *
 * ## What "safe canvas insertion" means here
 *
 * The canvas a renderer creates is not a decorative image and it is not a control.
 * It is a full-surface drawing target that the host appends into an element it was
 * handed, and three things have to be true for that to be safe:
 *
 * 1. **It never reaches `document.body` by default.** A renderer that appends its
 *    own canvas to the body is a renderer whose canvas lands on top of whatever the
 *    application happens to have rendered, and whose teardown has to search the whole
 *    document to find it. The host is given an element; this component is that
 *    element, and it is a child of a named region rather than of the document.
 * 2. **It is hidden from assistive technology.** The canvas is `aria-hidden` (set by
 *    the host, before the renderer ever sees it) and this surface is labelled and
 *    described, so a screen reader is given the region's purpose and then the
 *    region group's real controls - never an unnamed canvas.
 * 3. **It has a box, and the box is the world's, not the canvas's.** A canvas in an
 *    element with no height collapses to `0` and a renderer asked to draw into a
 *    zero-sized surface computes `NaN` in every normalised coordinate. The height
 *    below is what makes the first frame real before layout settles, and it is large
 *    enough for a scene to draw its own affordances *and* the text beside them: see
 *    {@link WORLD_SURFACE_ROWS} for the measurement that fixes it.
 * 4. **The canvas cannot resize the surface.** The host sizes the renderer from the
 *    surface's padding box, and the surface's own borders sit outside that box, so the
 *    feedback has gain one. This element is the box; the canvas is a child that has to
 *    take the size it is given, not a way for the surface to discover it.
 *
 * ## Why this is a component at all
 *
 * Because the element's identity and the host's ownership of it have to be in the
 * same place. A ref created in a screen and passed down through four props is how a
 * canvas ends up appended to the wrong node the first time someone reorders a
 * layout.
 */
import type { CSSProperties, JSX, ReactNode } from 'react';

import type { CozyWorldTheme } from './cozyWorldTheme';

/**
 * How many touch targets tall a world surface is, in rows.
 *
 * Derived rather than chosen, and the derivation is a measurement. The surface used to
 * declare `touchTargetMin` - 44 CSS pixels - on the reasoning that a floor is enough
 * to keep a collapsed box out of the way and to leave room for the DOM controls. That
 * reasoning holds for the *floor* and not for the *height*: with nothing else setting
 * the height, the surface settled at its floor, and the world inherited a 42 CSS-pixel
 * viewport once its own borders were accounted for. A scene cannot draw in that. The
 * Phase 9 test world lays out one row of touch targets with a gap above and below, and
 * then its read-out line, and needs at least **216** CSS pixels for all of it; at 44
 * its read-out sat at `y = 64`, entirely outside the surface, so the one thing the
 * world drew in words was the one thing nobody could see.
 *
 * Five rows is `touchTargetMin * 5` = 220, the smallest round number above the 216 the
 * scene needs. Phase 11 replaces this surface with the Village viewport, and the height
 * that world wants is a layout decision that belongs with the world rather than here -
 * which is why this is a named constant with its measurement attached and not a literal
 * in a style object.
 */
export const WORLD_SURFACE_ROWS = 5;

export interface PixiCanvasProps {
  /** Where the renderer appends its canvas. */
  readonly surfaceRef: (element: HTMLDivElement | null) => void;
  readonly theme: CozyWorldTheme;
  /** Accessible name for the surface region. */
  readonly label: string;
  /** Describes what is on the surface, for a screen reader that cannot see it. */
  readonly description: string;
  readonly children?: ReactNode;
  /** Test hook: the number of mount/unmount cycles this surface has observed. */
  readonly surfaceId: string;
}

export function PixiCanvas({
  surfaceRef,
  theme,
  label,
  description,
  children,
  surfaceId,
}: PixiCanvasProps): JSX.Element {
  const surface: CSSProperties = {
    position: 'relative',
    width: '100%',
    // A floor high enough to be the height, because the host sizes the renderer from
    // this element's padding box and the canvas then fills exactly that box. The floor
    // and the content agree, so the surface settles and never resizes itself; a
    // taller page-driven height still wins, because this is a minimum.
    minHeight: px(theme.touchTargetMin * WORLD_SURFACE_ROWS),
    overflow: 'hidden',
    borderRadius: px(theme.radius.md),
    // A boundary, so the surface is identifiable as a region and not mistaken for
    // a blank part of the page. `borderControl` is the token classified `nonText`.
    border: `${px(theme.border.hairline)} solid ${cssHex(theme.color.borderControl)}`,
    background: cssHex(theme.color.surfaceSunken),
  };

  return (
    <div
      role="img"
      aria-label={label}
      aria-describedby={`${surfaceId}-description`}
      style={{ display: 'flex', flexDirection: 'column', gap: px(theme.space['2']) }}
    >
      <div ref={surfaceRef} data-pixi-surface={surfaceId} style={surface} />
      <span id={`${surfaceId}-description`} style={visuallyHidden}>
        {description}
      </span>
      {children}
    </div>
  );
}

const px = (value: number): string => `${value}px`;

const visuallyHidden: CSSProperties = {
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

function cssHex(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}
