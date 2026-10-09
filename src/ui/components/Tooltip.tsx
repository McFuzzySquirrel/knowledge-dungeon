import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { hasSeenTooltip, markTooltipSeen } from '@/ui/utils/tooltips';

interface TooltipProps {
  id: string;
  children: React.ReactNode;
  onDismiss?: () => void;
}

/**
 * A one-time, dismissible hint anchored to a HUD control.
 *
 * ## Two defects this shape fixes
 *
 * 1. **It used to intercept clicks.** The portal carried `pointer-events: auto`,
 *    so a visible tooltip sat on top of the world's DOM controls and swallowed
 *    the click. The card is `pointer-events: none` now and only the dismiss
 *    button opts back in, which is the same contract `Minimap` uses: a hint may
 *    be visible over the world, but it never blocks it.
 * 2. **It used to float over the world mirror.** It was positioned `fixed` at the
 *    trigger's right edge, so a HUD control in the 220px side rail produced a
 *    card starting at x = 228 - directly on top of the dungeon's action mirror.
 *    It is now placed *inside* the trigger's own HUD container when that
 *    container is on screen, so a side-rail tooltip stays in the side rail and a
 *    drawer tooltip stays in the drawer.
 *
 * ## And one case it deliberately drops
 *
 * A tooltip whose trigger is off screen is not shown at all. On a phone the
 * dungeon HUD lives in a closed, translated-off-screen drawer, and a hint for a
 * button nobody can see is not a hint - it is an overlay on the canvas. So the
 * layout effect hides the card unless the trigger actually intersects the
 * viewport.
 */
export function Tooltip({ id, children, onDismiss }: TooltipProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => hasSeenTooltip(id));
  const [visible, setVisible] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const tooltipElRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (dismissed) return;
    const timer = setTimeout(() => setVisible(true), 800);
    return () => clearTimeout(timer);
  }, [dismissed]);

  useLayoutEffect(() => {
    if (!visible) return;
    const place = (): void => {
      const el = tooltipElRef.current;
      const wrapper = wrapperRef.current;
      if (!el || !wrapper) return;
      const parent = wrapper.parentElement;
      // The trigger is the first button in the same relative wrapper, or the
      // wrapper's previous sibling in the older markup.
      const trigger = parent?.querySelector('button') ?? wrapper.previousElementSibling;
      const triggerRect = trigger?.getBoundingClientRect();

      // No trigger, or a trigger that is not on screen (a closed mobile drawer):
      // there is nothing to point at, so show nothing.
      if (
        !triggerRect ||
        triggerRect.width === 0 ||
        triggerRect.height === 0 ||
        triggerRect.bottom <= 0 ||
        triggerRect.top >= window.innerHeight ||
        triggerRect.right <= 0 ||
        triggerRect.left >= window.innerWidth
      ) {
        el.style.visibility = 'hidden';
        return;
      }

      const margin = 8;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const container = trigger?.closest(
        '.hud-rail, .hud-drawer-panel, .village-hud, .village-info-panel, .room-panel, .modal',
      );
      const containerRect = container?.getBoundingClientRect();
      const hasContainer =
        containerRect !== undefined &&
        containerRect.width > 0 &&
        containerRect.right > 0 &&
        containerRect.left < viewportWidth &&
        containerRect.bottom > 0 &&
        containerRect.top < viewportHeight;
      const box: DOMRect | null = hasContainer && containerRect ? containerRect : null;

      el.style.minWidth = '0';
      el.style.maxWidth = `${Math.max(
        160,
        Math.min(280, (box?.width ?? viewportWidth) - margin * 2),
      )}px`;
      el.style.visibility = 'visible';

      const width = el.offsetWidth || 220;
      const height = el.offsetHeight || 60;

      // Prefer below the trigger; flip above only when below would overflow.
      let top = triggerRect.bottom + margin;
      if (top + height > viewportHeight - margin) {
        top = Math.max(margin, triggerRect.top - margin - height);
      }

      const minLeft = box === null ? margin : box.left + margin;
      const maxLeft = box === null ? viewportWidth - margin - width : box.right - margin - width;
      const left = Math.max(minLeft, Math.min(triggerRect.left, Math.max(minLeft, maxLeft)));

      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.transform = 'none';
    };

    place();
    window.addEventListener('resize', place);
    window.addEventListener('orientationchange', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('orientationchange', place);
    };
  }, [visible]);

  if (dismissed || !visible) return null;

  function handleDismiss(): void {
    markTooltipSeen(id);
    setDismissed(true);
    onDismiss?.();
  }

  const tooltip = (
    <div
      ref={tooltipElRef}
      className="feature-tooltip"
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: -9999,
        top: -9999,
        visibility: 'hidden',
        zIndex: 9999,
        // A hint may be visible over the world; it must never swallow the click.
        // Only the dismiss button below opts back into pointer events.
        pointerEvents: 'none',
        background: '#1a2744',
        border: '1px solid rgba(99, 179, 237, 0.4)',
        borderRadius: 8,
        padding: '10px 14px',
        minWidth: 220,
        maxWidth: 280,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      <div style={{ marginBottom: 8 }}>{children}</div>
      <button
        type="button"
        className="ghost"
        style={{
          minHeight: 44,
          minWidth: 44,
          padding: '4px 12px',
          pointerEvents: 'auto',
          background: 'rgba(99, 179, 237, 0.2)',
          border: '1px solid rgba(99, 179, 237, 0.3)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
        onClick={handleDismiss}
      >
        Got it
      </button>
    </div>
  );

  return (
    <>
      <div ref={wrapperRef} style={{ display: 'none' }} />
      {createPortal(tooltip, document.body)}
    </>
  );
}
